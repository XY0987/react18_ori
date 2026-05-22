---
title: React 18 源码解析 16：Scheduler、同步队列与时间切片
date: 2026-05-16
categories:
  - React源码
tags:
  - React18
  - Scheduler
  - 时间切片
---

> 前言：Lane 解决的是“哪个更新更重要”，Scheduler 解决的是“任务什么时候执行、能不能让出主线程”。这篇把 `workLoop`、同步任务队列和时间切片串起来看。

配套源码仓库：`https://github.com/XY0987/react18_ori.git`

## 系列导航

- 上一篇：[15：HostConfig 渲染器适配层](./15-HostConfig渲染器适配层.md)
- 下一篇：[17：Ref 源码之 commit 阶段解绑与绑定](./17-Ref源码commit阶段解绑与绑定.md)

## 调度系统解决什么问题

React 更新不是只有一种执行方式。

有些更新必须尽快完成，比如点击、输入、首屏同步渲染。

有些更新可以拆开执行，比如大列表渲染、transition 更新。

所以调度系统至少要回答三个问题：

| 问题 | 对应机制 |
|------|----------|
| 哪个更新先执行 | Lane 优先级 |
| 同步更新怎么尽快执行 | syncQueue + microtask |
| 并发更新怎么避免卡主线程 | Scheduler + shouldYield |

## 从 scheduleUpdateOnFiber 开始

所有更新最终都会进入：

```text
scheduleUpdateOnFiber(fiber, lane)
```

它做三件事：

```text
1. markUpdateFromFiberToRoot：从触发更新的 Fiber 找到 root
2. markRootUpdated：把 lane 合并到 root.pendingLanes
3. ensureRootIsSchedule：安排任务执行
```

真正决定同步还是并发的是 `ensureRootIsSchedule`。

## ensureRootIsSchedule：调度分流点

它会先取 root 上最高优先级 lane：

```text
updateLane = getHighestPriorityLane(root.pendingLanes)
```

然后分流：

```text
SyncLane
  → scheduleSyncCallback
  → scheduleMicroTask(flushSyncCallbacks)

其他 lane
  → lanesToSchedulerPriority
  → scheduleCallback(performConcurrentWorkOnRoot)
```

这就是同步更新和并发更新的分界线。

## syncQueue：同步任务不是立刻执行

同步更新也不是在 `scheduleUpdateOnFiber` 里直接 render。

它会先进入 `syncQueue`：

```text
scheduleSyncCallback(performSyncWorkOnRoot)
```

然后通过微任务统一执行：

```text
scheduleMicroTask(flushSyncCallbacks)
```

为什么要这样？

因为同一轮事件里可能连续触发多次同步更新。先放进队列，再统一 flush，可以减少重复调度。

## flushSyncCallbacks 做了什么

`flushSyncCallbacks` 会遍历同步队列：

```text
syncQueue.forEach(callback => callback())
```

每个 callback 通常就是：

```text
performSyncWorkOnRoot(root)
```

同时它会用 `isFlushingSyncQueue` 防止递归 flush。

这个保护很重要，因为 effect 或更新过程中可能继续触发同步更新。

## performSyncWorkOnRoot：同步 render

同步更新入口：

```text
performSyncWorkOnRoot(root)
  → renderRoot(root, SyncLane, false)
  → commitRoot(root)
```

第三个参数 `false` 表示不开启时间切片。

也就是说，同步更新会一直执行到 render 完成，不主动让出主线程。

## 并发任务交给 Scheduler

非 SyncLane 会转换成 Scheduler priority：

```text
lanesToSchedulerPriority(updateLane)
```

然后调用：

```text
scheduleCallback(priority, performConcurrentWorkOnRoot)
```

Scheduler 会在合适的时间执行这个任务。

和同步任务不同，并发任务执行 render 时会开启时间切片：

```text
renderRoot(root, lane, true)
```

## 时间切片在哪里发生

并发工作循环是：

```text
while (workInProgress !== null && !shouldYield()) {
  performUnitOfWork(workInProgress)
}
```

每处理一个 Fiber 工作单元，就检查一次 `shouldYield()`。

如果应该让出主线程，就暂停 render，返回 `RootInComplete`。

下次 Scheduler 再调度时，从当前 `workInProgress` 继续执行。

这就是 Fiber 能支持并发渲染的原因之一：整棵树被拆成了一个个可中断的工作单元。

## 并发任务没做完怎么办

如果 render 被中断：

```text
exitStatus === RootInComplete
```

React 会返回一个 continuation：

```text
return performConcurrentWorkOnRoot.bind(null, root)
```

Scheduler 后续会继续调度这个函数。

如果期间来了更高优先级任务，当前任务可能被取消或让位。

## passive effect 为什么会先 flush

并发任务开始前，会先尝试 flush passive effect：

```text
flushPassiveEffects(root.pendingPassiveEffects)
```

原因是 passive effect 里可能触发新的更新，而且可能是更高优先级。

如果 flush 过程中当前 callback 被替换，说明有更重要的任务进来了，当前任务就不继续执行。

## 同步和并发的对比

| 对比项 | 同步更新 | 并发更新 |
|--------|----------|----------|
| 入口 | `performSyncWorkOnRoot` | `performConcurrentWorkOnRoot` |
| 调度方式 | syncQueue + microtask | Scheduler callback |
| 是否时间切片 | 否 | 是 |
| 是否可中断 | 否 | 是 |
| render 循环 | `workLoopSync` | `workLoopConcurrent` |

## 调度总图

```text
scheduleUpdateOnFiber
  │
  ▼
ensureRootIsSchedule
  │
  ├─ SyncLane
  │    ├─ scheduleSyncCallback
  │    ├─ scheduleMicroTask
  │    └─ performSyncWorkOnRoot
  │
  └─ Non-SyncLane
       ├─ lanesToSchedulerPriority
       ├─ scheduleCallback
       └─ performConcurrentWorkOnRoot
             └─ workLoopConcurrent + shouldYield
```

## 小结

1. Lane 决定更新优先级，Scheduler 决定任务执行时机。
2. SyncLane 会进入同步队列，并通过微任务统一 flush。
3. 非同步 lane 会交给 Scheduler，以支持时间切片。
4. 并发 render 会在 Fiber 工作单元之间检查 `shouldYield()`。
5. render 可中断，commit 不可中断。
