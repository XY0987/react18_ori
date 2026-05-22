---
title: React 18 源码解析 05：render 阶段的 beginWork 与 completeWork
date: 2026-05-16
categories:
  - React源码
tags:
  - React18
  - Fiber
  - Render阶段
---

> 前言：前面几篇分别讲了主流程、Fiber、UpdateQueue 和 Lane。这篇开始进入 render 阶段，重点看 React 如何通过 `beginWork` 和 `completeWork` 构建一棵新的 Fiber 树。

配套源码仓库：`https://github.com/XY0987/react18_ori.git`

## 系列导航

- 上一篇：[04：Lane 模型与优先级调度](./04-Lane模型与优先级调度.md)
- 下一篇：[06：Diff 算法中的 key、复用、插入与删除](./06-Diff算法key复用插入删除.md)

## render 阶段做什么

render 阶段做的不是修改 DOM，而是在内存中计算下一棵 Fiber 树。

可以先记住一句话：

> render 阶段负责“算出变化”，commit 阶段负责“应用变化”。

在 work loop 里，一个 Fiber 工作单元大致这样执行：

```text
performUnitOfWork(fiber)
  │
  ├─ beginWork(fiber)
  │    └─ 计算子 Fiber
  │
  └─ 如果没有子 Fiber
       └─ completeUnitOfWork(fiber)
             └─ completeWork(fiber)
```

`beginWork` 是“递”阶段，沿着 Fiber 树向下走。

`completeWork` 是“归”阶段，从叶子节点向上收尾。

## beginWork：根据 Fiber 类型计算 children

`beginWork` 的核心结构是一个 `switch`：

```text
HostRoot
  → updateHostRoot

FunctionComponent
  → updateFunctionComponent

HostComponent
  → updateHostComponent

Fragment / ContextProvider
  → 取 children 后 reconcile
```

不同 Fiber 类型的处理方式不同，但最后都会落到同一个动作：

```text
拿到 nextChildren
  → reconcileChildren(wip, nextChildren)
  → 返回 wip.child
```

也就是说，`beginWork` 的最终目标是确定“下一个要处理的子 Fiber 是谁”。

## HostRoot：消费 updateQueue 得到 ReactElement

首屏渲染时，`render(<App />)` 会把 `<App />` 包装成 HostRoot 的 update。

到了 `beginWork` 的 HostRoot 分支，会执行：

```text
updateHostRoot
  → processUpdateQueue
  → 得到 memoizedState
  → reconcileChildren
```

这里的 `memoizedState` 对 HostRoot 来说就是要渲染的 ReactElement。

所以主流程可以串起来：

```text
render(<App />)
  → createUpdate(action = <App />)
  → HostRoot.updateQueue
  → updateHostRoot
  → processUpdateQueue
  → nextChildren = <App />
```

## FunctionComponent：执行组件函数并处理 Hooks

函数组件分支会调用 `renderWithHooks`：

```text
updateFunctionComponent
  → renderWithHooks
  → Component(props)
  → reconcileChildren
```

这里有两个关键点：

1. 函数组件的 children 来自执行组件函数的返回值；
2. 执行函数组件之前，React 会设置当前 Hooks dispatcher。

这也是为什么 Hooks 只能在函数组件渲染期间调用。

在 renderWithHooks 期间：

```text
currentDispatcher.current = HooksDispatcherOnMount 或 HooksDispatcherOnUpdate
Component(props)
currentDispatcher.current 被重置
```

所以 `useState`、`useEffect` 这些 API 本身不存状态，它们只是转发到当前 dispatcher。

## HostComponent：处理 DOM 节点的 children

对于原生 DOM 节点，比如：

```tsx
<div>
  <span>hello</span>
</div>
```

`HostComponent` 的 `pendingProps.children` 就是它的子节点。

所以 `updateHostComponent` 做的事情很直接：

```text
nextChildren = wip.pendingProps.children
markRef
reconcileChildren(wip, nextChildren)
```

如果有 `ref`，还会打上 `Ref` 标记，等 commit 阶段处理。

## reconcileChildren：mount 和 update 的分界

`reconcileChildren` 会看当前 Fiber 有没有 `alternate`：

| 情况 | 说明 | 使用的协调器 |
|------|------|--------------|
| `alternate === null` | mount 阶段 | 不追踪副作用 |
| `alternate !== null` | update 阶段 | 追踪插入、删除、移动 |

为什么 mount 阶段不需要给每个节点都打 `Placement`？

因为首屏渲染时，整棵 DOM 树会在离屏环境中构建好，最后一次性挂到容器上。给每个节点都打插入标记意义不大。

而 update 阶段不同，React 需要知道哪些节点新增、哪些节点移动、哪些节点删除，commit 阶段才能做最小化 DOM 操作。

## completeWork：从叶子节点往上收尾

当一个 Fiber 没有子节点，或者子节点都处理完后，就进入 `completeWork`。

`completeWork` 做三类事情：

| 类型 | mount 时 | update 时 |
|------|----------|-----------|
| `HostComponent` | 创建 DOM，并 append 子 DOM | 更新 props，处理 ref |
| `HostText` | 创建文本节点 | 文本变化则打 `Update` 标记 |
| 其他 Fiber | 不创建 DOM | 冒泡 flags |

注意：函数组件本身没有 DOM，Fragment 本身也没有 DOM。真正创建 DOM 的是 `HostComponent` 和 `HostText`。

## 离屏 DOM 树如何构建

mount 一个 DOM 节点时，`completeWork` 会先创建当前节点的 DOM：

```text
createInstance(type, props)
```

然后调用 `appendAllChildren(instance, wip)`，把子树里已经创建好的 DOM 节点插入当前 DOM。

因为 completeWork 是从叶子向上执行，所以当父 DOM 执行 completeWork 时，子 DOM 通常已经创建好了。

这就是为什么 render 阶段可以在内存中构建出一棵离屏 DOM 树，但还不挂到页面上。

## flags 如何向上冒泡

render 阶段会给有变化的 Fiber 打 flags，比如：

```text
Placement
Update
ChildDeletion
Ref
PassiveEffect
```

但是 commit 阶段不能只看根节点自身的 flags，还要知道子树里有没有副作用。

所以 `completeWork` 最后会执行 `bubbleProperties`：

```text
child.flags + child.subtreeFlags
  → 合并到 parent.subtreeFlags
```

这样 commit 阶段就可以通过 `subtreeFlags` 快速判断某棵子树有没有需要处理的副作用。

## render 阶段完整流程

```text
renderRoot
  │
  ▼
workLoopSync / workLoopConcurrent
  │
  ▼
performUnitOfWork
  │
  ├─ beginWork：递阶段
  │    ├─ HostRoot：消费 updateQueue
  │    ├─ FunctionComponent：renderWithHooks
  │    └─ HostComponent：处理 children
  │
  └─ completeWork：归阶段
       ├─ 创建 DOM
       ├─ 标记 Update / Ref
       └─ 冒泡 subtreeFlags
```

## 小结

1. render 阶段只计算 Fiber 树和副作用标记，不直接修改页面 DOM。
2. `beginWork` 是递阶段，负责根据 Fiber 类型计算子 Fiber。
3. `completeWork` 是归阶段，负责创建 DOM、标记更新、冒泡 flags。
4. `reconcileChildren` 通过 `alternate` 区分 mount 和 update。
5. `subtreeFlags` 是 commit 阶段快速定位副作用的关键。
