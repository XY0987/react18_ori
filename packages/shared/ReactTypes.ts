export type Type = any;
export type Key = any;
export type Ref = { current: any } | ((instance: any) => void);
export type Props = any;

export type ElementType = any;

/** JSX/createElement 产出的 ReactElement 数据结构。 */
export interface ReactElementType {
	/** 标识这是 ReactElement，而不是普通对象。 */
	$$typeof: symbol | number;
	/** 元素类型：字符串表示宿主节点，函数表示函数组件，也可能是 Provider 等特殊类型。 */
	type: ElementType;
	/** diff 时用于同级节点复用。 */
	key: Key;
	/** 传给组件或宿主节点的属性。 */
	props: Props;
	/** commit 阶段绑定宿主实例。 */
	ref: Ref;
	/** 当前学习实现的调试标记。 */
	__mark: string;
}

/** setState 支持传值或函数式更新。 */
export type Action<State> = State | ((prevState: State) => State);

/** createContext 返回的 Context 对象。 */
export type ReactContext<T> = {
	$$typeof: symbol | number;
	Provider: ReactProviderType<T> | null;
	_currentValue: T;
};

/** Context.Provider 对应的特殊 React 类型。 */
export type ReactProviderType<T> = {
	$$typeof: symbol | number;
	_context: ReactContext<T> | null;
};
