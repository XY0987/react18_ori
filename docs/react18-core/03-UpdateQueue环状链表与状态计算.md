> 前言：这篇讲 React 更新系统里一个非常核心但容易被忽略的结构：`UpdateQueue`。我会用简化实现解释它的核心思想，再把它放回 React 18 的更新流程里理解。

配套源码仓库：`https://github.com/XY0987/react18_ori.git`

## 系列导航

- 上一篇：[02：Fiber 数据结构与双缓冲树](./02-Fiber数据结构与双缓冲.md)
- 下一篇：[04：Lane 模型与优先级调度](./04-Lane模型与优先级调度.md)

## 为什么需要 UpdateQueue

在 React 里，更新不是调用 `setState` 后马上改状态。

更准确地说，`setState` 做的是：创建一个 update，把它放进队列，再调度一次 render。

```text
setState(action)
  → createUpdate(action, lane)
  → enqueueUpdate(queue, update)
  → scheduleUpdateOnFiber(fiber, lane)
```

这套设计解决了三个问题：

| 问题 | UpdateQueue 的作用 |
|------|--------------------|
| 多次更新如何合并 | 用链表保存同一批更新 |
| 不同优先级如何处理 | 每个 update 都带 `lane` |
| 被跳过的低优先级更新怎么办 | 放入 `baseQueue`，下次再算 |

## Update 长什么样

在简化实现里，一个 update 包含三个字段：

```ts
export interface Update<State> {
	action: Action<State>;
	lane: Lane;
	next: Update<any> | null;
}
```

| 字段 | 含义 |
|------|------|
| `action` | 更新内容。对于 `useState`，它是新值或更新函数；对于 HostRoot，它是 ReactElement |
| `lane` | 这次更新的优先级 |
| `next` | 指向下一个 update，用来组成链表 |

这里要注意：`action` 不一定是状态值。在首屏渲染里，`render(<App />)` 会把 `<App />` 作为 HostRoot update 的 `action`。

## 为什么用环状链表

简化实现中的 `enqueueUpdate` 使用环状链表：

```text
第一次插入 A：
A ──► A

再插入 B：
pending = B
B ──► A ──► B

再插入 C：
pending = C
C ──► A ──► B ──► C
```

队列只保存 `pending`，也就是最后插入的 update。

但因为它是环，`pending.next` 就能拿到第一个 update。

```text
pending：最后一个 update
pending.next：第一个 update
```

这个结构的好处是：追加新 update 很方便，不需要从头遍历到尾。

## processUpdateQueue 做了什么

`processUpdateQueue(baseState, pendingUpdate, renderLane)` 的目标是计算本次 render 的最新状态。

核心流程可以简化为：

```text
从 pending.next 开始遍历环状链表
  │
  ├─ update.lane 优先级不够
  │    └─ 克隆到 baseQueue，留到后续再处理
  │
  └─ update.lane 优先级足够
       └─ 根据 action 计算 newState
```

它最终返回：

| 返回值 | 含义 |
|--------|------|
| `memoizedState` | 本次 render 计算出的状态 |
| `baseState` | 下次处理 `baseQueue` 时的基础状态 |
| `baseQueue` | 本次因为优先级不够而跳过的 update 队列 |

## 为什么不能直接丢掉低优先级更新

这是理解并发更新的关键。

假设有三个更新：

```text
A：高优先级，count + 1
B：低优先级，count + 10
C：高优先级，count + 1
```

当前 render 只处理高优先级。

如果直接丢掉 B，那么最终状态就会错。React 的做法是：本次跳过 B，但把它保存到 `baseQueue`，等低优先级 render 时继续计算。

所以 `baseQueue` 的本质是：保存“这次没资格执行，但未来必须执行”的更新。

## setState 传值和传函数的区别

在 `processUpdateQueue` 里，`action` 有两种形式：

```ts
if (action instanceof Function) {
	newState = action(newState);  // 函数式更新基于前一个 update 的累积值
} else {
	newState = action;
}
```

这对应我们平时写的两种 `setState`：

```ts
setCount(count + 1);
setCount((count) => count + 1);
```

我的建议是：当新状态依赖旧状态时，优先使用函数式写法。

原因很简单：函数式更新表达的是“基于上一个状态计算”，更适合批量更新和并发更新场景。

## UpdateQueue 放在主流程里的位置

把它放回渲染链路中看：

```text
render(<App />) / setState(action)
  │
  ▼
createUpdate(action, lane)
  │
  ▼
enqueueUpdate(updateQueue, update)
  │
  ▼
scheduleUpdateOnFiber
  │
  ▼
beginWork
  │
  ▼
processUpdateQueue
  │
  ▼
得到新的 memoizedState
```

对于 HostRoot，新的 `memoizedState` 是 ReactElement。

对于 `useState`，新的 `memoizedState` 是组件状态。

## 小结

1. `setState` 的本质是创建 update，而不是立即修改状态。
2. `UpdateQueue` 用环状链表保存一批更新，`pending.next` 指向第一个 update。
3. 每个 update 都携带 `lane`，render 时只消费优先级足够的 update。
4. 被跳过的低优先级 update 会进入 `baseQueue`，不会丢失。
5. 当新状态依赖旧状态时，函数式 `setState` 更稳妥。
