> 前言：React 18 的并发能力离不开优先级。Lane 模型就是 React 用来描述“哪些更新更紧急、哪些更新可以稍后处理”的核心机制。

配套源码仓库：`https://github.com/XY0987/react18_ori.git`

## 系列导航

- 上一篇：[03：UpdateQueue 环状链表与状态计算](./03-UpdateQueue环状链表与状态计算.md)
- 下一篇：[05：render 阶段的 beginWork 与 completeWork](./05-render阶段beginWork与completeWork.md)

## Lane 解决什么问题

在 UI 更新里，不同更新的紧急程度是不一样的。

比如：

| 更新类型 | 用户感受 | 优先级倾向 |
|----------|----------|------------|
| 输入框输入 | 必须立刻响应 | 高 |
| 点击按钮 | 应该尽快响应 | 高 |
| 普通状态更新 | 可以正常调度 | 中 |
| 大列表过滤、页面切换动画 | 可以延后，不能卡输入 | 低 |

React 18 需要一种机制来描述这些差异。

Lane 的核心思想是：用二进制位表示不同优先级的更新。

## Lane 为什么适合用位运算

简化实现里定义了这些 lane：

```ts
export const SyncLane = 0b00001;
export const InputContinuousLane = 0b00010;
export const DefaultLane = 0b00100;
export const TransitionLane = 0b01000;
export const IdleLane = 0b10000;
```

每个 lane 占一个 bit。

这样带来几个好处：

| 操作 | 位运算 | 含义 |
|------|--------|------|
| 合并优先级 | `laneA | laneB` | root 上同时存在多个待处理更新 |
| 判断包含关系 | `(set & subset) === subset` | 某个 update 是否属于当前 render 范围 |
| 移除已完成优先级 | `pendingLanes &= ~lane` | commit 后清理已完成任务 |
| 取最高优先级 | `lanes & -lanes` | 找出最靠右的 1 |

这就是为什么 React 的优先级系统很适合用位图表达。

## pendingLanes：root 上还有哪些活没干

每次触发更新，React 都会把本次更新的 lane 合并到 root 上：

```text
root.pendingLanes = mergeLanes(root.pendingLanes, lane)
```

可以把 `pendingLanes` 理解为 root 的待办清单。

```text
pendingLanes = 0b01100
                │ │
                │ └─ DefaultLane 有任务
                └─── TransitionLane 有任务
```

调度时，React 会先取最高优先级的 lane：

```ts
export function getHighestPriorityLane(lanes: Lanes): Lane {
	return lanes & -lanes;
}
```

这个表达式会取出最右侧的 1，也就是当前最高优先级。

## requestUpdateLane：一次更新属于哪个优先级

更新产生时，需要先确定它属于哪个 lane。

简化实现里的逻辑是：

```text
如果当前处于 transition
  → TransitionLane
否则读取 Scheduler 当前优先级
  → 映射成 React lane
```

也就是说，`startTransition` 包裹的更新会被打到 `TransitionLane`，优先级低于同步输入类更新。

这也是 `useTransition` 的核心价值：不是让更新变快，而是让某些更新“不挡住更紧急的更新”。

## Lane 和 Scheduler 的关系

React 内部使用 Lane 描述更新优先级，但真正安排任务执行，还需要 Scheduler。

所以中间有一层映射：

```text
React Lane
  ↕
Scheduler Priority
```

简化实现里：

| React lane | Scheduler priority |
|------------|--------------------|
| `SyncLane` | `ImmediatePriority` |
| `InputContinuousLane` | `UserBlockingPriority` |
| `DefaultLane` | `NormalPriority` |
| 其他 | `IdlePriority` |

这层映射让 React 可以自己管理更新优先级，同时复用 Scheduler 的任务调度能力。

## 同步任务和并发任务怎么分流

在 `workLoop` 里，`ensureRootIsSchedule(root)` 会根据最高优先级决定如何调度。

```text
SyncLane
  → scheduleSyncCallback
  → scheduleMicroTask(flushSyncCallbacks)

其他 lane
  → lanesToSchedulerPriority
  → scheduleCallback(performConcurrentWorkOnRoot)
```

我的理解是：

- 同步更新要尽快完成，所以放进微任务队列；
- 非同步更新可以交给 Scheduler，让它在合适的时间执行，并支持时间切片。

## Lane 如何影响状态计算

Lane 不只影响“什么时候执行”，也影响“本次 render 消费哪些 update”。

在 `processUpdateQueue` 里，会判断：

```ts
if (!isSubsetOfLanes(renderLane, updateLane)) {
	// 优先级不够，跳过
}
```

这意味着：当前 render 只处理属于 `renderLane` 的 update。优先级不匹配的 update 会被保存起来，等后续再处理。

所以 Lane 同时参与了两件事：

1. 调度阶段：决定哪个任务先执行；
2. render 阶段：决定哪些 update 能被消费。

## 多个优先级会分几轮 render

如果同一个 root 上同时存在多个优先级的更新，`pendingLanes` 会同时保存它们：

```text
pendingLanes = SyncLane | TransitionLane
             = 0b00001  | 0b01000
             = 0b01001
```

调度时不会一次性把所有 lane 都消费掉，而是先取最高优先级：

