> 前言：前 18 篇已经拆解了这份简版 React 18 源码的核心模块。这一篇不再把重点放在“某个函数怎么跑”，而是回到一个更重要的问题：**从这份源码里，能真实看出哪些 React 设计哲学？**
>
> 注意，这篇文章分析的是本仓库这份学习版实现，不是完整 React 18 源码。它更适合回答：当我们亲手实现 Fiber、Lane、Hooks、render/commit、HostConfig 之后，能从中学到哪些框架设计方法。

配套源码仓库：`https://github.com/XY0987/react18_ori.git`

## 系列导航

- 上一篇：[18：源码阅读路线与调试指南](./18-React18源码阅读路线与调试指南.md)
- 系列总览：[00：系列总览](./00-系列总览.md)

---

## 一、先校准：这份源码到底实现了什么

谈设计哲学之前，必须先把边界说清楚。否则很容易把“完整 React 的哲学”误套到“简版源码”上。

这份源码已经实现的核心能力：

| 能力 | 当前源码中的体现 | 设计意义 |
|---|---|---|
| ReactElement | `packages/react/src/jsx.ts`、`createElement` | 把 JSX 转成普通 JS 对象，作为 UI 描述 |
| Fiber 树 | `FiberNode`、`FiberRootNode` | 把 UI 树变成可遍历、可暂停、可复用的工作单元 |
| 双缓冲 | `current.alternate`、`createWorkInProgress` | 在旧树与新树之间切换，避免直接修改当前 UI |
| Lane | `SyncLane`、`DefaultLane`、`TransitionLane` | 把更新优先级编码成数据 |
| 调度入口 | `scheduleUpdateOnFiber`、`ensureRootIsSchedule` | 更新不是立即执行，而是先进入调度系统 |
| render/commit | `renderRoot`、`commitRoot` | 计算阶段和副作用阶段分离 |
| Hooks | `useState`、`useEffect`、`useTransition`、`useRef`、`useContext` | 用链表和 dispatcher 支撑函数组件状态 |
| UpdateQueue | 环状链表 + `baseQueue` | 支持批量更新、优先级跳过与恢复 |
| Context | Provider 栈、`readContext` | 用栈处理嵌套上下文值 |
| HostConfig | `createInstance`、`appendChild`、`commitUpdate` 等 | 协调器与 DOM 操作分离 |
| 合成事件 | 根节点事件委托、事件优先级 | 事件触发更新时可以带上不同调度优先级 |

但它没有完整实现这些能力：

| 未实现或不完整 | 当前现状                                                     |
|---|---|
| `useReducer`、`useMemo`、`useCallback`、`useLayoutEffect` | 未实现 |
| `React.memo`、完整 bailout | 未实现了完整“跳过子树优化” |
| Class Component、Error Boundary、Suspense | 未实现错误恢复、Suspense 并发能力                            |
| 完整 Scheduler 包 | 当前是依赖外部 `scheduler`，不是自己实现完整调度器 |
| 完整跨平台渲染器 | 有 HostConfig 思想，但当前主要落地在 DOM renderer |
| 完整 React 18 concurrent features | 这份源码演示了时间切片和 `useTransition` 雏形，不等于完整 React 18 |

所以这篇文章的核心立场是：

> **不要把简版源码拔高成完整 React；但也不要低估简版源码。它已经足够展示 React 最关键的运行时架构思想：把 UI 更新变成可调度、可中断、可提交的工作。**

---

## 二、先看完整链路：一次更新到底发生了什么

这份源码最值得抓住的主线，不是“Fiber 是什么”或者“Lane 是什么”，而是：

> 用户触发一次更新后，React 并不立刻操作 DOM，而是把更新包装成任务，经过优先级选择、Fiber render、commit 提交，最后才修改宿主环境。

```text
用户写 JSX
   ↓
jsx / createElement
   ↓
ReactElement：UI 的普通对象描述
   ↓
createRoot(container).render(element)
   ↓
updateContainer
   ↓
createUpdate(element, lane)
   ↓
enqueueUpdate：进入 HostRoot 的 updateQueue
   ↓
scheduleUpdateOnFiber
   ↓
ensureRootIsSchedule：根据 lane 选择同步微任务或 Scheduler 并发任务
   ↓
renderRoot
   ↓
beginWork：向下计算子 Fiber
   ↓
completeWork：向上创建 DOM / 收集 flags
   ↓
commitRoot
   ↓
commitMutationEffects / commitLayoutEffects / passive effects
   ↓
真实 DOM 更新
```

