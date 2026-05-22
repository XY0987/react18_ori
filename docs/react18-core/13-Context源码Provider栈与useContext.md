---
title: React 18 源码解析 13：Context 源码之 Provider 栈与 useContext
date: 2026-05-16
categories:
  - React源码
tags:
  - React18
  - Context
  - useContext
---

> 前言：Context 看起来只是跨层传值，但源码里有一个关键点：Provider 可以嵌套，因此 React 需要在 render 过程中维护一套值的入栈和出栈机制。

配套源码仓库：`https://github.com/XY0987/react18_ori.git`

## 系列导航

- 上一篇：[12：合成事件系统、事件委托与优先级](./12-合成事件系统事件委托与优先级.md)
- 下一篇：[14：从 JSX 到 ReactElement 再到 Fiber](./14-JSX到ReactElement再到Fiber.md)

## Context 要解决什么问题

普通 props 传递是逐层向下：

```text
App → Page → Layout → Button
```

如果每一层都只是转发同一个值，就会很啰嗦。

Context 提供的是一种“跨层读取”的能力：

```tsx
const ThemeContext = createContext('light');

<ThemeContext.Provider value="dark">
  <Button />
</ThemeContext.Provider>
```

`Button` 里可以通过 `useContext(ThemeContext)` 读取到 `dark`。

## createContext 创建了什么

`createContext(defaultValue)` 会创建一个 context 对象：

```text
context = {
  $$typeof: REACT_CONTEXT_TYPE,
  Provider: ...,
  _currentValue: defaultValue
}
```

其中最关键的是两个字段：

| 字段 | 含义 |
|------|------|
| `_currentValue` | 当前 render 过程中这个 context 的值 |
| `Provider` | 一个特殊 React 类型，指向这个 context |

Provider 本身不是普通组件，而是带 `REACT_PROVIDER_TYPE` 标记的特殊对象。

reconciler 遇到 Provider 对应的 Fiber 时，会执行专门逻辑。

## Provider 如何进入 Fiber 流程

JSX：

```tsx
<ThemeContext.Provider value="dark">
  <Button />
</ThemeContext.Provider>
```

会先变成 ReactElement。

创建 Fiber 时，React 看到 `type.$$typeof === REACT_PROVIDER_TYPE`，会把这个 Fiber 标记为 `ContextProvider`。

之后在 `beginWork` 中进入：

```text
updateContextProvider
  → pushProvider(context, newValue)
  → reconcileChildren
```

也就是说，Provider 的 value 是在“递”阶段进入子树前写入的。

## pushProvider：进入 Provider 子树

`pushProvider(context, newValue)` 做两件事：

```text
保存旧值
context._currentValue = newValue
```

为什么要保存旧值？

因为 Provider 可以嵌套：

```tsx
<ThemeContext.Provider value="outer">
  <ThemeContext.Provider value="inner">
    <Child />
  </ThemeContext.Provider>
</ThemeContext.Provider>
```

进入内层 Provider 时，`_currentValue` 会变成 `inner`。

离开内层 Provider 后，必须恢复成 `outer`，否则会影响后面的兄弟子树。

## popProvider：离开 Provider 子树

Provider 子树完成后，`completeWork` 会调用 `popProvider(context)`。

流程是：

```text
ContextProvider beginWork
  → pushProvider：设置当前值
  → 处理 children
  → completeWork
  → popProvider：恢复旧值
```

这和函数调用栈很像：进入作用域时压入新值，离开作用域时恢复旧值。

## useContext 如何读取值

`useContext(context)` 在简化实现里最终会走到 `readContext`：

```text
readContext(context)
  → return context._currentValue
```

这也是为什么 Provider 的 push/pop 必须和 Fiber 遍历顺序配合：

当子组件执行 `useContext` 时，它必须处在正确 Provider 的作用域里。

## Context 和 Hooks dispatcher 的关系

`useContext` 和 `useState` 一样，也是通过 dispatcher 转发：

```text
useContext
  → resolveDispatcher
  → dispatcher.useContext
  → readContext
```

所以它也必须在函数组件 render 期间调用。

脱离函数组件调用时，没有当前 dispatcher，也没有正在渲染的 Fiber 上下文。

## Context 的完整流程

```text
createContext(defaultValue)
  │
  ▼
创建 context 和 Provider 类型
  │
  ▼
<Context.Provider value={value}>
  │
  ▼
createFiberFromElement → ContextProvider Fiber
  │
  ▼
beginWork: pushProvider
  │
  ▼
子组件 renderWithHooks
  │
  ▼
useContext → readContext → context._currentValue
  │
  ▼
completeWork: popProvider
```

## 小结

1. `createContext` 创建 context 对象和特殊的 Provider 类型。
2. Provider 对应 `ContextProvider` Fiber，由 reconciler 特殊处理。
3. 进入 Provider 子树时 `pushProvider` 写入新值，离开时 `popProvider` 恢复旧值。
4. Provider 嵌套依赖栈结构保存历史值。
5. `useContext` 本质上读取当前 render 作用域中的 `context._currentValue`。
