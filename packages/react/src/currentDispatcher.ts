/*
Hooks dispatcher 共享层。

React 对外暴露的 useState/useEffect 等 API 并不直接实现 Hook 逻辑，
而是通过 currentDispatcher.current 转发到当前渲染阶段对应的 dispatcher。
这也是 Hook 只能在函数组件渲染期间调用的根本原因：脱离 renderWithHooks 时 dispatcher 为 null。
*/

import { Action, ReactContext } from 'shared/ReactTypes';

export interface Dispatcher {
	useState: <T>(initialState: (() => T) | T) => [T, Dispatch<T>];
	useEffect: (callback: () => void | void, deps: any[] | void) => void;
	useTransition: () => [boolean, (callback: () => void) => void];
	useRef: <T>(initialValue: T) => { current: T };
	useContext: <T>(context: ReactContext<T>) => T;
}

export type Dispatch<State> = (action: Action<State>) => void;

const currentDispatcher: { current: Dispatcher | null } = {
	current: null
};

// 用于方便地获取到 dispatcher
export const resolveDispatcher = (): Dispatcher => {
	const dispatcher = currentDispatcher.current;
	// dispatcher 的值是 null 的话，表明没有在函数组件上下文中执行
	if (dispatcher === null) {
		throw new Error('hook只能在函数组件中执行');
	}
	return dispatcher;
};

export default currentDispatcher;
