---
title: React 18 源码解析 07：Commit 阶段的 mutation、layout 与 passive
date: 2026-05-16
categories:
  - React源码
tags:
  - React18
  - Commit阶段
  - useEffect
---

> 前言：render 阶段负责算出变化，commit 阶段负责把变化真正应用到宿主环境。理解 commit 阶段，是理解 DOM 更新、ref、useEffect 执行时机的关键。

配套源码仓库：`https://github.com/XY0987/react18_ori.git`

## 系列导航

- 上一篇：[06：Diff 算法中的 key、复用、插入与删除](./06-Diff算法key复用插入删除.md)
- 下一篇：[08：Hooks 原理之 dispatcher 与 Hook 链表](./08-Hooks原理dispatcher与Hook链表.md)

## commit 阶段为什么不可中断

render 阶段可以被中断，因为它主要在内存里构建 workInProgress 树。

commit 阶段不适合被中断，因为它会修改真实 UI。

如果 DOM 操作执行到一半被暂停，页面可能处于不一致状态：

```text
部分节点已经插入
部分节点还没插入
ref 有的更新了，有的没更新
```

所以 commit 阶段必须尽快、连续地完成。

## commitRoot 做了什么

render 阶段完成后，root 上会有一棵 `finishedWork`：

```text
root.finishedWork = root.current.alternate
```

`commitRoot` 主要做这几步：

```text
commitRoot
  │
  ├─ markRootFinished：移除已完成 lane
  │
  ├─ 如果有 passive effect：调度异步 flush
  │
  ├─ commitMutationEffects：执行 DOM 插入、删除、更新，解绑旧 ref
  │
  ├─ root.current = finishedWork：切换双缓冲树
  │
  └─ commitLayoutEffects：绑定新 ref，执行 layout 类副作用
```

这条顺序很重要，尤其是 mutation 和 layout 之间的 `root.current` 切换。

## mutation 阶段：修改宿主环境

mutation 阶段处理这些 flags：

| flag | 含义 |
|------|------|
| `Placement` | 插入或移动节点 |
| `Update` | 更新文本或属性 |
| `ChildDeletion` | 删除子树 |
| `Ref` | 先解绑旧 ref |
| `PassiveEffect` | 收集 useEffect，稍后执行 |

注意，`PassiveEffect` 不是在 mutation 阶段立即执行，而是先收集到 `root.pendingPassiveEffects`。

## Placement：插入节点不一定是插入当前 Fiber

执行 `Placement` 时，React 要先找到两个东西：

1. 宿主父节点：插到哪里；
2. 稳定兄弟节点：插到谁前面。

```text
commitPlacement
  → getHostParent
  → getHostSibling
  → insertOrAppendPlacementNodeIntoContainer
```

为什么说“不一定插入当前 Fiber”？

因为当前 Fiber 可能是函数组件或 Fragment，它自己没有 DOM。真正要插入的是它子树里的 `HostComponent` 或 `HostText`。

所以插入函数会继续向下找宿主节点。

## ChildDeletion：删除子树要处理副作用

删除不是简单调用一次 `removeChild`。

删除一棵子树时，React 还要处理：

| 节点类型 | 删除时要做什么 |
|----------|----------------|
| `HostComponent` | 记录真实 DOM，解绑 ref |
| `HostText` | 记录真实文本节点 |
| `FunctionComponent` | 收集 unmount passive effect |

最后统一找到宿主父节点，把收集到的真实 DOM 节点移除。

这样做是为了兼容函数组件、Fragment 这类自身没有 DOM 的 Fiber。

## root.current 为什么在 mutation 后切换

commit 流程中有一个关键动作：

```text
commitMutationEffects(finishedWork, root)
root.current = finishedWork
commitLayoutEffects(finishedWork, root)
```

也就是说，mutation 阶段执行时，`root.current` 还是旧树。

layout 阶段执行时，`root.current` 已经是新树。

我的理解是：mutation 阶段更关注“把 DOM 改好”，layout 阶段则允许读取已经更新后的宿主状态，因此需要先完成 current 切换。

## layout 阶段：绑定新 ref

简化实现中，layout 阶段主要处理 `Ref`：

```text
commitLayoutEffects
  → safelyAttachRef
```

ref 的处理顺序是：

```text
mutation 阶段：解绑旧 ref
layout 阶段：绑定新 ref
```

这可以避免同一个 ref 在更新过程中同时指向旧节点和新节点。

## passive effect：useEffect 为什么异步执行

`useEffect` 属于 passive effect。

它不会阻塞 DOM 提交，而是在 commit 后被调度执行：

```text
commitRoot
  → scheduleCallback(NormalPriority)
  → flushPassiveEffects
```

`flushPassiveEffects` 的执行顺序是：

```text
unmount destroy
  → update destroy
  → update create
```

这对应我们平时对 `useEffect` 的直觉：

1. 组件卸载时执行清理函数；
2. 依赖变化时先执行上一次的清理函数；
3. 再执行新的 effect 回调。

## commit 阶段总图

```text
finishedWork with flags
  │
  ▼
commitRoot
  │
  ├─ mutation
  │    ├─ Placement：插入/移动 DOM
  │    ├─ Update：更新 DOM
  │    ├─ ChildDeletion：删除子树
  │    └─ Ref：解绑旧 ref
  │
  ├─ root.current = finishedWork
  │
  ├─ layout
  │    └─ Ref：绑定新 ref
  │
  └─ passive
       └─ useEffect destroy/create
```

## 小结

1. commit 阶段会修改真实 UI，因此不可中断。
2. mutation 阶段处理 DOM 插入、更新、删除和旧 ref 解绑。
3. `root.current` 在 mutation 后、layout 前切换到新树。
4. layout 阶段可以绑定新 ref，读取更新后的宿主状态。
5. `useEffect` 属于 passive effect，会在 DOM 提交后异步执行。
