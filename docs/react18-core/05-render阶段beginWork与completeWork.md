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

## beginWork：递阶段，生成/复用子 Fiber，并标记变化

`beginWork` 是 render 阶段的“递”阶段，也就是从父 Fiber 向子 Fiber 往下走。

它的核心职责不是创建 DOM，而是：

```text
当前 Fiber
  → 根据 Fiber 类型计算 nextChildren
  → 对比 current.child 和 nextChildren
  → 生成或复用子 Fiber
  → 在 diff 过程中标记插入、删除、移动等变化
  → 返回下一个要处理的子 Fiber
```

所以 `beginWork` 可以理解成两步：

| 步骤 | 做什么 | 目的 |
|------|--------|------|
| 计算 `nextChildren` | HostRoot 消费 updateQueue，函数组件执行组件函数，HostComponent 读取 props.children | 得到这次 render 想要的子节点结构 |
| `reconcileChildren` | 对比旧子 Fiber 和新 children | 创建/复用 Fiber，并给变化打 flags |

`beginWork` 的核心结构是一个 `switch`：

```text
HostRoot
  → updateHostRoot
  → processUpdateQueue 得到 nextChildren
  → reconcileChildren

FunctionComponent
  → updateFunctionComponent
  → renderWithHooks 执行组件函数得到 nextChildren
  → reconcileChildren

HostComponent
  → updateHostComponent
  → 从 pendingProps.children 得到 nextChildren
  → reconcileChildren

Fragment / ContextProvider
  → 取 children
  → reconcileChildren
```

不同 Fiber 类型获取 `nextChildren` 的方式不同，但最终都会落到同一个动作：

```text
reconcileChildren(wip, nextChildren)
  → mount：创建新的子 Fiber
  → update：复用旧 Fiber 或创建新 Fiber
  → diff：标记 Placement / ChildDeletion / 移动等副作用
  → 返回 wip.child
```

也就是说，`beginWork` 的最终目标是：**为当前 Fiber 算出下一层子 Fiber，并告诉 work loop 接下来该处理哪个 Fiber。**

为什么这件事适合放在递阶段？因为父节点最先知道自己的 `children` 变成了什么。只有先处理父 Fiber，才能拿到新的 `children`，再拿它和旧的 `current.child` 做 diff，生成下一层 Fiber。

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

## reconcileChildren：Fiber 复用和 diff 标记的入口

`reconcileChildren` 是 `beginWork` 里最关键的一步，它会看当前 Fiber 有没有 `alternate`：

| 情况 | 说明 | 使用的协调器 | 是否追踪副作用 |
|------|------|--------------|----------------|
| `alternate === null` | mount 阶段 | `mountChildFibers` | 通常不追踪每个新节点的插入 |
| `alternate !== null` | update 阶段 | `reconcileChildFibers` | 追踪插入、删除、移动 |

mount 阶段主要是“从无到有”创建 Fiber：

```text
ReactElement
  → FiberNode
  → 挂到父 Fiber.child / sibling 上
```

update 阶段才是真正的 diff：

```text
旧的 current.child
新的 nextChildren
  → key 和 type 相同：复用旧 Fiber，创建对应 workInProgress
  → key 或 type 不同：旧 Fiber 删除，新节点创建新 Fiber
  → 位置变化：打 Placement
  → 旧节点多余：打 ChildDeletion
```

这些标记不会立刻操作 DOM，只是记录在 Fiber 上，等 commit 阶段统一执行。

为什么 mount 阶段不需要给每个节点都打 `Placement`？

因为首屏渲染时，整棵 DOM 树会在 render 阶段先以离屏方式构建好，最后只需要把根节点一次性挂到容器里。此时给每一个新节点都打插入标记，意义不大，反而会增加无用工作。

而 update 阶段不同，页面上已经有 DOM 了。React 必须知道：

```text
哪些节点要新增
哪些节点要删除
哪些节点要移动
哪些节点只需要更新内容
```

commit 阶段才能按这些 flags 做最小化 DOM 操作。

## completeWork：归阶段，创建宿主实例并冒泡标记

当一个 Fiber 没有子节点，或者子节点都处理完后，就进入 `completeWork`。

`completeWork` 是 render 阶段的“归”阶段，也就是从叶子 Fiber 往父 Fiber 回收。它的核心职责是：

```text
当前 Fiber 的子树已经处理完成
  → 收尾当前 Fiber
  → 创建或更新宿主实例
  → 把子树 flags 冒泡到当前 Fiber.subtreeFlags
  → 回到兄弟节点或父节点
```

可以分成两类工作：

| 工作 | 发生位置 | 作用 |
|------|----------|------|
| 宿主节点收尾 | `HostComponent` / `HostText` | mount 时创建 DOM，update 时标记文本更新、更新 props 等 |
| 标记冒泡 | 所有 Fiber | 汇总子树中的副作用，方便 commit 阶段快速定位 |

