// 判断当前宿主环境是否支持 Symbol.for。支持时使用全局 Symbol，避免跨包判断失效。
const supportSymbol = typeof Symbol === 'function' && Symbol.for;

// ReactElement 的类型标记。
export const REACT_ELEMENT_TYPE = supportSymbol
	? Symbol.for('react.element')
	: 0xeac7;

// Fragment 的类型标记。
export const REACT_FRAGMENT_TYPE = supportSymbol
	? Symbol.for('react.fragment')
	: 0xeacb;

// Context 对象的类型标记。
export const REACT_CONTEXT_TYPE = supportSymbol
	? Symbol.for('react.context')
	: 0xeacc;

// Context.Provider 的类型标记。
export const REACT_PROVIDER_TYPE = supportSymbol
	? Symbol.for('react.provider')
	: 0xeac2;
