---
title: React 18 源码解析 02：Fiber 数据结构与双缓冲树
date: 2026-05-16
categories:
  - React源码
tags:
  - React18
  - Fiber
  - 双缓冲
---

> 前言：上一篇打通了 `createRoot().render()` 的主流程，这篇进入 Fiber 数据结构。先看懂 `FiberNode` 和 `FiberRootNode`，后面理解调度、diff、commit 才有抓手。文中的实现来自我的简化版 React 18，用来辅助理解官方源码的核心思想。

配套源码仓库：`https://github.com/XY0987/react18_ori.git`

## 系列导航

- 上一篇：[01：createRoot().render() 首屏渲染主流程](./01-createRoot-render主流程.md)
- 下一篇：[03：UpdateQueue 环状链表与状态计算](./03-UpdateQueue环状链表与状态计算.md)

## Fiber 到底是什么

在 React 18 源码设计中，Fiber 至少有三层含义：

| 角度 | Fiber 是什么 | 对应字段或文件 |
|------|--------------|----------------|
| UI 结构 | 一个组件或 DOM 节点在内存中的描述 | `FiberNode.child/sibling/return` |
| 工作单元 | render 阶段可以被拆分执行的最小单元 | `workLoop.ts` 的 `performUnitOfWork` |
| 副作用载体 | 记录本节点和子树需要执行的 DOM 操作 | `flags`、`subtreeFlags` |

我更倾向于这样理解：Fiber 是 ReactElement 到真实 UI 之间的一层“可调度中间表示”。

## FiberNode 的核心字段

`FiberNode` 定义在 `packages/react-reconciler/src/fiber.ts`。

可以按用途把字段分成几组。

### 描述节点自身

| 字段 | 含义 |
|------|------|
| `tag` | Fiber 类型，例如函数组件、原生 DOM、文本、HostRoot |
| `key` | diff 时用于同级节点复用 |
| `type` | 组件类型：函数组件是函数本身，原生节点是标签名 |
| `stateNode` | 宿主实例或根对象，例如 DOM 节点、`FiberRootNode` |

### 描述树结构

Fiber 树不是用数组保存子节点，而是用链表结构：

```text
       return
         ▲
         │
parent ─ child ─ sibling ─ sibling
```

对应字段是：

| 字段 | 含义 |
|------|------|
| `return` | 父 Fiber |
| `child` | 第一个子 Fiber |
| `sibling` | 下一个兄弟 Fiber |
| `index` | 当前 Fiber 在同级列表中的位置 |

这种结构非常适合深度优先遍历：先一路向下处理 `child`，到底后再找 `sibling`，没有兄弟再回到 `return`。

### 描述 render 输入和结果

| 字段 | 含义 |
|------|------|
| `pendingProps` | 本轮 render 输入的新 props |
| `memoizedProps` | 上一轮 render 完成后的 props |
| `memoizedState` | 上一轮 render 完成后的 state；函数组件中是 Hook 链表头 |
| `updateQueue` | 更新队列或 effect 队列 |

这里的 `pending` 和 `memoized` 很关键：

```text
pendingProps：这次准备算什么
memoizedProps：上次算完是什么
```

有了这两个值，React 才能比较新旧输入，决定是否需要更新。

### 描述副作用

| 字段 | 含义 |
|------|------|
| `flags` | 当前 Fiber 自身的副作用 |
| `subtreeFlags` | 子树内所有副作用的汇总 |
| `deletions` | commit 阶段需要删除的子节点 |

`flags` 像当前节点身上的便签，`subtreeFlags` 像父节点手里拿的一份子树汇总表。

commit 阶段通过 `subtreeFlags` 可以快速跳过没有副作用的子树，不需要每次都全量遍历。

## FiberRootNode 和 HostRoot Fiber 的区别

很多人第一次看源码会把这两个概念混在一起。

在配套简化实现中：

| 对象 | 角色 | 重点字段 |
|------|------|----------|
| `FiberRootNode` | 整个应用根对象 | `container`、`current`、`pendingLanes`、`finishedWork` |
| `HostRoot Fiber` | Fiber 树的根节点 | `stateNode`、`updateQueue`、`child` |

它们的连接关系是：

```text
FiberRootNode
  ├─ container：真实 DOM 容器
  └─ current：HostRoot Fiber
                 └─ stateNode：反向指向 FiberRootNode
```

为什么要这么设计？我的理解是：

- `FiberRootNode` 管“整棵树”的调度状态；
- `HostRoot Fiber` 仍然作为 Fiber 树中的一个普通工作单元参与 render。

这样调度系统可以从任意触发更新的 Fiber 一路向上找到 HostRoot，再通过 `stateNode` 拿到 `FiberRootNode`。

## 双缓冲：current 和 workInProgress

React 不会在当前屏幕正在使用的 Fiber 树上直接改。

它会创建另一棵 `workInProgress` 树，在内存中计算好所有变化，commit 时再一次性切换。

```text
更新前：
root.current ─────► current tree

render 阶段：
root.current ─────► current tree
                      ▲
                      │ alternate
                      ▼
                  workInProgress tree

commit 后：
root.current ─────► workInProgress tree
```

这就是双缓冲。

## createWorkInProgress 做了什么

`createWorkInProgress(current, pendingProps)` 是双缓冲的核心函数。

它分两种情况：

| 场景 | 行为 |
|------|------|
| 首次更新 | `current.alternate` 不存在，创建一份新的 Fiber 作为 wip |
| 后续更新 | 复用已有 alternate，并清理上一轮 `flags/subtreeFlags/deletions` |

为什么复用？因为频繁创建整棵 Fiber 树会带来额外内存压力。复用 alternate 可以减少对象创建，同时保留双缓冲模型的好处。

有个细节很重要：复用 wip 时必须清理副作用标记。

```text
上一次 render 的 flags
  如果不清理
下一次 commit 可能误执行旧副作用
```

所以当前实现会重置：

```ts
wip.flags = NoFlags;
wip.subtreeFlags = NoFlags;
wip.deletions = null;
```

## Fiber 与工作循环的关系

上一篇提到 `workLoop.ts` 中的核心循环：

```text
while (workInProgress !== null) {
  performUnitOfWork(workInProgress)
}
```

这里的 `workInProgress` 指针每次指向一个 Fiber。

处理一个 Fiber 时：

1. 先执行 `beginWork`，尝试生成子 Fiber；
2. 如果有子 Fiber，继续向下；
3. 如果没有子 Fiber，执行 `completeWork`，再找兄弟节点；
4. 没有兄弟节点，就回到父节点继续 complete。

这就是 Fiber 为什么能支持“可中断”的基础：整棵树被拆成了一个个 Fiber 工作单元，调度器可以在工作单元之间决定是否暂停。

## 小结

1. Fiber 是 UI 节点描述，也是 render 阶段的工作单元，还是副作用的载体。
2. `FiberRootNode` 管整棵树的根状态，`HostRoot Fiber` 是 Fiber 树中的根工作单元。
3. `alternate` 连接 current 和 workInProgress，构成双缓冲结构。
4. render 阶段在 workInProgress 树上计算，commit 阶段再切换 `root.current`。
5. 看懂 Fiber 数据结构后，再看 `beginWork`、`completeWork`、`commitWork` 会顺很多。
