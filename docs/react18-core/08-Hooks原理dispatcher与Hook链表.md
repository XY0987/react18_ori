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
