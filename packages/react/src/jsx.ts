import { REACT_ELEMENT_TYPE, REACT_FRAGMENT_TYPE } from 'shared/ReactSymbols';
import {
	Type,
	Key,
	Ref,
	Props,
	ReactElementType,
	ElementType
} from 'shared/ReactTypes';

// 定义一个生成元素的构造方法
const ReactElement = function (
	type: Type,
	key: Key,
	ref: Ref,
	props: Props
): ReactElementType {
	// 定义一个元素
	const element = {
		// 使用$$typeof字段来标记当前数据结构是一个react元素
		$$typeof: REACT_ELEMENT_TYPE,
		type,
		key,
		ref,
		props,
		// 用于区别react，是自己写的
		__mark: 'myReact'
	};
	return element;
};

export function isValidElement(object: any) {
	return (
		typeof object === 'object' &&
		object !== null &&
		object.$$typeof === REACT_ELEMENT_TYPE
	);
}

/**
 * JSX runtime 入口。
 *
 * 编译器会把 `<div id="a">hello</div>` 转成 jsx(type, config, children) 调用。
 * key/ref 是 React 的保留字段，不会放入 props；其余字段都会收集到 props 中。
 */
export const jsx = function (
	type: ElementType,
	config: any,
	...maybeChildren: any
) {
	// 单独处理key和ref
	let key: Key = null;
	const props: Props = {};
	let ref: Ref = null;
	// 遍历config，把遍历到的每个对象都赋值给props对象
	for (const prop in config) {
		const val = config[prop];
		// 处理key
		if (prop === 'key') {
			if (val !== undefined) {
				key = '' + val;
			}
			continue;
		}
		// 处理ref
		if (prop === 'ref') {
			if (val !== undefined) {
				ref = val;
			}
			continue;
		}
		// 查看是否是自己身上的props，而不是原型上的
		if ({}.hasOwnProperty.call(config, prop)) {
			props[prop] = val;
		}
	}
	const maybeChildrenLenth = maybeChildren.length;
	// 长度大于0，表示有多余的children
	if (maybeChildrenLenth) {
		if (maybeChildrenLenth === 1) {
			// 如果只有一个children，直接赋值返回
			props.children = maybeChildren[0];
		} else {
			// 有多个children
			props.children = maybeChildren;
		}
	}
	return ReactElement(type, key, ref, props);
};

export const Fragment = REACT_FRAGMENT_TYPE;

// 把开发环境和生产环境使用的jsx方法定为一个
export const jsxDEV = function (type: ElementType, config: any) {
	// 单独处理key和ref
	let key: Key = null;
	const props: Props = {};
	let ref: Ref = null;
	// 遍历config，把遍历到的每个对象都赋值给props对象
	for (const prop in config) {
		const val = config[prop];
		// 处理key
		if (prop === 'key') {
			if (val !== undefined) {
				key = '' + val;
			}
			continue;
		}
		// 处理ref
		if (prop === 'ref') {
			if (val !== undefined) {
				ref = val;
			}
			continue;
		}
		// 查看是否是自己身上的props，而不是原型上的
		if ({}.hasOwnProperty.call(config, prop)) {
			props[prop] = val;
		}
	}
	return ReactElement(type, key, ref, props);
};
