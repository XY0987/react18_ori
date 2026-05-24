> 前言：`useState` 是最常用的 Hook，也是理解 Hooks 更新流程的最好入口。这篇专门拆 `useState`：mount 时如何创建 Hook，dispatch 时如何入队，update 时如何计算新状态。

配套源码仓库：`https://github.com/XY0987/react18_ori.git`

## 系列导航

- 上一篇：[08：Hooks 原理之 dispatcher 与 Hook 链表](./08-Hooks原理dispatcher与Hook链表.md)
- 下一篇：[10：useEffect 源码之 effect 链表与执行时机](./10-useEffect源码effect链表与执行时机.md)

## useState 的主线

先把主线列出来：

```text
mount 阶段：
useState(initialState)
  → mountState
  → 创建 Hook
  → 创建 updateQueue
  → 绑定 dispatch

触发更新：
setState(action)
  → requestUpdateLane
  → createUpdate
  → enqueueUpdate
  → scheduleUpdateOnFiber

update 阶段：
useState()
  → updateState
  → 复用旧 Hook
  → 合并 pendingQueue/baseQueue
  → processUpdateQueue
  → 返回新 state
```

`useState` 不直接修改状态。它的核心是：**把更新保存起来，等下一次 render 时统一计算**。

## mountState：第一次创建 Hook

组件第一次渲染时，`useState` 会走 mount dispatcher。

`mountState` 主要做四件事：

| 步骤 | 作用 |
|------|------|
| 创建 Hook | 挂到当前函数组件 Fiber 的 Hook 链表上 |
| 计算初始值 | 支持直接值，也支持函数懒初始化 |
| 创建 updateQueue | 后续 `setState` 产生的 update 都放这里 |
| 绑定 dispatch | `dispatch` 记住当前 Fiber 和 queue |

初始值支持两种写法：

```tsx
useState(0);
useState(() => expensiveInit());
```

如果传入函数，mount 时会执行这个函数，把返回值作为初始 state。

## Hook 链表如何挂载

函数组件的 Hook 链表保存在：

```text
currentlyRenderingFiber.memoizedState
```

第一次调用 Hook：

```text
Fiber.memoizedState → Hook1
```

第二次调用 Hook：

```text
Fiber.memoizedState → Hook1 → Hook2
```

React 不靠变量名识别 Hook，而是靠调用顺序。

所以这段代码是危险的：

```tsx
if (visible) {
  useState(0);
}
```

因为下一次 render 如果 `visible` 变了，Hook 顺序就错了。

## dispatch 记住了什么

mount 阶段会创建 dispatch：

```text
dispatch = dispatchSetState.bind(null, currentlyRenderingFiber, queue)
```

也就是说，`setState` 被调用时，React 能知道：

1. 这次更新属于哪个 Fiber；
2. update 应该放进哪个 Hook 的 updateQueue。

这就是为什么我们可以在事件回调里调用 `setState`，React 仍然能找到对应组件。

## dispatchSetState：setState 的本质

`setState(action)` 大致做这些事：

```text
requestUpdateLane
  → createUpdate(action, lane)
  → enqueueUpdate(updateQueue, update)
  → scheduleUpdateOnFiber(fiber, lane)
```

这里有两个重点：

1. `action` 可以是值，也可以是函数；
2. 每个 update 都有 lane。

lane 让 React 可以在并发场景下判断：本次 render 应该消费哪些 update，哪些 update 要暂时跳过。

## updateState：下一次 render 才计算状态

组件更新时，`useState` 会走 update dispatcher。

`updateState` 不会重新创建一个全新的状态系统，而是复用旧 Hook：

```text
currentHook：旧 Fiber 上的 Hook
newHook：workInProgress Fiber 上的新 Hook
```

然后读取 queue 中的 pending update，计算新 state。

## pendingQueue 与 baseQueue

`queue.shared.pending` 保存新产生的更新。

`baseQueue` 保存上一次因为优先级不足被跳过的更新。

update 阶段会把两者接起来：

```text
baseQueue + pendingQueue
  → processUpdateQueue
```

为什么要接起来？

因为新 update 和旧的跳过 update 都不能丢，而且它们之间有顺序关系。

如果更新顺序错了，最终 state 就可能错。

## processUpdateQueue：按 lane 计算状态

`processUpdateQueue` 遍历 update 链表：

```text
update.lane 不属于 renderLane
  → 跳过，克隆到 newBaseQueue

update.lane 属于 renderLane
  → 执行 action，计算 newState
```

这就解释了一个很重要的问题：

> React 并发更新中，被跳过的低优先级更新不会丢失。

它会被保存到 `baseQueue`，等后续合适的 lane 再继续执行。

## 传值更新和函数式更新

`action` 有两种形式：

```tsx
setCount(count + 1);
setCount((count) => count + 1);
```

传值更新表达的是“把 state 设置成这个值”。

函数式更新表达的是“基于之前的 state 算出新值”。

在批量更新和并发更新里，函数式更新通常更稳，尤其是连续多次依赖旧状态时。

## useState 完整流程图

```text
mountState
  │
  ├─ mountWorkInProgressHook
  ├─ createUpdateQueue
  └─ bind dispatch

setState
  │
  ├─ requestUpdateLane
  ├─ createUpdate
  ├─ enqueueUpdate
  └─ scheduleUpdateOnFiber

updateState
  │
  ├─ updateWorkInProgressHook
  ├─ merge pendingQueue/baseQueue
  ├─ processUpdateQueue
  └─ return [state, dispatch]
```

## 小结

1. `useState` 的状态保存在函数组件 Fiber 的 Hook 链表上。
2. `setState` 不直接改状态，而是创建 update 并调度更新。
3. updateQueue 使用环状链表保存更新。
4. update 阶段会合并 pendingQueue 和 baseQueue，再根据 renderLane 计算新 state。
5. 函数式更新更适合依赖旧状态的场景。
