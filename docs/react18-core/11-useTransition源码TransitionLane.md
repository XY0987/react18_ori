> 前言：`useTransition` 是 React 18 并发特性的重要入口。它的关键不是“让代码异步执行”，而是“把一部分更新标记成较低优先级”。

配套源码仓库：`https://github.com/XY0987/react18_ori.git`

## 系列导航

- 上一篇：[10：useEffect 源码之 effect 链表与执行时机](./10-useEffect源码effect链表与执行时机.md)
- 下一篇：[12：合成事件系统、事件委托与优先级](./12-合成事件系统事件委托与优先级.md)

## useTransition 解决什么问题

假设有一个输入框和一个大列表过滤：

```tsx
function App() {
  const [text, setText] = useState('');
  const [list, setList] = useState(bigList);
}
```

用户输入时，有两类更新：

| 更新 | 用户感受 | 优先级 |
|------|----------|--------|
| 输入框内容变化 | 必须立刻响应 | 高 |
| 大列表过滤结果 | 可以稍后显示 | 低 |

`useTransition` 的价值是：让不紧急的更新进入较低优先级，避免挡住紧急交互。

## useTransition 返回什么

API 形态是：

```tsx
const [isPending, startTransition] = useTransition();
```

| 返回值 | 含义 |
|--------|------|
| `isPending` | 是否存在过渡中的更新 |
| `startTransition` | 用来包裹低优先级更新的函数 |

简化实现里，`isPending` 本身也是一个 `useState(false)`。

## mountTransition 做了什么

mount 阶段：

```text
mountTransition
  → mountState(false)
  → 创建 startTransition
  → 额外创建一个 Hook 保存 start 函数
  → return [isPending, start]
```

这里有个细节：`useTransition` 内部消耗了不止一个 Hook 位置。

所以它和其他 Hook 一样，也必须稳定调用，不能写在条件分支里。

## startTransition 的核心

简化实现里的核心逻辑是：

```text
startTransition(callback)
  │
  ├─ setPending(true)
  │
  ├─ currentBatchConfig.transition = 1
  │
  ├─ callback()
  │    └─ callback 内触发的更新进入 TransitionLane
  │
  ├─ setPending(false)
  │
  └─ 恢复 transition 配置
```

关键是这句：

```text
currentBatchConfig.transition = 1
```

它会影响后续 `requestUpdateLane()` 的结果。

## requestUpdateLane 如何识别 transition

更新产生时，React 会请求一个 lane：

```text
requestUpdateLane
  │
  ├─ currentBatchConfig.transition !== null
  │    └─ TransitionLane
  │
  └─ 否则根据 Scheduler 当前优先级映射 lane
```

所以 `startTransition(callback)` 并不是改变 callback 的执行方式，而是改变 callback 内部更新的 lane。

这点很重要。

## transition 更新如何被调度

当更新进入 `TransitionLane` 后，会参与 root 的 `pendingLanes` 合并：

```text
root.pendingLanes = root.pendingLanes | TransitionLane
```

调度时，React 会优先处理更高优先级的 lane。

如果这时又来了一个同步更新：

```text
SyncLane + TransitionLane
```

React 会先处理 `SyncLane`，再处理 `TransitionLane`。

这就是 transition 不阻塞紧急更新的原因。

## useTransition 不是 setTimeout

一个常见误解是：`startTransition` 会把 callback 放到异步任务里。

更准确的理解是：

> `startTransition` 标记 callback 内部产生的更新为 transition 更新。

callback 本身仍然会被调用，只是其中的状态更新会被打上较低优先级。

## isPending 为什么也是状态

`isPending` 用来告诉 UI：现在有过渡更新正在进行。

常见用法：

```tsx
const [isPending, startTransition] = useTransition();

startTransition(() => {
  setSearchResult(filterList(keyword));
});

return isPending ? <Spinner /> : <List />;
```

在完整 React 实现中，`isPending` 与 transition 的完成状态有更复杂的关联。简化实现里通过 `setPending(true)` 和 `setPending(false)` 展示了核心概念。

## useTransition 总图

```text
useTransition
  │
  ├─ isPending state
  │
  └─ startTransition(callback)
        │
        ├─ 设置 transition 上下文
        ├─ 执行 callback
        ├─ callback 内 setState → TransitionLane
        └─ 恢复 transition 上下文
```

## 小结

1. `useTransition` 的核心是降低某些更新的优先级，而不是让代码异步执行。
2. `startTransition` 通过 `currentBatchConfig.transition` 影响 `requestUpdateLane`。
3. transition 内部产生的更新会进入 `TransitionLane`。
4. 当同步更新和 transition 更新同时存在时，React 会优先处理同步更新。
5. `isPending` 用来让 UI 感知过渡更新状态。
