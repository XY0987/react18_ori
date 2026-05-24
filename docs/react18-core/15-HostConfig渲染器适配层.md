> 前言：React 的 reconciler 本身并不关心目标平台是 DOM、Native 还是别的宿主环境。它只负责算出 Fiber 树和副作用，真正创建、插入、删除宿主节点的能力来自 renderer 提供的 HostConfig。

配套源码仓库：`https://github.com/XY0987/react18_ori.git`

## 系列导航

- 上一篇：[14：从 JSX 到 ReactElement 再到 Fiber](./14-JSX到ReactElement再到Fiber.md)
- 下一篇：[16：Scheduler、同步队列与时间切片](./16-Scheduler同步队列与时间切片.md)

## 为什么需要 HostConfig

React 可以有不同 renderer：

| renderer | 宿主环境 |
|----------|----------|
| `react-dom` | 浏览器 DOM |
| `react-native` | 原生平台视图 |
| 自定义 renderer | Canvas、终端、小游戏等 |

如果 reconciler 里直接写死 `document.createElement`，那它就只能服务浏览器。

所以更合理的设计是：

```text
react-reconciler
  → 调用抽象宿主方法
  → 具体 renderer 提供实现
```

在 DOM renderer 里，这层适配就是 `hostConfig.ts`。

## HostConfig 在主流程里的位置

把它放进完整链路里：

```text
ReactElement
  → Fiber
  → render 阶段 completeWork
  → HostConfig 创建离屏 DOM
  → commit 阶段 commitWork
  → HostConfig 插入/删除/更新 DOM
```

也就是说，HostConfig 会在两个阶段被使用：

| 阶段 | 调用 HostConfig 做什么 |
|------|------------------------|
| render 阶段 | 创建 DOM 实例、文本节点，构建离屏 DOM 树 |
| commit 阶段 | 插入、删除、更新真实 DOM |

## createInstance：创建 DOM 节点

当 `completeWork` 遇到 `HostComponent` 的 mount 场景时，会调用：

```text
createInstance(type, props)
```

对于 DOM renderer 来说，它做的是：

```text
document.createElement(type)
updateFiberProps(element, props)
```

这里除了创建 DOM，还会把 props 缓存在 DOM 节点上。

为什么要缓存 props？

因为合成事件系统需要从真实事件 target 上找到最新的 `onClick`、`onClickCapture` 等回调。

## createTextInstance：创建文本节点

文本节点没有 props，也没有 children。

它对应：

```text
document.createTextNode(content)
```

在 update 场景下，如果文本内容变了，`completeWork` 会给 Fiber 打 `Update` 标记，commit 阶段再调用 `commitTextUpdate` 修改 `textContent`。

## appendInitialChild：构建离屏 DOM 树

render 阶段的 DOM 创建是离屏的。

比如：

```tsx
<div>
  <span>hello</span>
</div>
```

completeWork 从叶子节点往上执行：

```text
createTextInstance('hello')
createInstance('span')
appendInitialChild(span, text)
createInstance('div')
appendInitialChild(div, span)
```

此时 DOM 节点之间已经连好了，但还没插入页面容器。

这就是为什么 render 阶段可以构建 DOM，但不直接影响页面。

## appendChildToContainer 和 insertChildToContainer

commit 阶段处理 `Placement` 时，需要把 DOM 插入宿主父节点。

有两种情况：

| 方法 | 场景 |
|------|------|
| `appendChildToContainer` | 没有稳定兄弟节点，追加到末尾 |
| `insertChildToContainer` | 找到了稳定兄弟节点，插入到它前面 |

这对应 DOM API：

```text
parent.appendChild(child)
parent.insertBefore(child, before)
```

插入/移动节点时，React 要先通过 `getHostParent` 找父节点，再通过 `getHostSibling` 找插入参照物。

## removeChild：删除 DOM

处理 `ChildDeletion` 时，React 会先遍历要删除的 Fiber 子树，找到其中所有真实 Host 节点。

最后通过 HostConfig 删除：

```text
container.removeChild(child)
```

为什么不直接删当前 Fiber？

因为当前 Fiber 可能是函数组件或 Fragment，它们自己没有 DOM。真正需要删除的是它们子树里的 HostComponent 或 HostText。

## commitUpdate：更新宿主节点

简化实现里，`commitUpdate` 主要处理文本节点：

```text
HostText
  → commitTextUpdate
  → textInstance.textContent = content
```

完整 React DOM renderer 会处理更多内容，比如 className、style、事件 props、表单属性等。

但核心思想一样：reconciler 只告诉 renderer “这个 Fiber 有 Update”，具体怎么更新宿主实例，由 renderer 决定。

## scheduleMicroTask：同步更新的微任务能力

HostConfig 里还提供了 `scheduleMicroTask`。

SyncLane 更新会进入同步任务队列，然后通过微任务 flush：

```text
scheduleSyncCallback(performSyncWorkOnRoot)
scheduleMicroTask(flushSyncCallbacks)
```

优先使用：

```text
queueMicrotask
  → Promise.resolve().then
  → setTimeout
```

这样同一轮事件里的多次同步更新可以先入队，再统一执行。

## HostConfig 的价值

HostConfig 的价值可以总结为一句话：

> reconciler 负责“算”，renderer 负责“落地”。

```text
react-reconciler
  │
  ├─ Fiber / diff / lane / workLoop
  │
  ▼
hostConfig
  │
  ├─ createInstance
  ├─ appendChildToContainer
  ├─ removeChild
  └─ commitUpdate
```

这种分层让 React 的核心协调逻辑可以复用到不同平台。

## 小结

1. HostConfig 是 reconciler 和宿主环境之间的适配层。
2. render 阶段通过 HostConfig 创建离屏 DOM 树。
3. commit 阶段通过 HostConfig 插入、删除、更新真实 DOM。
4. 函数组件和 Fragment 没有 DOM，插入/删除时要向下找 Host 节点。
5. HostConfig 让 reconciler 可以保持平台无关。
