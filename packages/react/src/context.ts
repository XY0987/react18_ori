import { REACT_CONTEXT_TYPE, REACT_PROVIDER_TYPE } from 'shared/ReactSymbols';
import { ReactContext } from 'shared/ReactTypes';

/**
 * 创建 Context 对象。
 *
 * Context 本体保存当前值 _currentValue；Provider 是一个特殊 React 类型，
 * reconciler 在遇到 Provider Fiber 时会把 props.value 写入对应 context。
 */
export function createContext<T>(defaultValue: T): ReactContext<T> {
	const context: ReactContext<T> = {
		$$typeof: REACT_CONTEXT_TYPE,
		Provider: null,
		_currentValue: defaultValue
	};
	context.Provider = {
		$$typeof: REACT_PROVIDER_TYPE,
		_context: context
	};
	return context;
}