这条链路体现的核心思想是：

> **React 不是一个“调用组件然后立刻改 DOM”的渲染函数，而是一个“更新调度系统”。**

这也是本文后面所有设计哲学的出发点。

---

## 三、这份源码真正体现出的八个设计哲学

### 哲学一：UI 先被描述，再被执行

React 的第一步不是创建 DOM，而是创建 ReactElement。

JSX 最终会变成类似这样的对象：

```ts
{
  $$typeof: REACT_ELEMENT_TYPE,
  type,
  key,
  ref,
  props
}
```

这件事看起来简单，但意义很大：

> UI 被转成普通对象后，React 才能比较它、延迟处理它、丢弃它、重新生成它，甚至把它交给不同 renderer 处理。

如果 JSX 直接操作 DOM，后面的 Fiber、Lane、Diff、调度都没有空间存在。

所以，“声明式 UI”在源码中的第一层落点不是口号，而是：

```text
JSX → ReactElement → Fiber → Host 操作
```

这给框架设计者的启示是：

> 当你想让一个系统具备调度、优化、跨平台能力时，第一步通常是引入一个中间描述层。不要让用户意图直接落到最终执行环境。

---

### 哲学二：更新不是命令，而是可调度的任务

在这份源码中，`setState` 或 `root.render` 都不是“马上重新渲染”。它们最终会创建一个带 `lane` 的 update，然后进入调度入口。

核心链路是：

```text
createUpdate(action, lane)
   ↓
enqueueUpdate(queue, update)
   ↓
scheduleUpdateOnFiber(fiber, lane)
   ↓
ensureRootIsSchedule(root)
```

`Lane` 的存在说明：一次更新不只是“要不要更新”，还包含“这次更新有多紧急”。

比如这份源码里有：

```ts
SyncLane
InputContinuousLane
DefaultLane
TransitionLane
IdleLane
```

然后通过 `getHighestPriorityLane(root.pendingLanes)` 取出当前最该执行的更新。

这体现了 React 很关键的哲学：

> 用户负责表达“状态变了”，React 负责决定“什么时候处理这个变化”。

这比“数据驱动 UI”更贴近源码。`UI = f(state)` 是应用层心智模型；而源码层真正复杂的地方，是 React 要保留更新的调度权。

框架设计启示：

> 如果一个系统未来需要批处理、优先级、中断、恢复，就不要把 API 设计成“调用即执行”。应该把调用先变成任务，再由统一调度层处理。

---

### 哲学三：Fiber 的本质是把递归渲染拆成工作单元

如果直接递归渲染组件树，调用栈由 JS 引擎控制，中途很难暂停、恢复或切换优先级。

Fiber 做的事情是把原本隐式的递归调用栈，变成显式的数据结构：

```text
return  → 父 Fiber
child   → 第一个子 Fiber
sibling → 下一个兄弟 Fiber
```

这样 React 就可以自己控制遍历过程。

这份源码里的 `performUnitOfWork` 就体现了这个思想：

```text
beginWork 当前 Fiber
   ↓
如果有 child，继续处理 child
   ↓
如果没有 child，进入 completeUnitOfWork
   ↓
找 sibling
   ↓
没有 sibling 就回到 return
```

Fiber 的意义不只是“多了一棵树”，而是：

> **把渲染过程从不可控的函数递归，变成 React 自己可管理的任务链表/树遍历。**

这也是为什么 Fiber 能服务于时间切片和并发渲染。

框架设计启示：

> 当你需要暂停、恢复、重试一个过程时，不要依赖语言调用栈，而要把执行过程显式建模成数据结构。

---

### 哲学四：双缓冲不是为了炫技，而是为了不污染当前 UI

这份源码中，一个逻辑节点最多有两份 Fiber：

```text
current         当前页面正在使用的 Fiber 树
workInProgress 本轮 render 正在构建的新 Fiber 树
```

二者通过 `alternate` 互相指向。

`createWorkInProgress(current, pendingProps)` 的逻辑是：

1. 如果 `current.alternate` 不存在，就创建一份新的 Fiber；
2. 如果存在，就复用 alternate；
3. 清理上一轮的 `flags`、`subtreeFlags`、`deletions`；
4. 从 current 拷贝必要状态到 workInProgress。

这个设计最重要的意义是：

