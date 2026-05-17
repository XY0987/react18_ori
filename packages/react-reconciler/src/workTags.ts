export type WorkTag =
	| typeof FunctionComponent
	| typeof HostRoot
	| typeof HostComponent
	| typeof HostText
	| typeof Fragment
	| typeof ContextProvider;

// 函数组件 Fiber，对应 function App() {}。
export const FunctionComponent = 0;
// 整棵 Fiber 树的根节点，对应 FiberRootNode.current。
export const HostRoot = 3;
// 原生宿主节点，在 DOM renderer 中对应 div/span 等 DOM Element。
export const HostComponent = 5;
// 文本节点，在 DOM renderer 中对应 Text。
export const HostText = 6;

// Fragment 本身不产生宿主节点，只承载一组 children。
export const Fragment = 7;

// Context.Provider 对应的 Fiber 类型。
export const ContextProvider = 8;
