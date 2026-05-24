> 前言：这篇先不钻 `diff`、Hooks、Lane 的细节，只解决一个问题：调用 `ReactDOM.createRoot(root).render(<App />)` 后，React 18 内部的主流程是什么。文中的代码片段来自我的简化实现，用来辅助理解 React 官方源码的核心设计。

配套源码仓库：`https://github.com/XY0987/react18_ori.git`

## 系列导航

- 上一篇：[00：系列总览](./00-系列总览.md)
- 下一篇：[02：Fiber 数据结构与双缓冲树](./02-Fiber数据结构与双缓冲.md)

## 一句话结论

`render(<App />)` 并不会直接把 `<App />` 变成 DOM。

它真正做的是：把 `<App />` 包装成一次 HostRoot 更新，放进 `updateQueue`，再交给 `workLoop` 调度，最后经历 render 阶段和 commit 阶段才落到 DOM。

```text
createRoot(container)
  → createContainer(container)
  → render(element)
  → updateContainer(element, root)
  → createUpdate(element, lane)
  → enqueueUpdate(updateQueue, update)
  → scheduleUpdateOnFiber(hostRootFiber, lane)
  → renderRoot
  → commitRoot
```

## 第一步：DOM renderer 只负责开门

入口在 `packages/react-dom/src/root.ts`。

`createRoot(container)` 先调用 `createContainer(container)` 创建根节点，然后返回一个带 `render` 方法的对象。

这里要注意：`react-dom` 是 renderer 层，它知道 DOM 容器是什么，也知道如何初始化事件，但它不负责 Fiber 调度和 diff。真正的核心逻辑会交给 `react-reconciler`。

```ts
export function createRoot(container: Container) {
	const root = createContainer(container);
	return {
		render(element: ReactElementType) {
			initEvent(container, 'click');
			return updateContainer(element, root);
		}
	};
}
```

我的理解是：`react-dom` 在这里像一个适配器，把浏览器 DOM 环境接到通用 reconciler 上。

## 第二步：创建 FiberRoot 和 HostRoot Fiber

`createContainer` 在 `packages/react-reconciler/src/fiberReconciler.ts`。

它做了三件事：

| 步骤 | 代码 | 作用 |
|------|------|------|
| 1 | `new FiberNode(HostRoot, {}, null)` | 创建整棵 Fiber 树的根工作单元 |
| 2 | `new FiberRootNode(container, hostRootFiber)` | 创建根对象，保存容器、current 树、调度信息 |
| 3 | `hostRootFiber.updateQueue = createUpdateQueue()` | 给 HostRoot 准备更新队列 |

这里容易混淆的是 `FiberRootNode` 和 `HostRoot Fiber`。

| 对象 | 可以理解为 | 保存什么 |
|------|------------|----------|
| `FiberRootNode` | 应用根对象 | DOM 容器、`current`、`pendingLanes`、调度回调 |
| `HostRoot Fiber` | Fiber 树的根节点 | `updateQueue`、`stateNode`、子 Fiber |

两者通过引用互相连接：

```text
FiberRootNode.current ───────► HostRoot Fiber
FiberRootNode ◄────────────── HostRoot Fiber.stateNode
```

## 第三步：render 不是直接渲染，而是创建更新

`updateContainer(element, root)` 是 `render(<App />)` 后的关键入口。

它会在 `ImmediatePriority` 下执行这段逻辑：

```ts
const hostRootFiber = root.current;
const lane = requestUpdateLane();
const update = createUpdate<ReactElementType | null>(element, lane);
enqueueUpdate(hostRootFiber.updateQueue, update);
scheduleUpdateOnFiber(hostRootFiber, lane);
```

这里有一个关键转变：

```text
ReactElement
  ↓
Update(action = ReactElement, lane = SyncLane)
  ↓
HostRoot.updateQueue
```

也就是说，`<App />` 会作为 `action` 存进 update。等 render 阶段处理 HostRoot 时，再从 updateQueue 中取出来，作为下一层 children 继续构建 Fiber。

## 第四步：进入调度入口 scheduleUpdateOnFiber

`scheduleUpdateOnFiber` 在 `packages/react-reconciler/src/workLoop.ts`。

它不直接 render，而是先做调度准备：

1. 从触发更新的 Fiber 向上找到 `FiberRootNode`；
2. 把本次 `lane` 合并到 `root.pendingLanes`；
3. 调用 `ensureRootIsSchedule(root)` 安排任务。

```text
scheduleUpdateOnFiber
  → markUpdateFromFiberToRoot
  → markRootUpdated
  → ensureRootIsSchedule
```