> render 阶段永远在 workInProgress 上计算，不直接破坏 current。只有 commit 成功后，`root.current = finishedWork`，新树才成为当前树。

所以双缓冲同时服务两个目标：

| 目标 | 说明 |
|---|---|
| 正确性 | render 中断或失败时，不影响当前屏幕 |
| 性能 | alternate 可复用，减少重复分配 |

但要注意：当前简版源码还没有完整 bailout，所以不能夸张地说“分配量已经降到 O(changes)”。更准确的说法是：

> 双缓冲减少了重复创建整棵 Fiber 壳子的成本，也为中断和恢复提供了结构基础；但没有完整 bailout 时，每次更新仍然会遍历相当多的节点。

框架设计启示：

> 如果一次计算不能直接覆盖旧结果，就用“双版本”结构：稳定版本对外可见，工作版本内部计算，提交成功后再切换引用。

---

### 哲学五：render 阶段只做计划，commit 阶段才做副作用

这份源码最重要的架构边界是：

```text
render 阶段：构建 workInProgress 树，计算 state，diff 子节点，收集 flags
commit 阶段：根据 flags 操作 DOM，绑定 ref，执行 effect
```

`renderRoot` 可以同步执行，也可以在并发模式下根据 `shouldYield` 让出主线程。

这要求 render 阶段尽量保持“可丢弃”：

- 它可以被暂停；
- 它可以被更高优先级更新打断；
- 它可以重新开始；
- 它不应该产生用户可见副作用。

而 `commitRoot` 是不可中断的，因为它真的会修改宿主环境。

这体现了 React 的一个核心设计：

> **把“决定要做什么”和“真正做”拆开。前者可以反复计算，后者必须一次性提交。**

这也是 `flags` 的价值。`Placement`、`Update`、`ChildDeletion`、`PassiveEffect` 等 flag 就像 render 阶段生成的“提交指令”。

框架设计启示：

> 如果你要设计一个可中断系统，必须把过程拆成“可撤销的计算阶段”和“不可撤销的提交阶段”。不要在计算过程中偷偷执行副作用。

---

### 哲学六：Lane 不是单纯位运算，而是把优先级数据化

旧文章容易把 Lane 写成“位运算技巧”。这不够准确。

位运算只是实现手段，Lane 真正表达的是：

> 不同更新有不同紧急程度，React 要能合并它们、比较它们、跳过它们、在之后恢复它们。

这份源码里，Lane 通过二进制位表示集合：

```text
SyncLane            0b00001
InputContinuousLane 0b00010
DefaultLane         0b00100
TransitionLane      0b01000
IdleLane            0b10000
```

常见操作包括：

```text
mergeLanes(a, b)        → a | b
getHighestPriorityLane  → lanes & -lanes
isSubsetOfLanes         → (set & subset) === subset
markRootFinished        → pendingLanes &= ~lane
```

它们背后的哲学是：

> 把调度策略压缩进数据结构，让“谁先执行、谁被跳过、谁等待下次”都能用统一规则处理。

这在 `UpdateQueue` 里尤其明显：低优先级 update 不会被丢掉，而是进入 `baseQueue`，等到后续合适的 `renderLane` 再处理。

框架设计启示：

> 如果系统里存在“优先级 + 批处理 + 跳过 + 恢复”，优先级不应该只是一个临时参数，而应该成为贯穿系统的数据模型。

---

### 哲学七：Hooks 用顺序约束换取 API 简洁

这份源码中的 Hooks 很能体现 React 的务实设计。

函数组件每次执行时，Hooks 按调用顺序形成一条链表：

```text
fiber.memoizedState
   ↓
Hook(useState)
   ↓
Hook(useEffect)
   ↓
Hook(useRef)
   ↓
...
```

mount 阶段创建 Hook 链表；update 阶段按上一次的顺序读取旧 Hook，再克隆出本轮新的 Hook。

这里要修正一个容易误解的说法：

> update 阶段不是简单“复用 mount 时创建的 Hook 对象”，而是按旧 Hook 顺序创建本轮 Hook 节点，并复用旧 Hook 中的 `memoizedState`、`updateQueue`、`baseState`、`baseQueue` 等信息。

这解释了为什么 Hooks 不能写在条件语句里：

```tsx
if (condition) {
  useState(0);
}
useEffect(() => {}, []);
```

一旦条件变化，Hook 顺序就变了，React 就无法知道“这次的第一个 Hook”对应上次哪一个 Hook。

