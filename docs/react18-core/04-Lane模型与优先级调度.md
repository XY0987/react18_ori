---
title: React 18 源码解析 04：Lane 模型与优先级调度
date: 2026-05-16
categories:
  - React源码
tags:
  - React18
  - Lane
  - Scheduler
---

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
