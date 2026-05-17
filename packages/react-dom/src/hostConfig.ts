import { FiberNode } from 'react-reconciler/src/fiber';
import { HostText } from 'react-reconciler/src/workTags';
import { DOMElement, updateFiberProps } from './SyntheticEvent';
import { Props } from 'shared/ReactTypes';

export type Container = Element;
export type Instance = Element;
export type TextInstance = Text;

/**
 * hostConfig 是 reconciler 与具体宿主环境之间的适配层。
 *
 * 对 DOM renderer 来说，HostComponent 对应 Element，HostText 对应 Text。
 * reconciler 不直接调用 document.createElement，而是通过这些宿主方法完成创建、插入、删除和更新。
 */

/** 创建原生 DOM 节点，并把最新 props 缓存在节点上供事件系统读取。 */
export const createInstance = (type: string, props: Props): Instance => {
	// 处理props
	const element = document.createElement(type) as unknown;
	updateFiberProps(element as DOMElement, props);
	return element as DOMElement;
};

/** mount 阶段构建离屏 DOM 树时，将子 DOM 挂到父 DOM 下。 */
export const appendInitialChild = (
	parent: Instance | Container,
	child: Instance
) => {
	parent.appendChild(child);
};

/** 创建文本节点。 */
export const createTextInstance = (content: string) => {
	return document.createTextNode(content);
};

/** commit Placement 时追加节点到根容器或父 DOM。 */
export const appendChildToContainer = appendInitialChild;

/** commit Update 时根据 Fiber 类型执行具体宿主更新。 */
export function commitUpdate(fiber: FiberNode) {
	switch (fiber.tag) {
		case HostText:
			const text = fiber.memoizedProps.content;
			return commitTextUpdate(fiber.stateNode, text);
		default:
			if (__DEV__) {
				console.warn('未实现的Update类型', fiber);
			}
			break;
	}
}

/** 更新文本节点内容。 */
export function commitTextUpdate(textInstance: TextInstance, content: string) {
	textInstance.textContent = content;
}

/** 从宿主父节点中删除子节点。 */
export function removeChild(
	child: Instance | TextInstance,
	container: Container
) {
	container.removeChild(child);
}

/** 将 child 插入到 before 之前，用于处理 Placement 的插入/移动。 */
export function insertChildToContainer(
	child: Instance,
	container: Container,
	before: Instance
) {
	container.insertBefore(child, before);
}

/** 同步更新使用的微任务调度能力，优先 queueMicrotask，降级到 Promise 或 setTimeout。 */
export const scheduleMicroTask =
	typeof queueMicrotask === 'function'
		? queueMicrotask
		: typeof Promise === 'function'
			? (callback: (...args: any) => void) =>
					Promise.resolve(null).then(callback)
			: setTimeout;