这不是 React 文档随便规定的风格，而是当前实现方式暴露出来的 API 约束。

框架设计启示：

> 好的 API 不一定隐藏所有约束。有些实现约束如果能换来简单 API，可以直接上升为使用规则，再用 lint 或运行时错误保护它。

---

### 哲学八：Reconciler 与 HostConfig 分离，让核心算法不绑定 DOM

这份源码虽然主要实现的是 DOM renderer，但已经有了 Reconciler / HostConfig 分离的影子。

协调器关心的是：

```text
Fiber 怎么建
子节点怎么 diff
flags 怎么收集
更新怎么调度
commit 阶段什么时候调用宿主操作
```

DOM renderer 关心的是：

```text
createInstance 怎么创建 DOM
appendChild 怎么插入 DOM
commitUpdate 怎么更新 DOM props
removeChild 怎么删除 DOM
```

这说明 React 的核心价值并不只是“操作 DOM”，而是：

> 用一套组件模型和协调算法，驱动不同宿主环境。

框架设计启示：

> 当核心算法和具体执行环境变化频率不同，就应该通过接口切开。算法层保持稳定，宿主层按平台替换。

---

## 四、和 React 官方设计原则的对应关系

React 官方的 `Design Principles` 里有很多原则。不是每一条都能在这份简版源码中完整体现。下面这张表更准确地说明：哪些体现了，哪些只是部分体现，哪些当前还没有体现。

| 官方原则 | 在这份源码中的体现 | 当前边界 |
|---|---|---|
| Composition 组合 | ReactElement、children、函数组件、Fragment、Context | 没有完整组件生态、memo、forwardRef 等 |
| Scheduling 调度 | Lane、`scheduleUpdateOnFiber`、`ensureRootIsSchedule`、时间切片 | Scheduler 依赖外部包，优先级模型是简版 |
| Beyond the DOM 超越 DOM | Reconciler 与 HostConfig 分离 | 当前主要只有 DOM renderer |
| Escape Hatches 逃生舱 | `ref`、`useRef`、`useEffect`、事件系统 | 没有 `useImperativeHandle`、`forwardRef`、完整 layout effect |
| Implementation 实现务实 | 位运算、链表、全局 dispatcher、flags | 代码偏学习演示，不是完整工业级实现 |
| Debugging 可调试性 | Fiber 上保留 props/state/updateQueue 等结构 | 没有 DevTools、完整 warning 体系 |
| Common Abstraction 公共抽象 | Hooks、Context、合成事件雏形 | 抽象数量有限，未覆盖完整 React API |
| Stability 稳定性 | 当前源码没有重点体现 | 没有 deprecation、代码迁移脚本、版本迁移机制 |
| Interoperability 互操作 | DOM ref、事件委托能与宿主环境交互 | 没有完整渐进接入、hydrate 等能力 |
| Tooling 工具化 | JSX runtime 提供结构化 element | 没有 lint、代码迁移脚本、DevTools 支撑 |
| Configuration 反全局配置 | 当前没有全局配置 API | 不是本仓库重点 |
| 自用驱动 自用驱动 | 当前没有体现 | 属于 React 团队工程组织层面的原则 |

这张表说明：

> 这份源码最能体现的官方哲学是 Scheduling、Beyond the DOM、Implementation、部分 Composition 和 Escape Hatches。其他原则不应该强行从源码里拔高出来。

但“当前没有实现”不等于“不值得学”。恰恰相反，React 官方设计原则里很多最有价值的东西，并不是靠某一个函数体现出来的，而是体现在一个框架如何长期演进、如何服务大型项目、如何在理想模型和真实业务之间做取舍。

---

## 五、官方源码里值得学，但本仓库还没有完整实现的设计哲学

这一节专门补充上表里没有展开的部分。它们不是当前简版源码的直接能力，但如果你想从“实现一个玩具 React”走向“设计一个长期可维护的框架”，这些原则非常重要。

### 1. Composition：组件不只是函数，而是可组合的行为单元

本仓库已经实现了函数组件、`children`、Fragment、Context，这些能体现组合的基础形态。但官方 React 对 Composition 的理解更深：

> 组件不是“返回 UI 的函数”这么简单，而是一个可以组合渲染、状态、生命周期、副作用、ref、数据依赖的行为单元。

这背后的学习点是：

```text
低层理解：组件 = props => ReactElement
高层理解：组件 = 可组合的 UI 行为边界
```