注意：函数组件本身没有 DOM，Fragment 本身也没有 DOM。真正创建 DOM 的是 `HostComponent` 和 `HostText`。

## 离屏 DOM 树如何构建

mount 一个 DOM 节点时，`completeWork` 会先创建当前节点的 DOM：

```text
createInstance(type, props)
```

然后调用 `appendAllChildren(instance, wip)`，把子树里已经创建好的 DOM 节点插入当前 DOM。

为什么这件事放在归阶段？

因为归阶段有一个天然优势：**处理父节点时，它的子节点已经处理完了。**

比如：

```text
<div>
  <span>hello</span>
</div>
```

执行顺序大致是：

```text
text completeWork
  → 创建文本 DOM

span completeWork
  → 创建 span DOM
  → appendAllChildren(span, text)

div completeWork
  → 创建 div DOM
  → appendAllChildren(div, span)
```

所以父 DOM 可以在归阶段把已经创建好的子 DOM 收集起来，形成一棵还没有挂到页面上的离屏 DOM 树。

这也是 render 阶段“不直接修改页面 DOM”的原因之一：它只是在内存中把下一棵树准备好，真正挂载和更新页面要等 commit 阶段。

## flags 为什么要向上冒泡

render 阶段会给有变化的 Fiber 打 flags，比如：

```text
Placement       新增或移动
Update          文本或属性更新
ChildDeletion   删除子节点
Ref             ref 绑定或解绑
PassiveEffect   useEffect 相关副作用
```

这些 flags 一开始只挂在“真正发生变化的 Fiber”上。

问题是：commit 阶段是从 `finishedWork` 根节点开始的。如果根节点不知道自己的子树里哪里有变化，就只能无脑遍历整棵 Fiber 树。

这会带来两个问题：

```text
1. 很多没有变化的子树也会被遍历
2. commit 阶段是同步不可中断的，遍历越多，阻塞越久
```

所以 `completeWork` 最后会执行 `bubbleProperties`，把子节点的标记向父节点汇总：

```text
child.flags
child.subtreeFlags
  → 合并到 parent.subtreeFlags
```

这样父 Fiber 就知道：

```text
我的子树里有没有 Placement / Update / ChildDeletion / PassiveEffect 等副作用
```

到了 commit 阶段，就可以先判断：

```text
如果 parent.subtreeFlags 没有目标副作用
  → 整棵子树可以跳过

如果 parent.subtreeFlags 有目标副作用
  → 再进入子树继续找具体有 flags 的 Fiber
```

所以冒泡的根本原因是：**把分散在子孙 Fiber 上的副作用信息汇总到父节点，方便 commit 阶段快速跳过无变化子树，只处理真正有副作用的分支。**

这里要注意，“方便后续调度”更准确地说是方便后续的 **commit 副作用遍历**，不是 Scheduler 层面的任务调度。Scheduler 决定什么时候执行任务，而 `subtreeFlags` 决定 commit 阶段进入哪些子树执行 DOM 操作或 effect。

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
  │    ├─ 根据 Fiber 类型计算 nextChildren
  │    ├─ reconcileChildren 创建/复用子 Fiber
  │    ├─ diff 中标记 Placement / ChildDeletion / 移动
  │    └─ 返回下一个子 Fiber，继续向下递
  │
  └─ completeWork：归阶段
       ├─ HostComponent / HostText 创建或更新宿主实例
       ├─ mount 时构建离屏 DOM 树
       ├─ update 时补充 Update / Ref 等标记
       └─ bubbleProperties 冒泡 subtreeFlags
```

如果用一句话概括：

```text
beginWork 负责“往下算”：算 children、生成/复用 Fiber、diff 标记变化。
completeWork 负责“往上收”：创建宿主实例、汇总 flags、为 commit 做准备。
```

## 小结

1. render 阶段只计算 Fiber 树和副作用标记，不直接修改页面 DOM。
2. `beginWork` 是递阶段，核心是计算 `nextChildren`，并通过 `reconcileChildren` 创建/复用子 Fiber。
3. diff 标记主要发生在 `beginWork` 里的 child reconciler，例如 `Placement`、`ChildDeletion`、移动标记等。
4. `completeWork` 是归阶段，核心是创建/更新宿主实例，并把子树 flags 冒泡到 `subtreeFlags`。
5. 冒泡 flags 的原因是 commit 阶段从根节点开始，如果没有 `subtreeFlags`，就很难快速判断哪棵子树有副作用。
6. `subtreeFlags` 让 commit 阶段可以跳过无变化子树，只进入有 `Placement`、`Update`、`ChildDeletion`、`PassiveEffect` 等副作用的分支。
7. `reconcileChildren` 通过 `alternate` 区分 mount 和 update：mount 主要创建 Fiber，update 需要复用 Fiber 并追踪副作用。
