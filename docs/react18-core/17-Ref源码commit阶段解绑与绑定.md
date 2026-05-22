---
title: React 18 源码解析 17：Ref 源码之 commit 阶段解绑与绑定
date: 2026-05-16
categories:
  - React源码
tags:
  - React18
  - Ref
  - Commit阶段
---

> 前言：`ref` 看起来只是拿 DOM 实例，但源码里它横跨 render 和 commit：render 阶段标记 `Ref`，commit 的 mutation 阶段先解绑旧 ref，layout 阶段再绑定新 ref。

配套源码仓库：`https://github.com/XY0987/react18_ori.git`

## 系列导航

- 上一篇：[16：Scheduler、同步队列与时间切片](./16-Scheduler同步队列与时间切片.md)
- 下一篇：[18：源码阅读路线与调试指南](./18-React18源码阅读路线与调试指南.md)

## ref 的作用

在 React 中，ref 主要用于拿到宿主实例或组件暴露的实例能力。

最常见的是拿 DOM：

```tsx
const inputRef = useRef<HTMLInputElement>(null);

<input ref={inputRef} />
```

提交后：

```text
inputRef.current → input DOM
```

但这个赋值不是 render 阶段完成的，而是在 commit 阶段完成。

## ref 为什么不能在 render 阶段处理

render 阶段只负责计算 Fiber 树和 flags，不应该修改真实宿主环境。

ref 指向的是真实 DOM 实例：

```text
ref.current = dom
```

这属于副作用，必须放到 commit 阶段。

所以 ref 的流程是：

```text
render 阶段
  → 判断 ref 是否需要变化
  → 打 Ref flag

commit 阶段
  → mutation：解绑旧 ref
  → layout：绑定新 ref
```

## beginWork / completeWork 如何标记 Ref

在原生 DOM 节点更新时，React 会比较新旧 ref。

如果是 mount 时存在 ref，或者 update 时 ref 引用变化，就给 Fiber 打 `Ref` 标记。

```text
current === null && ref !== null
  → Ref

current !== null && current.ref !== workInProgress.ref
  → Ref
```

这个标记告诉 commit 阶段：这个 Fiber 的 ref 需要处理。

## mutation 阶段：先解绑旧 ref

commit 的 mutation 阶段会处理 `Ref`：

```text
if (flags & Ref) {
  safelyDetachRef(finishedWork)
}
```

解绑逻辑分两种：

```text
函数 ref
  → ref(null)

对象 ref
  → ref.current = null
```

为什么先解绑？

因为同一个 ref 可能从旧 DOM 切换到新 DOM。先解绑旧值，再绑定新值，可以避免中间状态混乱。

## root.current 什么时候切换

commit 顺序是：

```text
commitMutationEffects
root.current = finishedWork
commitLayoutEffects
```

也就是说：

| 阶段 | root.current 指向 |
|------|-------------------|
| mutation | 旧树 |
| layout | 新树 |

ref 的新值绑定放在 layout 阶段，意味着绑定时 React 已经把 current 切换成新树。

## layout 阶段：绑定新 ref

layout 阶段遇到 `Ref` 标记，会执行：

```text
safelyAttachRef(finishedWork)
```

绑定逻辑同样分两种：

```text
函数 ref
  → ref(instance)

对象 ref
  → ref.current = instance
```

对于 DOM renderer，`instance` 就是 `fiber.stateNode`，也就是真实 DOM 节点。

## useRef 和 ref 属性不是一回事

`useRef` 返回一个稳定对象：

```tsx
const ref = useRef(null);
```

这个对象本身保存在 Hook 的 `memoizedState` 上。

而 JSX 里的 `ref` 属性：

```tsx
<div ref={ref} />
```

会被放到 ReactElement.ref，再进入 Fiber.ref。

最终 commit 阶段把 DOM 实例写入这个 ref 对象。

可以理解为：

```text
useRef 创建容器
ref 属性把容器交给 React
commit 阶段 React 往容器里写 DOM
```

## ref 完整流程

```text
useRef(null)
  │
  ▼
返回 { current: null }
  │
  ▼
<div ref={ref} />
  │
  ▼
ReactElement.ref
  │
  ▼
Fiber.ref
  │
  ▼
render 阶段标记 Ref flag
  │
  ▼
commit mutation：旧 ref 置空
  │
  ▼
root.current 切换
  │
  ▼
commit layout：新 ref 绑定 DOM
```

## 小结

1. ref 是副作用，不能在 render 阶段直接处理。
2. render 阶段只负责判断 ref 是否变化，并打 `Ref` 标记。
3. mutation 阶段先解绑旧 ref。
4. layout 阶段在 current 树切换后绑定新 ref。
5. `useRef` 创建稳定容器，JSX `ref` 属性让 React 在 commit 阶段写入实例。