为什么 React 一直保留 state、effect、ref 这些能力？因为真实业务里的组件并不只是纯渲染，它还要处理：

- 自己的局部状态；
- 挂载和卸载时的资源申请与释放；
- 和宿主环境交互；
- 和第三方库协作；
- 把复杂行为封装起来供别人组合。

所以，学习 Composition 时，不要只停留在“组件树可以嵌套”。更关键的是：

> 好的组件模型，应该允许一个组件在内部增加状态、副作用或资源管理能力时，不迫使它的调用方跟着改。

这也是为什么 React 会把 Hook 状态挂到 Fiber 上，把 effect 收集到 commit 阶段，把 ref 纳入统一提交流程。它们都在保护一个目标：**组件内部可以变复杂，但组件外部的组合方式尽量稳定。**

如果未来要增强本仓库，可以从这些方向体现 Composition：

- 补 `forwardRef`，让 ref 能穿透组件边界；
- 补 `memo`，让组件组合时可以表达“这个边界可缓存”；
- 补 `useReducer`，让复杂状态逻辑可以封装在组件内部；
- 补自定义 Hook 示例，展示行为复用不是靠继承，而是靠组合函数。

### 2. Common Abstraction：不是所有功能都该进核心，只有公共问题才值得内建

当前仓库为了学习，把核心路径实现得比较集中：Element、Fiber、Hooks、Context、事件、HostConfig 都在框架里。但官方 React 的设计原则并不是“功能越多越好”，而是非常克制：

> 能在用户层可靠实现的能力，不轻易放进核心；但如果大量用户会用不兼容、低效、难以协作的方式重复实现同一个能力，React 才考虑把它内建。

这就是 `Common Abstraction` 的关键。

比如 state、生命周期、Hooks、Context、合成事件为什么适合进 React？因为它们会影响 React 自己的调度、提交、调试和组合模型。如果每个库都自己实现一套状态或生命周期抽象，React 就无法统一理解这些更新，也无法统一调度。

学习点是：

```text
能不能实现，不是判断一个能力是否进核心的标准。
真正的问题是：
这个能力是否需要框架统一理解、统一优化、统一约束？
```

这对设计自己的框架很重要。比如：

| 能力 | 更适合放在哪里 | 判断理由 |
|---|---|---|
| 状态更新队列 | 框架核心 | 影响调度、批处理、优先级 |
| 生命周期 / effect | 框架核心 | 影响 commit 时机和资源释放 |
| 路由 | 通常可在用户层 | 不一定影响底层协调算法 |
| 表单校验 | 通常可在用户层 | 业务差异大，核心不应绑定 |
| 事件归一化 | 可进核心或 renderer | 和宿主环境、优先级相关 |

所以，本仓库后续不是“补越多 API 越好”，而应该思考：

> 这个 API 如果不进核心，用户能不能稳定实现？如果用户自己实现，会不会破坏调度、提交或组合模型？

### 3. Escape Hatches：声明式是默认路径，但不能堵死命令式出口

本仓库已经有 `ref`、`useRef`、`useEffect`，这说明它已经具备一点 Escape Hatch 的味道。但官方 React 对逃生舱的态度更完整：

> React 鼓励声明式，但不要求所有问题都必须声明式表达。真实业务里总有一些场景需要命令式 API。

比如：

- 聚焦一个输入框；
- 测量 DOM 尺寸；
- 接入图表、地图、编辑器等命令式第三方库；
- 控制动画播放；
- 暴露组件内部的少量命令式方法。

这些场景如果强行声明式化，API 反而会变得别扭。所以 React 提供了 refs、effects、imperative handle 等逃生舱。

学习点是：

```text
理想模型负责覆盖 80% 场景；
逃生舱负责让剩下 20% 场景不用逃离框架。
```

逃生舱设计最难的地方，不是“能不能暴露命令式 API”，而是“暴露到什么边界为止”。一个好的逃生舱应该：

- 默认不打扰声明式主路径；
- 只在必要时使用；
- 生命周期受框架管理；
- 不破坏调度和提交顺序；
- 能在未来迁移到更好的 API。

如果未来增强本仓库，建议按这个顺序补：

1. `useLayoutEffect`：让“DOM 已变更后、浏览器绘制前”的同步逃生舱更明确；
2. `forwardRef`：让 ref 能跨过函数组件边界；
3. `useImperativeHandle`：限制暴露给外部的命令式能力，而不是直接泄漏内部 DOM。