这里的设计很重要：React 不会来一个更新就无脑立刻执行，而是先把更新挂到 root 上，再根据优先级决定怎么调度。

## 第五步：同步更新走微任务，并发更新走 Scheduler

在当前首屏渲染场景下，`updateContainer` 使用 `unstable_ImmediatePriority` 包裹，所以 `requestUpdateLane()` 会得到 `SyncLane`。

`ensureRootIsSchedule` 会进入同步分支：

```text
SyncLane
  → scheduleSyncCallback(performSyncWorkOnRoot)
  → scheduleMicroTask(flushSyncCallbacks)
```

如果不是 `SyncLane`，则会走 Scheduler：

```text
Non-SyncLane
  → lanesToSchedulerPriority
  → scheduleCallback(performConcurrentWorkOnRoot)
```

这就是理解 React 同步更新和并发更新分流的关键分界点。

## 第六步：render 阶段只构建内存中的 Fiber 树

同步入口是 `performSyncWorkOnRoot(root)`，它会调用：

```text
renderRoot(root, nextLane, false)
```

`renderRoot` 会准备一棵 `workInProgress` 树，然后执行工作循环：

```text
workLoopSync
  → performUnitOfWork
  → beginWork
  → completeWork
```

`beginWork` 是“递”阶段，负责根据当前 Fiber 算出子 Fiber。

`completeWork` 是“归”阶段，负责创建 DOM 实例、收集副作用标记、向上冒泡 `subtreeFlags`。

这一阶段有一个非常重要的边界：render 阶段不直接改 DOM。

## 第七步：commit 阶段才真正修改 DOM

当 render 阶段完成后：

```ts
const finishedWork = root.current.alternate;
root.finishedWork = finishedWork;
root.finishedLane = nextLane;
commitRoot(root);
```

`commitRoot` 会根据 flags 判断是否需要执行 DOM 操作：

```text
commitRoot
  → commitMutationEffects
  → root.current = finishedWork
  → commitLayoutEffects
  → schedule passive effects
```

这里有两个关键点：

1. `commitMutationEffects` 会执行插入、删除、更新等宿主操作；
2. `root.current = finishedWork` 完成双缓冲树切换。

所以一次首屏渲染真正落地 DOM，是在 commit 阶段完成的。

## 全局流程总览

在进入详细流程图之前，先用一张表把首屏挂载的 6 个阶段串起来，帮助建立整体心智模型：

| 阶段 | 做了什么 | 关键代码 |
|:----:|---------|---------|
| ① 事件初始化 | 在容器上通过事件委托注册 click 监听，整棵应用共享一个入口 | `initEvent(container, 'click')` |
| ② 创建更新入队 | 把 `<App />` 包装成 `Update { action, lane }` 对象，加入 HostRoot 的环状链表 | `createUpdate` → `enqueueUpdate` |
| ③ 调度 | SyncLane 走微任务调度，调度的是渲染入口函数 `performSyncWorkOnRoot` | `scheduleSyncCallback` → `scheduleMicroTask` |
| ④ Render | DFS「递 + 归」遍历：`beginWork` 创建子 Fiber + diff，`completeWork` 创建离屏 DOM + 冒泡 flags | `workLoopSync` → `performUnitOfWork` |
| ⑤ Hook 处理 | FunctionComponent 在 `beginWork` 中通过 `renderWithHooks` 执行，mount 时使用 `HooksDispatcherOnMount` | `renderWithHooks` |
| ⑥ Commit | mutation 操作 DOM → 双缓冲切换 `root.current = finishedWork` → layout → passive effects | `commitRoot` |

> 以上 6 步就是 `createRoot(container).render(<App />)` 的完整生命周期。下面的流程图展示具体的函数调用链。

## 完整流程图

```text
用户代码
  │
  ▼
ReactDOM.createRoot(container).render(<App />)
  │
  ▼
react-dom/root.ts
createRoot → render
  │
  ▼
react-reconciler/fiberReconciler.ts
createContainer → updateContainer
  │
  ▼
updateQueue.ts
createUpdate → enqueueUpdate
  │
  ▼
workLoop.ts
scheduleUpdateOnFiber → ensureRootIsSchedule
  │
  ▼
performSyncWorkOnRoot / performConcurrentWorkOnRoot
  │
  ▼
renderRoot
  │
  ├─ beginWork：递，创建/复用子 Fiber
  │
  └─ completeWork：归，创建 DOM、冒泡 flags
  │
  ▼
commitRoot
  │
  ├─ mutation：操作 DOM
  ├─ current 切换
  └─ layout/passive effects
```

