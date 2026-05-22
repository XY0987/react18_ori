---
title: React 18 源码解析 18：源码阅读路线与调试指南
date: 2026-05-16
categories:
  - React源码
tags:
  - React18
  - 源码阅读
  - 调试指南
---

> 前言：前面 17 篇已经把 React 18 的主流程和核心模块拆了一遍。这篇不再讲单个模块，而是整理一套更适合长期复盘的源码阅读路线和调试方法。

配套源码仓库：`https://github.com/XY0987/react18_ori.git`

## 系列导航

- 上一篇：[17：Ref 源码之 commit 阶段解绑与绑定](./17-Ref源码commit阶段解绑与绑定.md)
- 下一篇：[19：设计哲学总结与框架设计启示](./19-React18设计哲学与框架设计启示.md)

## 为什么需要阅读路线

React 源码最大的问题不是某个函数特别难，而是模块之间相互引用，很容易看着看着就迷路。

我的建议是：不要从“文件”开始读，而要从“流程”开始读。

先建立这条主线：

```text
JSX
  → ReactElement
  → createRoot().render()
  → updateQueue
  → scheduleUpdateOnFiber
  → renderRoot
  → beginWork / completeWork
  → commitRoot
  → hostConfig 操作宿主环境
```

后续看任何模块，都先问一句：它在这条链路的哪个位置？

## 第一阶段：先跑起来

先安装依赖：

```bash
pnpm install
```

运行 demo：

```bash
pnpm demo
```

当前 demo 命令默认指向：

```text
demos/context
```

如果你要看其他 demo，可以临时修改 `package.json` 里的 `demo` 命令，例如：

```bash
vite serve demos/transition --config scripts/vite/vite.config.js --force
```

可选 demo：

| demo | 适合观察什么 |
|------|--------------|
| `demos/context` | Context Provider / useContext |
| `demos/ref` | ref 绑定与 commit 阶段 |
| `demos/test-fc` | 函数组件、useState、useEffect |
| `demos/transition` | useTransition、TransitionLane |

## 第二阶段：从入口打断点

建议先从入口链路打断点：

| 断点 | 文件 | 观察点 |
|------|------|--------|
| `createRoot` | `packages/react-dom/src/root.ts` | DOM renderer 如何创建 root |
| `createContainer` | `packages/react-reconciler/src/fiberReconciler.ts` | HostRoot Fiber 和 FiberRootNode 如何连接 |
| `updateContainer` | `packages/react-reconciler/src/fiberReconciler.ts` | ReactElement 如何变成 update |
| `scheduleUpdateOnFiber` | `packages/react-reconciler/src/workLoop.ts` | 更新如何从 Fiber 找到 root |
| `ensureRootIsSchedule` | `packages/react-reconciler/src/workLoop.ts` | SyncLane 和并发任务如何分流 |

这一阶段的目标：看清楚一次 `render(<App />)` 如何进入调度系统。

不要急着看 diff 和 Hooks。

## 第三阶段：观察 Fiber 树

接下来重点看 Fiber 数据结构。

推荐断点：

| 断点 | 文件 | 观察点 |
|------|------|--------|
| `createWorkInProgress` | `fiber.ts` | current 和 workInProgress 如何通过 alternate 连接 |
| `createFiberFromElement` | `fiber.ts` | ReactElement.type 如何决定 Fiber.tag |
| `beginWork` | `beginWork.ts` | 不同 WorkTag 如何分发 |
| `reconcileChildren` | `beginWork.ts` | mount/update 如何选择不同 reconciler |

建议在控制台重点看这些字段：

```text
fiber.tag
fiber.type
fiber.key
fiber.pendingProps
fiber.memoizedProps
fiber.memoizedState
fiber.child
fiber.sibling
fiber.return
fiber.alternate
fiber.flags
fiber.subtreeFlags
```

看懂这些字段，Fiber 就不再是抽象概念。

## 第四阶段：拆 render 阶段

render 阶段按“递”和“归”理解。

```text
递：beginWork
归：completeWork
```

推荐断点：

| 断点 | 文件 | 观察点 |
|------|------|--------|
| `performUnitOfWork` | `workLoop.ts` | 每次处理一个 Fiber 工作单元 |
| `beginWork` | `beginWork.ts` | 如何计算子 Fiber |
| `reconcileChildrenArray` | `childFibers.ts` | 多节点 diff 如何复用和移动 |
| `completeWork` | `completeWork.ts` | DOM 实例何时创建 |
| `bubbleProperties` | `completeWork.ts` | flags 如何冒泡到父 Fiber |

这一阶段要验证一句话：render 阶段不改页面，只构建 workInProgress 树并收集 flags。