这样文章里讲 Escape Hatches 就会更扎实。

### 4. Stability：稳定不是永不改变，而是变化时有迁移路径

本仓库是学习项目，不需要考虑大规模用户迁移，所以没有实现 deprecation warning、版本策略、代码迁移脚本。但官方 React 非常重视 Stability。

这里最值得学的一句话是：

> 稳定不是“不变化”，而是“变化时有清晰、最好自动化的迁移路径”。

这和很多人理解的 API 稳定不一样。真正的大型框架不可能永远不改 API，因为旧设计会阻碍新能力。但它也不能随意 breaking change，因为用户代码量太大。

React 的做法通常是：

```text
发现旧模式的问题
   ↓
在开发环境加 warning
   ↓
观察影响范围
   ↓
提供替代方案
   ↓
必要时提供代码迁移脚本
   ↓
下一个 major 再改变行为
```

这背后的框架设计启示是：

> API 设计不是一次性的。你要同时设计“今天怎么用”和“明天怎么迁移”。

如果把这个思想迁移到本仓库，哪怕只是学习项目，也可以学习这些做法：

- 对不支持的用法给明确错误，而不是静默失败；
- 对未来要废弃的 API 先给 warning；
- 把错误信息写得可搜索；
- 在文档里说明替代路径；
- 如果有批量改法，提供脚本。

这类能力不属于 reconciler 主流程，但它决定一个框架能不能长期演进。

### 5. Interoperability：框架不应该假设自己接管整个世界

本仓库当前通过 DOM ref、事件委托、HostConfig 和宿主环境交互，但还没有完整体现官方 React 的 Interoperability。

官方 React 很重视渐进接入：你可以只在一个老页面的小区域里使用 React，而不是重写整个应用。这背后有一个很现实的判断：

> 大型系统很少能被一次性重写。好框架必须允许局部采用、局部替换、和旧系统长期共存。

这和源码有什么关系？关系很大。

为了互操作，框架要避免太多全局假设：

- 不应该要求整个页面只有一个 React root；
- 不应该要求所有 DOM 都由 React 创建；
- 事件系统要能挂在某个 root 容器上，而不是污染整个页面；
- ref 要能让用户接触宿主实例；
- hydrate 要允许接管服务端已有 markup；
- unmount 要能干净释放资源。

这也是为什么 `createRoot(container)` 这个 API 很重要：React 的工作边界是一个 container，而不是整个页面。

本仓库可以学习的方向：

- 支持多个 root 并存时事件委托互不干扰；
- 补 `unmount`，确保 effect、ref、DOM 都能释放；
- 补 hydration 的最小模型，理解 React 如何接管已有 DOM；
- 在 HostConfig 层更清楚地区分“创建节点”和“接管已有节点”。

Interoperability 的本质是：

> 框架能力越强，越要克制自己的控制范围。能局部工作，才有机会进入真实大型项目。

### 6. Developer Experience 与 Debugging：源码不只为机器执行，也要为人排错

本仓库目前已经把 `pendingProps`、`memoizedProps`、`memoizedState`、`updateQueue`、`flags` 等信息挂在 Fiber 上，这对理解和调试很有帮助。但官方 React 在 DX 和 Debugging 上做得远不止这些。

React 官方很看重两个问题：

1. 用户写错时，能不能尽早发现？
2. UI 出错时，能不能沿着 props/state 找到源头？

这就是为什么 React 会有开发环境 warning、React DevTools、组件树检查、Hooks 规则 lint、错误提示等。

学习点是：

```text
框架不是只要“运行正确”就够了。
框架还要帮助用户在“不正确”时快速定位问题。
```

从源码设计角度看，Debugging 要求框架保留足够多的“面包屑”：

- Fiber 上保留组件类型；
- Fiber 上保留 props 和 state；
- Hook 状态挂在组件对应 Fiber 上，而不是藏在用户闭包里；
- updateQueue 能追踪状态从哪里来；
- effect 的创建和销毁有明确阶段；
- 开发环境能区分常见错误并给出具体提示。

本仓库后续可以补的学习点：

- Hook 顺序错误时，提示当前组件名和可能原因；
- key 缺失或重复时给 warning；
- 非法嵌套、非法 ref、非法 Hook 调用给更明确提示；
- 提供一个简单的调试打印工具，把 Fiber 树格式化输出；
- 在开发环境保留更多源码位置信息。

这类能力看似“不影响主流程”，但它们是框架从玩具走向工程工具的关键。