```text
第一轮 render：getHighestPriorityLane(pendingLanes) → SyncLane
```

这一轮 render 的 `renderLane` 是 `SyncLane`。因此在 `processUpdateQueue` 里：

```text
SyncLane update       → 优先级匹配，被消费
TransitionLane update → 优先级不够，被跳过，保存到 baseQueue
```

第一轮 commit 后，React 会把已经完成的 lane 从 `pendingLanes` 中移除：

```text
pendingLanes &= ~SyncLane
```

此时 root 上还剩：

```text
pendingLanes = TransitionLane
```

于是继续调度第二轮：

```text
第二轮 render：getHighestPriorityLane(pendingLanes) → TransitionLane
```

这一次 `renderLane` 变成 `TransitionLane`，之前被跳过并保存在 `baseQueue` 里的低优先级 update 才会被重新计算。

所以可以这样理解：

```text
多个不同优先级 update
  → 先合并到 root.pendingLanes
  → 每轮取当前最高优先级 lane
  → 本轮只消费匹配 renderLane 的 update
  → 不匹配的 update 暂存起来
  → commit 后移除已完成 lane
  → 如果还有 pendingLanes，继续下一轮 render
```

## 每轮 render 都会从根节点开始吗

在当前这个简化实现里，基本可以认为：**每一轮不同 lane 的 render 都会从 root 开始，重新走一遍 render 流程**。

更新虽然可能是某个组件触发的，但调度入口会先向上找到 `FiberRootNode`，再从 root 创建新的 `workInProgress`：

```text
setState
  → scheduleUpdateOnFiber
  → 从当前 Fiber 向上找到 FiberRootNode
  → root.pendingLanes 合并本次 lane
  → renderRoot(root, lane)
  → prepareFreshStack(root, lane)
  → 从 root.current 创建 workInProgress
```

然后 work loop 会从根 Fiber 开始执行：

```text
HostRoot beginWork
  → App beginWork
    → 子节点 beginWork
      → ...
  → completeWork 归阶段
  → commitRoot
```

因此对于两个不同优先级的更新，可以理解成：

```text
第一轮：SyncLane
  从 root 开始
  走 beginWork / reconcileChildren / diff
  跳过 TransitionLane update
  commit SyncLane 结果

第二轮：TransitionLane
  再从 root 开始
  再走 beginWork / reconcileChildren / diff
  消费之前跳过的 TransitionLane update
  commit TransitionLane 结果
```

也就是说，**当前实现偏“朴素”**：不同优先级分不同 render pass，每个 render pass 都会从根节点重新推进一遍。

## React 官方也是这样吗

React 官方的大方向也是 root 驱动：

```text
某个 Fiber 触发 update
  → lane 冒泡到 root
  → root 根据 pendingLanes 选择本轮 render 的优先级
  → 从 root 开始构建 workInProgress 树
```

但官方实现不会像这个简化版一样每次都笨重地完整遍历所有子树。官方 Fiber 上还会维护更细的优先级信息，例如：

| 字段 | 作用 |
|------|------|
| `lanes` | 当前 Fiber 自己是否有某些优先级的更新 |
| `childLanes` | 当前 Fiber 的子树里是否有某些优先级的更新 |

这样在 `beginWork` 阶段，如果发现当前 Fiber 和它的子树都没有本轮 `renderLane` 相关的更新，并且 props、state、context 等也没有变化，就可以直接 bailout：

```text
当前节点无变化
子树也没有当前 renderLane 的任务
  → 跳过这棵子树
  → 不重新执行函数组件
  → 不继续对子节点 diff
```

所以更准确的对比是：

| 实现 | 特点 |
|------|------|
| 当前简化实现 | 每轮 lane 基本从 root 走完整流程，比较容易理解，但性能较笨重 |
| React 官方实现 | 也是从 root 开始，但通过 `lanes` / `childLanes` / bailout 跳过无关子树 |

一句话总结：

> 不同优先级通常会分不同轮 render；每轮理论入口都是 root。当前实现基本完整走一遍，React 官方也是这个模型，但会用 bailout 避免重复遍历和 diff 无关子树。

## 一个例子：同步更新打断 transition

假设有一个低优先级列表过滤更新正在执行：

```text
TransitionLane：过滤 10000 条数据
```

这时用户输入一个字符：

```text
SyncLane：更新输入框内容
```

React 会优先处理 `SyncLane`，让输入框响应保持流畅。低优先级任务不会消失，而是之后继续。

这就是并发更新想解决的问题：让重要的交互先响应，把不紧急的渲染延后。

## 小结

1. Lane 是 React 18 描述更新优先级的核心模型。
2. 每个 lane 是一个二进制位，多个 lane 可以合并成 `Lanes`。
3. `pendingLanes` 是 root 上待处理更新的优先级集合。
4. `requestUpdateLane` 决定一次更新属于哪个 lane。
5. Lane 既影响任务调度，也影响 render 阶段 updateQueue 的消费。
6. 多个不同优先级更新会分多轮 render：高优先级先消费，低优先级跳过并保留。
7. 当前简化实现每轮基本从 root 完整走一遍；React 官方也从 root 开始，但会用 bailout 跳过无关子树。