## 第五阶段：拆 commit 阶段

render 完成后，进入 commit。

推荐断点：

| 断点 | 文件 | 观察点 |
|------|------|--------|
| `commitRoot` | `workLoop.ts` | commit 三个子阶段的入口 |
| `commitMutationEffects` | `commitWork.ts` | Placement / Update / ChildDeletion 如何执行 |
| `commitPlacement` | `commitWork.ts` | DOM 插入如何找父节点和兄弟节点 |
| `commitDeletion` | `commitWork.ts` | 删除子树如何处理 ref 和 effect |
| `commitLayoutEffects` | `commitWork.ts` | ref 何时绑定新 DOM |
| `flushPassiveEffects` | `workLoop.ts` | useEffect 何时执行 destroy/create |

重点观察：

```text
root.finishedWork
root.current
root.pendingPassiveEffects
finishedWork.flags
finishedWork.subtreeFlags
```

commit 阶段的核心是：根据 render 阶段打好的 flags，执行真实宿主操作。

## 第六阶段：单独看 Hooks

Hooks 建议从 `useState` 开始，再看 `useEffect`。

推荐断点：

| Hook | 断点 | 文件 |
|------|------|------|
| Hooks 入口 | `renderWithHooks` | `fiberHooks.ts` |
| mount useState | `mountState` | `fiberHooks.ts` |
| update useState | `updateState` | `fiberHooks.ts` |
| dispatch | `disPatchSetState` | `fiberHooks.ts` |
| mount useEffect | `mountEffect` | `fiberHooks.ts` |
| update useEffect | `updateEffect` | `fiberHooks.ts` |
| effect 入链 | `pushEffect` | `fiberHooks.ts` |

重点观察两条链：

```text
Hook 链表：Fiber.memoizedState
Effect 链表：Fiber.updateQueue.lastEffect
```

理解这两条链，Hooks 的实现就清楚一大半。

## 第七阶段：观察 Lane 和 Scheduler

优先级相关建议配合 `transition` demo 看。

推荐断点：

| 断点 | 文件 | 观察点 |
|------|------|--------|
| `requestUpdateLane` | `fiberLanes.ts` | 更新如何选择 lane |
| `schedulerPriorityToLane` | `fiberLanes.ts` | Scheduler priority 如何映射到 lane |
| `lanesToSchedulerPriority` | `fiberLanes.ts` | lane 如何映射回 Scheduler priority |
| `scheduleSyncCallback` | `syncTaskQueue.ts` | 同步任务如何入队 |
| `workLoopConcurrent` | `workLoop.ts` | 时间切片如何通过 shouldYield 中断 |

重点看这些值：

```text
root.pendingLanes
root.callbackPriority
root.callbackNode
wipRootRenderLane
renderLane
```

如果你想理解并发更新，必须把 Lane 和 workLoop 放在一起看。

## 推荐阅读顺序

如果是第一次系统读，我建议按这个顺序：

```text
01 主流程
  ↓
14 JSX → ReactElement → Fiber
  ↓
02 Fiber 数据结构
  ↓
03 UpdateQueue
  ↓
04 Lane
  ↓
16 Scheduler
  ↓
05 Render 阶段
  ↓
06 Diff
  ↓
07 Commit 阶段
  ↓
08-11 Hooks
  ↓
12 合成事件
  ↓
13 Context
  ↓
15 HostConfig
  ↓
17 Ref
```

这个顺序不是文件依赖顺序，而是认知负担更低的阅读顺序。

## 常见调试误区

### 误区一：一上来就看 diff

Diff 很重要，但它依赖 Fiber、flags、commit。

如果没先理解主流程，直接看 diff 很容易只看到“怎么比”，看不到“比完交给谁”。

### 误区二：把 ReactElement 当 Fiber

ReactElement 是输入描述对象，Fiber 是内部工作单元。

二者不是同一个东西。

### 误区三：以为 setState 立刻改 state

`setState` 是创建 update 并调度更新。

真正计算新 state 发生在下一次 render 的 `processUpdateQueue`。

### 误区四：以为 useEffect 在 render 阶段执行

render 阶段只收集 effect。

`useEffect` 的 destroy/create 发生在 commit 后的 passive effect flush 中。

## 小结

1. React 源码阅读要从主流程开始，不要从孤立函数开始。
2. 调试时优先观察 Fiber、root、flags、lane 这几类核心数据。
3. render 阶段只计算，commit 阶段才落地宿主操作。
4. Hooks 的关键是 Hook 链表和 effect 链表。
5. Lane 和 Scheduler 要一起看，才能理解 React 18 的并发更新模型。