### 7. Configuration：反对全局运行时配置，是为了保护组合性

本仓库没有 `React.configure()` 这类全局配置 API，这一点虽然不是刻意设计，但刚好可以引出 React 官方的 Configuration 原则。

React 反对全局运行时配置，是因为全局配置会破坏组合性。想象一个页面里有两个 React 应用，或者一个第三方组件库也调用了全局配置：

```text
应用 A 希望配置 X = true
应用 B 希望配置 X = false
第三方组件库默认改了 X
```

这时谁说了算？组件还能不能独立组合？很难。

所以 React 更倾向于：

- 构建期配置，比如 development / production build；
- 局部 API，比如某个 root、某个组件、某个 Provider；
- 显式参数，而不是隐藏的全局开关。

学习点是：

> 如果一个配置会影响组件行为，就要警惕它是否破坏“组件可以独立组合”的前提。

对本仓库来说，未来如果要加配置，也应该优先考虑：

| 想加的能力 | 更好的设计 |
|---|---|
| 开关调试日志 | build flag 或 dev-only 分支 |
| 改变 root 行为 | 放到 `createRoot(container, options)` |
| 跨树传值 | 用 Context，而不是全局变量 |
| renderer 差异 | 用 HostConfig，而不是全局 if/else |

这个原则特别适合框架作者记住：

> 全局配置写起来最简单，但长期最容易破坏组合和复用。

### 8. Optimized for Tooling：API 名字、JSX、错误信息都要方便工具理解

本仓库已经有 JSX runtime，但还没有系统体现“为工具优化”的设计。官方 React 很重视这一点。

React 的很多 API 名字故意很长，比如：

- `componentDidMount`
- `dangerouslySetInnerHTML`
- `useSyncExternalStore`

这不是啰嗦，而是为了：

- 搜索方便；
- code review 时显眼；
- lint 规则容易写；
- 代码迁移脚本 更安全；
- 大规模迁移时减少误伤。

JSX 也不仅是语法糖。它给工具一个明确的信号：这里是一棵 React element tree。于是工具可以做：

- 静态检查；
- 自动插入 source 信息；
- 常量元素提升；
- 组件使用分析；
- 代码迁移脚本 自动迁移。

学习点是：

```text
好的框架 API 不只给人调用，也给工具识别。
```

如果本仓库未来要体现这个方向，可以做：

- 在 `jsxDEV` 中记录 `__source`、`__self`；
- 给 warning 设计稳定、可搜索的错误码；
- 提供简单 lint 规则或文档说明 Hooks 规则；
- 在文档中把内部 tag、flag、lane 的含义整理成调试表；
- 保持 API 命名明确，而不是过度缩写。

工具化的价值在小项目里不明显，但在大型代码库里非常关键。React 官方把它作为设计原则，是因为框架一旦进入大型团队，API 就不只是运行时接口，也是静态分析和自动迁移的锚点。

### 9. Implementation：优雅 API 背后，可以是“不优雅但可靠”的实现

本仓库现在已经能看到这一点：Fiber、flags、Hook 链表、全局 dispatcher、Lane 位运算都不是“概念上最优雅”的实现，但它们直接、有效、性能好。

官方 React 对 Implementation 的态度非常务实：

> API 尽量优雅；内部实现优先正确、性能和开发体验。必要时，把丑陋留在框架内部，不要推给用户。

这点非常值得学。很多人在写框架时容易反过来：内部抽象很漂亮，用户 API 很复杂。React 的取舍正好相反。

比如 Hooks 的实现并不“纯”：

- 依赖全局 `currentDispatcher`；
- 依赖当前正在 render 的 Fiber；
- 依赖 Hook 调用顺序；
- 用链表保存状态；
- mount/update 使用不同 dispatcher。

但换来的用户 API 很简单：

```tsx
const [count, setCount] = useState(0);
useEffect(() => {}, []);
```

学习点是：

> 框架作者应该愿意在内部承担复杂性，换取用户侧的简单性。但内部复杂性必须是必要的，不能为了炫技而抽象。

本仓库继续优化时也应该坚持这个标准：

- 不要为了“架构漂亮”提前拆太多层；
- 不要为了复用写难以理解的抽象；
- 学习源码尤其应该让主流程清楚；
- 真正影响能力边界的地方，再抽象成公共机制。

### 10. 自用驱动：框架方向来自真实使用，而不是想象中的完美设计

