---
title: React 18 源码解析 06：Diff 算法中的 key、复用、插入与删除
date: 2026-05-16
categories:
  - React源码
tags:
  - React18
  - Diff
  - Reconciliation
---

> 前言：React 的 diff 算法并不是简单比较两棵树，而是在 Fiber 架构下，为每个子节点决定“能不能复用”和“需不需要打副作用标记”。这篇重点看子节点协调的核心逻辑。

配套源码仓库：`https://github.com/XY0987/react18_ori.git`

## 系列导航

- 上一篇：[05：render 阶段的 beginWork 与 completeWork](./05-render阶段beginWork与completeWork.md)
- 下一篇：[07：Commit 阶段的 mutation、layout 与 passive](./07-Commit阶段mutation-layout-passive.md)

## Diff 的目标是什么

React diff 的目标不是生成一份抽象的 diff 描述，而是生成一棵带副作用标记的新 Fiber 树。

```text
old Fiber children
        +
new ReactElement children
        ↓
new Fiber children with flags
```

这些 flags 会在 commit 阶段变成真实 DOM 操作：

| flag | commit 阶段含义 |
|------|----------------|
| `Placement` | 插入或移动 DOM |
| `ChildDeletion` | 删除子节点 |
| `Update` | 更新文本或属性 |

## mount 和 update 为什么不同

`ChildReconciler(shouldTrackEffects)` 通过 `shouldTrackEffects` 区分两个阶段：

| 阶段 | `shouldTrackEffects` | 原因 |
|------|----------------------|------|
| mount | `false` | 首屏构建整棵树，不需要给每个新节点都打插入标记 |
| update | `true` | 需要记录插入、移动、删除，供 commit 阶段执行 |

这点很关键。很多人以为所有新节点都会打 `Placement`，但首屏 mount 时不是这样。

## 单节点 diff：先比 key，再比 type

对于单个 ReactElement，复用逻辑可以简化成：

```text
遍历旧 Fiber
  │
  ├─ key 不同
  │    └─ 删除旧 Fiber，继续找
  │
  └─ key 相同
       ├─ type 相同：复用 Fiber
       └─ type 不同：删除剩余旧 Fiber，创建新 Fiber
```

为什么先比 key？

因为 key 表示同级列表里的身份。key 不同，React 会认为它们不是同一个节点，即使 type 一样也不能直接复用。

为什么再比 type？

因为同一个 key 下，`<div key="a" />` 和 `<span key="a" />` 对应的真实 DOM 类型不同，不能复用原来的 DOM 节点。

## 文本节点 diff

文本节点没有 key 和 type，逻辑更简单：

```text
旧 Fiber 是 HostText
  → 复用
否则
  → 删除旧节点，创建新的 HostText Fiber
```

文本内容是否变化，不在 `beginWork` 阶段处理，而是在 `completeWork` 阶段比较旧文本和新文本，变化时打 `Update` 标记。

## 多节点 diff：Map 复用

对于数组 children，简化实现采用 Map 方案：

```text
第一步：把旧 Fiber 按 key/index 放入 Map
第二步：遍历新 children，从 Map 中找可复用节点
第三步：根据 oldIndex 和 lastPlacedIndex 判断是否移动
第四步：Map 中剩余旧 Fiber 标记删除
```

先看第一步：

```text
old children: A(key=a), B(key=b), C(key=c)

existingChildren:
a → A
b → B
c → C
```

遍历新 children 时，如果 key 能在 Map 中找到，并且 type 一样，就可以复用旧 Fiber。

## key 不存在时用 index

如果节点没有 key，React 会退化使用 index：

```text
keyToUse = key !== null ? key : index
```

这也是为什么列表渲染不建议随便用 index 当 key。

当列表只追加、不重排、不删除时，index key 问题不大；但一旦发生插入、移动、删除，index key 可能导致错误复用。

## lastPlacedIndex 如何判断移动

多节点 diff 中最绕的是 `lastPlacedIndex`。

可以把它理解为：到目前为止，已经确认“不需要移动”的旧节点最大位置。

遍历新列表时，如果某个可复用节点的旧位置小于 `lastPlacedIndex`，说明它在新列表中相对顺序变了，需要移动。

例子：

```text
旧列表：A B C
旧索引：0 1 2

新列表：B C A
```

遍历新列表：

| 新节点 | 旧索引 | lastPlacedIndex | 是否移动 |
|--------|--------|-----------------|----------|
| B | 1 | 0 | 不移动，更新 lastPlacedIndex = 1 |
| C | 2 | 1 | 不移动，更新 lastPlacedIndex = 2 |
| A | 0 | 2 | 旧索引小于 2，需要移动 |

所以 A 会被打上 `Placement`。

## 删除如何记录

当旧 Fiber 没有被新 children 复用时，会调用 `deleteChild`。

删除不是立刻操作 DOM，而是记录到父 Fiber 上：

```text
returnFiber.deletions.push(childToDelete)
returnFiber.flags |= ChildDeletion
```

这样 commit 阶段遍历到父 Fiber 时，就知道要删除哪些子节点。

## Diff 的产物不是 DOM 操作，而是 flags

这一点要反复强调：diff 阶段不直接改 DOM。

它只做两件事：

1. 创建或复用 Fiber；
2. 给需要处理的 Fiber 打 flags。

真正的 DOM 插入、移动、删除发生在 commit 阶段。

## 小结

1. React diff 的产物是一棵带 flags 的新 Fiber 树。
2. 单节点复用先比较 key，再比较 type。
3. 多节点 diff 可以通过 Map 快速查找可复用旧 Fiber。
4. `lastPlacedIndex` 用来判断节点是否需要移动。
5. 删除操作记录在父 Fiber 的 `deletions` 上，commit 阶段再真正删除 DOM。
