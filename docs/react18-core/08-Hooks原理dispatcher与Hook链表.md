> 前言：Hooks 看起来像普通函数调用，但 React 能让每次调用都拿到对应状态，靠的是 dispatcher、Fiber.memoizedState 上的 Hook 链表，以及严格稳定的调用顺序。

配套源码仓库：`https://github.com/XY0987/react18_ori.git`

## 系列导航

- 上一篇：[07：Commit 阶段的 mutation、layout 与 passive](./07-Commit阶段mutation-layout-passive.md)
- 下一篇：[09：useState 源码之 dispatch 与更新队列](./09-useState源码dispatch与更新队列.md)

## useState 本身不保存状态

我们平时写：

```tsx
const [count, setCount] = useState(0);
```

很容易以为 `useState` 自己保存了 `count`。

实际上，React 对外暴露的 `useState` 更像一个转发器：

```text
useState
  → resolveDispatcher
  → dispatcher.useState
```

真正执行 mount 逻辑还是 update 逻辑，取决于当前 render 阶段设置的 dispatcher。

## dispatcher 是什么

dispatcher 可以理解为“当前 Hooks 实现表”。

在函数组件执行前，React 会根据当前是 mount 还是 update 设置不同 dispatcher：

| 阶段 | dispatcher |
|------|------------|
| mount | `HooksDispatcherOnMount` |
| update | `HooksDispatcherOnUpdate` |

简化实现里：

```text
renderWithHooks
  │
  ├─ current === null
  │    └─ currentDispatcher.current = HooksDispatcherOnMount
  │
  └─ current !== null
       └─ currentDispatcher.current = HooksDispatcherOnUpdate
```

组件函数执行结束后，会重置当前 Hook 上下文。

这也是为什么 Hook 不能在函数组件外调用：那时候没有合法 dispatcher。

## Hook 存在哪里

函数组件 Fiber 的 `memoizedState` 保存的是 Hook 链表头。

```text
FunctionComponentFiber.memoizedState
  │
  ▼
Hook1 → Hook2 → Hook3 → null
```

每个 Hook 节点大致包含：

| 字段 | 含义 |
|------|------|
| `memoizedState` | 当前 Hook 保存的值 |
| `updateQueue` | useState 的更新队列，或其他 Hook 的队列 |
| `next` | 下一个 Hook |
| `baseState` | 跳过低优先级更新后的基础 state |
| `baseQueue` | 被跳过的低优先级 update |

对于不同 Hook，`memoizedState` 的含义不同：

| Hook | `memoizedState` 保存什么 |
|------|---------------------------|
| `useState` | 当前 state |
| `useEffect` | effect 对象 |
| `useRef` | `{ current }` 对象 |
| `useTransition` | `startTransition` 函数 |

## mount 阶段：创建 Hook 链表

第一次渲染函数组件时，每调用一个 Hook，就创建一个 Hook 节点。

```text
useState
  → mountState
  → mountWorkInProgressHook
  → 创建 Hook
  → 挂到 currentlyRenderingFiber.memoizedState 链表上
```

例如组件：

```tsx
function App() {
  const [count] = useState(0);
  const ref = useRef(null);
  useEffect(() => {}, []);
  return <div />;
}
```

mount 后的 Hook 链表可以理解为：

```text
Fiber.memoizedState
  │
  ▼
useState Hook → useRef Hook → useEffect Hook
```

React 并没有给 Hook 起名字，也没有用变量名保存它们。它依赖的是调用顺序。

## update 阶段：按顺序复用 Hook

更新时，React 会同时走两条链：

```text
currentHook：指向旧 Fiber 上的 Hook
workInProgressHook：构建新 Fiber 上的 Hook
```

每调用一个 Hook，React 就从旧链表中取出对应位置的 Hook，复制出一个新 Hook。

```text
旧链表：Hook1 → Hook2 → Hook3
新链表：Hook1' → Hook2' → Hook3'
```

这就是为什么 Hook 不能写在条件语句里。

如果本次 render 少调用或多调用一个 Hook，后续位置就全部错位。

## useState 的更新流程

`useState` 的 dispatch 大致是：

```text
setState(action)
  → requestUpdateLane
  → createUpdate(action, lane)
  → enqueueUpdate(updateQueue, update)
  → scheduleUpdateOnFiber(fiber, lane)
```

也就是说，`setState` 不是直接改 Hook 的 `memoizedState`。

它只是把 update 放进 Hook 的 updateQueue，然后调度一次更新。

真正计算新 state 的地方是下一次 render 的 `updateState`。

## useEffect 为什么有另一条链表

Hook 本身已经是一条链表，为什么 `useEffect` 还要维护 effect 链表？

因为 commit 阶段需要快速找到所有 effect 来执行 destroy/create。

Hook 链表服务于 render 阶段，effect 链表服务于 commit 阶段。

```text
Hook 链表：按 Hook 调用顺序保存状态
Effect 链表：按 effect 顺序保存副作用
```

简化实现里，effect 也是环状链表：

```text
lastEffect.next → firstEffect
```

这样只保存 `lastEffect`，也能遍历整条 effect 链。