自用驱动不太可能在本仓库中直接实现，因为它是 React 团队和产品实践层面的原则。但它仍然非常值得学。

它的意思是：React 的很多优先级来自真实产品长期使用，而不是纯理论推演。

这对个人学习源码也有启发：

> 不要只问“这个设计优不优雅”，还要问“它解决了什么真实问题”。

比如：

- Fiber 是为了解决大树更新阻塞主线程的问题；
- Lane 是为了解决不同更新紧急程度不同的问题；
- effect 是为了解决组件资源管理的问题；
- ref 是为了解决声明式难以表达的宿主操作问题；
- 代码迁移脚本是为了解决大规模代码迁移问题。

如果未来继续维护这个简版 React，可以用“自用驱动”的方式学习：

1. 不要只跑 demo，要写几个稍微复杂的真实例子；
2. 用它写表单、列表、弹窗、动画、异步请求；
3. 看哪里最难用、哪里最容易出 bug；
4. 再决定下一个要补的源码能力。

这比“照着 React API 清单一个个补”更接近真实框架演进。

---

## 六、从这份源码提炼出的框架设计法则

### 法则 1：先把用户意图对象化

ReactElement 是用户意图的对象化结果。

```text
用户写 JSX，不直接创建 DOM，而是创建 UI 描述对象。
```

一旦意图变成对象，框架就可以：

- 缓存；
- 比较；
- 延迟；
- 丢弃；
- 转换；
- 交给不同执行环境。

### 法则 2：不要让 API 调用直接等于执行

`setState` 不应该等于“马上改 DOM”。

更好的链路是：

```text
API 调用 → Update 对象 → Queue → Scheduler → Render → Commit
```

这样未来才能加入批处理、优先级和中断。

### 法则 3：把不可控调用栈变成可控数据结构

Fiber 的价值不是“树”，而是“可保存的工作单元”。

```text
函数递归：控制权在 JS 调用栈
Fiber 遍历：控制权在 React workLoop
```

需要中断和恢复时，显式数据结构比隐式调用栈更可靠。

### 法则 4：计算阶段不要偷偷做副作用

render 阶段只生成结果和 flags；commit 阶段统一执行副作用。

这条原则不只适合 UI 框架，也适合：

- 编译器：先生成 IR，再输出代码；
- 数据库：先生成执行计划，再执行；
- 状态管理：先计算 next state，再通知订阅者。

### 法则 5：优先级应该进入数据模型

如果优先级只是函数参数，很容易在系统中散落。

Lane 的好处是：

```text
Update 有 lane
Root 有 pendingLanes
Render 有 renderLane
Queue 能根据 lane 跳过或消费 update
Commit 后能 markRootFinished
```

优先级贯穿了整个更新生命周期。

### 法则 6：实现约束可以变成 API 规则

Hooks 的顺序约束来自链表实现。

React 没有为了支持“任意条件调用 Hook”而把实现复杂化，而是选择：

```text
API 规则：Hooks 必须稳定顺序调用
实现收益：Hook 查找不需要名字、不需要 key、不需要额外注册表
```

这是很典型的框架设计取舍。

### 法则 7：用接口隔离变化频率不同的部分

Reconciler 的变化慢，Host 环境的变化快。

所以把 DOM 操作收敛到 HostConfig，是非常自然的切分。

```text
稳定层：Fiber / Diff / Hooks / Lane / Scheduler
变化层：DOM / Native / Canvas / 小程序 / 其他宿主环境
```

即使当前源码只实现 DOM，这个切分也已经能体现框架设计价值。

---

## 七、一句话总结

> **React 用声明式 API 接收用户意图，再把意图转换成带优先级的更新任务；通过 Fiber 把渲染过程拆成可中断的工作单元，通过 render/commit 分离保证计算可丢弃、提交可控，最后用 HostConfig 把核心协调算法和宿主环境隔离。**

它不是完整 React 18，但已经足够展示 React 最关键的运行时思想：

```text
描述 UI
  ↓
生成更新
  ↓
调度优先级
  ↓
构建 workInProgress
  ↓
收集副作用
  ↓
一次性提交
```

从这份源码里最应该带走的，不是“React 用了哪些数据结构”，而是：

> **当一个框架想同时追求声明式、可预测、可中断、可扩展时，它必须把用户意图、更新优先级、执行过程和副作用提交都显式建模。**

这才是这份简版 React 源码最值得学习的设计哲学。
