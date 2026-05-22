---
title: React 18 源码解析 14：从 JSX 到 ReactElement 再到 Fiber
date: 2026-05-16
categories:
  - React源码
tags:
  - React18
  - JSX
  - ReactElement
  - Fiber
---

> 前言：很多人把 JSX、ReactElement、Fiber 混在一起。其实它们是 React 渲染链路中的三个不同阶段：JSX 是语法，ReactElement 是描述对象，Fiber 是可调度工作单元。

配套源码仓库：`https://github.com/XY0987/react18_ori.git`

## 系列导航

- 上一篇：[13：Context 源码之 Provider 栈与 useContext](./13-Context源码Provider栈与useContext.md)
- 下一篇：[15：HostConfig 渲染器适配层](./15-HostConfig渲染器适配层.md)

## 三个概念先分清

| 概念 | 是什么 | 什么时候出现 |
|------|--------|--------------|
| JSX | JavaScript 的语法扩展 | 编码阶段 |
| ReactElement | JSX 编译后的普通对象 | 运行时调用 jsx/createElement 后 |
| Fiber | React 内部的工作单元 | reconciler 处理 ReactElement 时 |

可以用一条链路表示：

```text
JSX
  → jsx(...) / createElement(...)
  → ReactElement
  → createFiberFromElement
  → FiberNode
```

## JSX 不是运行时能力

我们写：

```tsx
<div id="app">hello</div>
```

它不会直接被浏览器执行。

编译后大致会变成：

```ts
jsx('div', { id: 'app' }, 'hello')
```

所以 React 真正接收到的是函数调用，而不是 JSX 语法本身。

## ReactElement 是普通对象

`jsx` 的返回值是一个 ReactElement。

它大致长这样：

```ts
{
  $$typeof: REACT_ELEMENT_TYPE,
  type: 'div',
  key: null,
  ref: null,
  props: {
    id: 'app',
    children: 'hello'
  }
}
```

这只是一个描述对象，还不是 DOM，也不是 Fiber。

它描述的是：我要渲染一个什么类型的节点，有什么 props，有什么 children。

## key 和 ref 为什么特殊处理

在 `jsx` 里，`key` 和 `ref` 不会放进 props。

```text
config.key → element.key
config.ref → element.ref
其他字段 → element.props
```

原因是：

| 字段 | React 内部用途 |
|------|----------------|
| `key` | 同级 diff 复用身份 |
| `ref` | commit 阶段绑定宿主实例 |

它们不是普通业务 props，而是 React 内部机制需要使用的字段。

所以组件里不能通过 `props.key` 读取 key。

## children 如何处理

JSX children 会被收集到 `props.children`。

| children 数量 | 保存形式 |
|----------------|----------|
| 0 个 | 不设置 `props.children` |
| 1 个 | 直接保存这个 child |
| 多个 | 保存为数组 |

这会影响后续 `reconcileChildren` 的分支：

```text
单个 ReactElement
  → reconcileSingleElement

字符串/数字
  → reconcileSingleTextNode

数组
  → reconcileChildrenArray
```

所以 children 的形态会直接决定 diff 走哪条路径。

## ReactElement 如何变成 Fiber

render 阶段处理 children 时，reconciler 会根据 ReactElement 创建 Fiber。

```text
createFiberFromElement(element)
  │
  ├─ typeof type === 'string'
  │    └─ HostComponent
  │
  ├─ typeof type === 'function'
  │    └─ FunctionComponent
  │
  └─ type.$$typeof === REACT_PROVIDER_TYPE
       └─ ContextProvider
```

也就是说，ReactElement 的 `type` 决定了 Fiber 的 `tag`。

## ReactElement 和 Fiber 的区别

| 对比项 | ReactElement | Fiber |
|--------|--------------|-------|
| 本质 | 普通描述对象 | React 内部工作单元 |
| 是否可变 | 通常视为不可变 | render 过程中会被修改 |
| 保存结构 | `type/key/ref/props` | `tag/stateNode/child/sibling/return/flags` |
| 所属阶段 | JSX 运行结果 | reconciler 内部结构 |
| 是否参与调度 | 不参与 | 参与 |

ReactElement 是输入，Fiber 是 React 为了调度和更新构建出来的内部数据结构。

## 从 JSX 到 DOM 的完整位置

把它放回完整渲染链路：

```text
JSX
  │
  ▼
jsx / createElement
  │
  ▼
ReactElement
  │
  ▼
updateQueue(action = ReactElement)
  │
  ▼
beginWork / childFibers
  │
  ▼
FiberNode
  │
  ▼
completeWork
  │
  ▼
DOM instance
  │
  ▼
commitRoot
  │
  ▼
插入页面
```

## 小结

1. JSX 是语法，ReactElement 是运行时描述对象，Fiber 是 React 内部工作单元。
2. `jsx` 会把 key/ref 单独提取，其余字段放进 props。
3. children 的数量决定 `props.children` 的形态，也影响后续 diff 分支。
4. ReactElement 的 `type` 决定创建出来的 Fiber 类型。
5. Fiber 不是 JSX 编译出来的，而是 reconciler 在 render 阶段根据 ReactElement 创建或复用的。
