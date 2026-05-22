---
title: React 18 源码解析 10：useEffect 源码之 effect 链表与执行时机
date: 2026-05-16
categories:
  - React源码
tags:
  - React18
  - useEffect
  - PassiveEffect
---

> 前言：`useEffect` 的难点不在 API 用法，而在它跨越 render 和 commit 两个阶段：render 阶段收集 effect，commit 后再异步执行 destroy/create。

配套源码仓库：`https://github.com/XY0987/react18_ori.git`

## 系列导航

- 上一篇：[09：useState 源码之 dispatch 与更新队列](./09-useState源码dispatch与更新队列.md)
- 下一篇：[11：useTransition 源码与 TransitionLane](./11-useTransition源码TransitionLane.md)

## useEffect 的主线

先看整体流程：

```text
render 阶段：
useEffect(create, deps)
  → mountEffect / updateEffect
  → pushEffect
  → 标记 Fiber.flags |= PassiveEffect

commit 阶段：
commitRoot
  → 收集 passive effect 到 root.pendingPassiveEffects
  → scheduleCallback
  → flushPassiveEffects
  → destroy / create
```

一句话：`useEffect` 在 render 阶段登记，在 commit 后执行。

## Hook 链表和 effect 链表是两条链

函数组件有一条 Hook 链表：

```text
Fiber.memoizedState
  → Hook1 → Hook2 → Hook3
```

但 `useEffect` 还会额外维护一条 effect 链表：

```text
fiber.updateQueue.lastEffect
  └─ effect 环状链表
```

为什么要两条链？

| 链表 | 服务阶段 | 作用 |
|------|----------|------|
| Hook 链表 | render 阶段 | 按调用顺序保存每个 Hook 的状态 |
| effect 链表 | commit 阶段 | 快速遍历需要执行的副作用 |

## Effect 对象长什么样

一个 effect 大致包含：

| 字段 | 含义 |
|------|------|
| `tag` | effect 类型和是否需要执行 |
| `create` | `useEffect` 传入的回调 |
| `destroy` | 上一次 create 返回的清理函数 |
| `deps` | 依赖数组 |
| `next` | 下一个 effect |

`tag` 里最关键的是两个标记：

| 标记 | 含义 |
|------|------|
| `Passive` | 这是 `useEffect` 类型的 effect |
| `HookHasEffect` | 本次 commit 需要执行 destroy/create |

只有 `Passive | HookHasEffect` 同时命中的 effect，才会在本次 commit 后执行。

## mountEffect：首次渲染一定执行

mount 阶段没有旧依赖数组可比较，所以 effect 一定需要执行。

流程是：

```text
mountEffect
  → mountWorkInProgressHook
  → Fiber.flags |= PassiveEffect
  → pushEffect(Passive | HookHasEffect)
```

这里有两个标记层级：

1. Fiber 上的 `PassiveEffect`：告诉 commit 阶段这棵 Fiber 有 passive effect；
2. effect 上的 `HookHasEffect`：告诉 flush 时这个 effect 需要执行。

## updateEffect：依赖没变就不执行

update 阶段会拿到上一次的 effect：

```text
prevEffect = currentHook.memoizedState
prevDeps = prevEffect.deps
```

然后和本次 deps 做浅比较。

```text
deps 没变
  → pushEffect(Passive)
  → 不打 HookHasEffect

 deps 变了
  → Fiber.flags |= PassiveEffect
  → pushEffect(Passive | HookHasEffect)
```

所以依赖数组的本质不是阻止 effect 被创建，而是控制本次 effect 是否带 `HookHasEffect`。

## pushEffect：维护环状链表

effect 链表也是环状链表。

第一次插入：

```text
effect.next = effect
lastEffect = effect
```

后续插入：

```text
lastEffect.next → newEffect
newEffect.next → firstEffect
lastEffect = newEffect
```

只保存 `lastEffect`，就能从 `lastEffect.next` 找到第一个 effect。

这和 updateQueue 的环状链表思路很像。

## commit 阶段如何收集 effect

mutation 阶段遇到带 `PassiveEffect` 的函数组件时，不会立即执行 effect。

它只做收集：

```text
commitPassiveEffect
  → root.pendingPassiveEffects.update.push(lastEffect)
```

组件删除时，则会收集到 `unmount` 队列。

```text
commitDeletion
  → FunctionComponent
  → commitPassiveEffect(type = 'unmount')
```

## flushPassiveEffects 的执行顺序

commit 后，React 会调度一个回调执行 passive effect。

执行顺序是：

```text
1. unmount destroy
2. update destroy
3. update create
```

这解释了我们熟悉的现象：

```tsx
useEffect(() => {
  console.log('create');
  return () => console.log('destroy');
}, [dep]);
```

当 `dep` 变化时，先执行旧的 `destroy`，再执行新的 `create`。

## useEffect 为什么不阻塞 DOM 更新

`useEffect` 属于 passive effect，它在 DOM 提交后异步执行。

这样可以避免副作用逻辑阻塞页面更新。

如果你需要在 DOM 更新后、浏览器绘制前同步读取布局，应该使用 `useLayoutEffect`。当前简化实现没有实现它，但 React 官方源码中会把 layout effect 放在 layout 阶段处理。

## 小结

1. `useEffect` 在 render 阶段收集 effect，在 commit 后异步执行。
2. Hook 链表服务 render 阶段，effect 链表服务 commit 阶段。
3. `PassiveEffect` 标记在 Fiber 上，`HookHasEffect` 标记在 effect 上。
4. 依赖数组没变时，effect 仍会入链表，但不会带 `HookHasEffect`。
5. passive effect 执行顺序是 unmount destroy、update destroy、update create。