## 更新阶段（Update）流程

理解了首屏挂载后，再看更新流程会非常轻松——因为**骨架完全一致**，只是各层在判断到"已有旧树"时，走不同的优化/处理分支。

### 更新是如何触发的

以 `useState` 的 `setState` 为例，用户调用 `setState(newValue)` 后内部执行的是 `dispatchSetState`：

```ts
// fiberHooks.ts 中 dispatch 绑定的逻辑
const update = createUpdate(action, lane);
enqueueUpdate(hook.updateQueue, update);
scheduleUpdateOnFiber(fiber, lane);
```

注意：和首屏挂载中的 `updateContainer` 走的是**同一条路径**——创建 Update 对象 → 入队 → `scheduleUpdateOnFiber`。唯一的区别是：

| 对比项 | 首屏挂载 | setState 触发更新 |
|:------:|---------|---------|
| Update 入队位置 | HostRoot Fiber 的 `updateQueue` | 对应 Hook 的 `updateQueue` |
| action 内容 | `<App />` ReactElement | 新的 state 值或计算函数 |
| 触发 Fiber | HostRoot Fiber | 调用 setState 的那个 FunctionComponent Fiber |
| 优先级来源 | `unstable_ImmediatePriority` → SyncLane | 取决于触发上下文（事件回调 → SyncLane，Transition → TransitionLane） |

### 更新的调度与渲染

从 `scheduleUpdateOnFiber` 开始，更新流程和挂载完全一致：

```text
scheduleUpdateOnFiber(fiber, lane)
  → markUpdateFromFiberToRoot(fiber)    // 从触发的 Fiber 向上找到 FiberRootNode
  → markRootUpdated(root, lane)         // root.pendingLanes |= lane
  → ensureRootIsSchedule(root)          // 根据优先级安排调度
```

调度分流也相同：

```text
SyncLane → scheduleSyncCallback(performSyncWorkOnRoot) → 微任务执行
其他 Lane → scheduleCallback(performConcurrentWorkOnRoot) → Scheduler 宏任务（可中断）
```

### 更新的 render 阶段

`renderRoot` 调用 `prepareFreshStack`，这里出现了**第一个关键区别**：

```ts
// fiber.ts — createWorkInProgress
let wip = current.alternate;
if (wip === null) {
    // mount：没有 alternate，新建 FiberNode
    wip = new FiberNode(current.tag, pendingProps, current.key);
    wip.stateNode = current.stateNode;
    wip.alternate = current;
    current.alternate = wip;
} else {
    // update：有 alternate，复用并重置
    wip.pendingProps = pendingProps;
    wip.flags = NoFlags;
    wip.subtreeFlags = NoFlags;
    wip.deletions = null;
}
```

**update 时复用已有的 alternate FiberNode**，只覆盖 props 并清空 flags，不需要重新分配内存。

### 更新的 beginWork 阶段

`beginWork` 中处理每个 Fiber 时，通过 `reconcileChildren` 判断走 mount 还是 update 分支：

```ts
function reconcileChildren(wip: FiberNode, children?: ReactElementType) {
    const current = wip.alternate;
    if (current !== null) {
        // update：走完整 diff，追踪副作用
        wip.child = reconcileChildFibers(wip, current.child, children);
    } else {
        // mount：直接创建，不追踪副作用
        wip.child = mountChildFibers(wip, null, children);
    }
}
```

update 时的 `reconcileChildFibers`（`shouldTrackEffects = true`）会：

1. **单节点 diff**：遍历旧 children 链表，按 key → type 匹配尝试复用，复用成功调用 `useFiber`，失败则标记删除旧节点并新建
2. **多节点 diff**：将旧 children 存入 Map，遍历新 children 逐个查找复用，通过 `lastPlacedIndex` 判断是否需要移动
3. **副作用标记**：新增节点打 `Placement`，需删除的打 `ChildDeletion`

### 更新的 Hook 处理

FunctionComponent 在 update 时使用 `HooksDispatcherOnUpdate`：

| Hook | mount 行为 | update 行为 |
|------|-----------|------------|
| `useState` | 创建 Hook 节点，`memoizedState = initialValue`，绑定 dispatch | 从 `hook.updateQueue` 中消费 pending updates，计算出新 state |
| `useEffect` | 创建 effect，**一定标记 `HookHasEffect`**（首次必执行） | 比对 deps 数组，变化才标记 `HookHasEffect`，不变则跳过 |
| `useRef` | 创建 `{ current: initialValue }` 对象 | 直接返回已有的 ref 对象 |

### 更新的 completeWork 阶段