## useEffect 的依赖比较

update 阶段执行 `useEffect` 时，会比较依赖数组：

```text
deps 没变
  → pushEffect(Passive)
  → 不打 HookHasEffect

 deps 变了
  → pushEffect(Passive | HookHasEffect)
  → 标记当前 Fiber 有 PassiveEffect
```

只有带 `HookHasEffect` 的 effect，commit 后才会执行 destroy/create。

这就是依赖数组能控制 effect 是否重新执行的核心原因。

## useEffect 的执行时机：登记在 render，执行在 commit 后

这里最容易混淆的是：`useEffect` 这个 Hook 调用，和传给 `useEffect` 的回调函数，不是同一个时机执行。

```tsx
useEffect(() => {
  // create：这里不是 render 阶段执行
  return () => {
    // destroy：这里也不是 render 阶段执行
  };
}, [dep]);
```

函数组件重新执行时，确实会执行到 `useEffect(...)` 这一行，但此时 React 只是做登记：

```text
render 阶段：
  执行 FunctionComponent
    → 调用 useEffect(create, deps)
    → 比较 deps
    → pushEffect，把 create/destroy/deps 保存到 effect 环状链表
    → 如果 deps 变化，给 Fiber 打 PassiveEffect 标记
```

也就是说，render 阶段执行的是 `useEffect` 这个 Hook API，不是执行用户传入的 `create` 回调。

真正执行 `create/destroy` 发生在 commit 之后的 passive effect flush：

```text
commit 阶段：
  mutation：提交 DOM 更新
  layout：执行 ref / layout 类副作用
  调度 passive effect

passive 阶段：
  先执行上一轮 destroy
  再执行本轮 create
```

所以普通情况下，可以把 `useEffect` 的时机记成：

```text
setState
  → render：重新执行组件，登记本轮 effect
  → commit mutation：更新 DOM
  → commit layout：绑定 ref / layout effect
  → flush passive effects：执行 useEffect destroy/create
```

一句话：**本轮 `useEffect` 的 create/destroy，一般在本轮 DOM 更新提交之后执行。**

但 React 18 的并发调度里还有一个边界情况：上一轮 commit 后调度的 passive effect 可能还没来得及执行，下一轮任务就开始了。为了避免上一轮 effect 滞后到下一轮 render/commit 之后，`performConcurrentWorkOnRoot` 开头会先补刷一次 pending passive effects。

```text
commit A：DOM 已更新为 A
  → 调度 passive effects A
  → passive A 还没执行

更新 B 开始：
  performConcurrentWorkOnRoot
    → 先 flush passive effects A
    → 再 render B
    → commit B
```

因此更严谨的说法是：

> 某一轮 render 产生的 `useEffect`，一定是在这一轮对应的 DOM commit 之后执行；但如果下一轮更新开始前它还没执行，React 会在下一轮 render 前先补 flush 上一轮的 passive effect。

这并不说明 `useEffect` 回调属于 render 阶段。它仍然是 commit 之后的 passive effect，只是可能在下一轮 render 开始前被补执行。

还要注意：`useState` 的 updateQueue 和 `useEffect` 的 effect 链表不是一回事。

| 结构 | 存储内容 | 作用 |
|------|----------|------|
| Hook 的 `queue.shared.pending` | `setState` 产生的 update | 下一次 render 时计算新 state |
| FunctionComponent Fiber 的 `updateQueue.lastEffect` | `useEffect` 产生的 effect 环状链表 | commit 后执行 destroy/create |

所以准确理解应该是：`setState` 触发更新；更新导致函数组件重新执行；重新执行过程中 `useEffect` 登记本轮 effect；DOM 提交后再统一 flush passive effect。

## useTransition 的本质

简化实现中的 `useTransition` 可以帮助理解核心思想：

```text
startTransition(callback)
  → 设置 currentBatchConfig.transition
  → callback 内部产生的更新进入 TransitionLane
  → 恢复 transition 配置
```

所以 `useTransition` 并不是让代码异步执行，而是改变 callback 内部更新的优先级。

## Hooks 总图

```text
renderWithHooks
  │
  ├─ 设置 dispatcher
  │
  ├─ 执行 FunctionComponent
  │    ├─ useState → Hook 链表 + updateQueue
  │    ├─ useRef → Hook 链表
  │    ├─ useEffect → Hook 链表 + effect 链表
  │    └─ useTransition → TransitionLane 更新
  │
  └─ 重置 Hook 全局上下文
```

## 小结

1. `useState` 等外部 API 通过 dispatcher 转发到当前 render 阶段的 Hook 实现。
2. 函数组件 Fiber 的 `memoizedState` 保存 Hook 链表头。
3. React 依赖 Hook 调用顺序复用 Hook，因此 Hook 不能条件调用。
4. `setState` 创建 update 并调度更新，真正计算状态发生在下一次 render。
5. `useEffect` 额外维护 effect 环状链表，供 commit 后执行 passive effect。
6. `useEffect` 的登记发生在 render 阶段，`create/destroy` 的执行发生在 commit 后；如果上一轮 passive effect 没来得及执行，下一轮并发任务开始前会先补 flush。