```ts
// completeWork.ts
if (current !== null && wip.stateNode) {
    // update：DOM 已存在，只标记属性变更
    markUpdate(wip);  // wip.flags |= Update
} else {
    // mount：创建新 DOM 实例
    const instance = createInstance(wip.type, newProps);
    appendAllChildren(instance, wip);
    wip.stateNode = instance;
}
```

update 时 DOM 节点已经存在，不需要重新创建，只需要标记一个 `Update` flag，等 commit 阶段去更新属性。

### 更新的 commit 阶段

commit 阶段本身**不区分 mount 和 update**，它只看 flags：

- `Placement` → 插入/移动 DOM 节点
- `Update` → 更新 DOM 属性
- `ChildDeletion` → 删除 DOM 节点、清理 ref 和 effect
- `Ref` → 解绑旧 ref、绑定新 ref
- `Passive` → 调度 useEffect 异步执行

首屏挂载时 flags 主要是 `Placement`（整棵树插入）；更新时则可能是 `Update`、`Placement`（新增节点）、`ChildDeletion`（删除节点）的混合。

---

## 挂载 vs 更新：全面对比

### 流程骨架对比

```text
                 ┌─── Mount ───┐        ┌─── Update ───┐
                 │             │        │              │
触发入口         │ render()    │        │ setState()   │
                 │             │        │              │
                 └──────┬──────┘        └──────┬───────┘
                        │                      │
                        ▼                      ▼
              ┌─────────────────────────────────────────┐
              │  createUpdate → enqueueUpdate            │
              │  → scheduleUpdateOnFiber                 │
              │  → ensureRootIsSchedule                  │
              │  → renderRoot (beginWork / completeWork) │
              │  → commitRoot                           │
              └─────────────────────────────────────────┘
                          ▲  完全一致  ▲
```

### 各层差异对比

| 层面 | Mount（首次挂载） | Update（更新） |
|:----:|---------|---------|
| **Fiber 创建** | `alternate === null`，`createWorkInProgress` 新建 FiberNode | `alternate !== null`，复用已有 FiberNode，清空 flags |
| **副作用追踪** | `shouldTrackEffects = false`，不逐个标记 | `shouldTrackEffects = true`，打 Placement/Deletion |
| **Diff 算法** | `currentFiber = null`，没有旧节点可对比，直接全量创建 | 有旧 children，走 key→type 匹配复用、Map diff、移动判断 |
| **Hook dispatcher** | `HooksDispatcherOnMount`：创建 Hook 链表 | `HooksDispatcherOnUpdate`：消费 updateQueue、比对 deps |
| **completeWork** | `createInstance` 创建 DOM → `appendAllChildren` 构建离屏子树 | DOM 已存在，只标记 `Update` flag |
| **commit 阶段 flags** | 主要是一个 `Placement`（整棵树一次性插入） | `Update` + `Placement`（新增）+ `ChildDeletion`（删除）混合 |

### 本质理解

> **update 才是 reconcile 模型的"完整形态"，mount 反而是利用了「一定没有旧树」这个前提做的优化简化。**

mount 时的各种"简化"实质上是优化手段：

| 优化 | 原因 |
|:----:|------|
| 不追踪副作用 | 整棵树都是新建的，不需要逐个标记 Placement，只在根节点 child 打一个即可，commit 时一次性插入 |
| 跳过 diff | 没有旧 children 可比，直接 `createFiberFromElement` 更快 |
| completeWork 直接建 DOM | 不需要比对属性变更，直接 `createInstance` |
| Hook 走 mount 路径 | 没有旧 state/effect 要对比，直接初始化 |

React 的设计哲学是：用统一的 reconcile 模型处理所有场景，只在明确可以跳过的地方做条件优化。

---

## 小结

1. `createRoot().render()` 的本质是创建根节点和派发一次 HostRoot 更新。
2. `updateContainer` 会把 ReactElement 包装成 `Update`，并放进 HostRoot 的 `updateQueue`。
3. `scheduleUpdateOnFiber` 是所有更新进入调度系统的统一入口——无论是首屏挂载还是后续 setState。
4. render 阶段只构建内存中的 `workInProgress` 树，commit 阶段才修改 DOM。
5. mount 和 update 走的是同一条主流程，区别在于各层对 `alternate === null` 的判断：mount 时走优化快路径（跳过 diff、不追踪副作用、直接建 DOM），update 时走完整路径（复用 Fiber、diff 旧 children、标记副作用）。
6. 理解这条链路后，再看 Fiber、Lane、Hooks、diff，都会更容易定位它们在主流程中的位置。
