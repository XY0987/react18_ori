/*
React 合成事件的核心思路：
1. 事件不直接绑在每个 DOM 节点上，而是委托到根容器；
2. 真实事件触发后，从 target 向上收集捕获/冒泡阶段的回调；
3. 构造合成事件对象，按捕获 -> 冒泡的顺序执行；
4. 执行事件回调时切换到对应 Scheduler 优先级，让事件更新进入正确的 lane。
*/

import { Container } from 'hostConfig';
import {
	unstable_ImmediatePriority,
	unstable_NormalPriority,
	unstable_UserBlockingPriority,
	unstable_runWithPriority
} from 'scheduler';
import { Props } from 'shared/ReactTypes';

export const elementPropsKey = '__props';

// 支持的事件
const validEventTypeList = ['click'];

type EventCallback = (e: Event) => void;

interface SyntheticEvent extends Event {
	__stopPropagation: boolean;
}

interface Paths {
	capture: EventCallback[];
	bubble: EventCallback[];
}

export interface DOMElement extends Element {
	[elementPropsKey]: Props;
}

/**
 * 将最新 props 缓存在 DOM 节点上。
 *
 * commit 阶段更新 DOM props 后，事件系统才能从真实事件 target 上读到最新的事件回调。
 */
export function updateFiberProps(node: DOMElement, props: Props) {
	node[elementPropsKey] = props;
}

/** 在根容器上注册事件委托监听。 */
export function initEvent(container: Container, eventType: string) {
	if (!validEventTypeList.includes(eventType)) {
		console.warn(`当前不支持${eventType}事件`);
		return;
	}
	if (__DEV__) {
		console.log('初始化事件', eventType);
	}
	container.addEventListener(eventType, (e) => {
		dispatchEvent(container, eventType, e);
	});
}

/** 构造合成事件，并接管 stopPropagation，保证 React 自己的事件流也能被中断。 */
function createSyntheticEvent(e: Event) {
	const syntheticEvent = e as SyntheticEvent;
	syntheticEvent.__stopPropagation = false;
	const originStopPropagation = e.stopPropagation;

	syntheticEvent.stopPropagation = () => {
		syntheticEvent.__stopPropagation = true;
		if (originStopPropagation) {
			originStopPropagation();
		}
	};
	return syntheticEvent;
}

function dispatchEvent(container: Container, eventType: string, e: Event) {
	const targetElement = e.target;
	if (targetElement === null) {
		console.warn('事件不存在target', e);
		return;
	}

	// 从真实 target 向上收集 React props 上声明的捕获/冒泡回调。
	const { bubble, capture } = collectPaths(
		targetElement as DOMElement,
		container,
		eventType
	);
	// 构造合成事件
	const se = createSyntheticEvent(e);
	//遍历captue
	triggerEventFlow(capture, se);
	// 遍历bubble,__stopPropagation为false时
	if (!se.__stopPropagation) {
		// 遍历bubble
		triggerEventFlow(bubble, se);
	}
}

/** 按给定顺序执行事件回调，并为事件更新设置对应 Scheduler 优先级。 */
function triggerEventFlow(paths: EventCallback[], se: SyntheticEvent) {
	for (let i = 0; i < paths.length; i++) {
		const callback = paths[i];
		unstable_runWithPriority(eventTypeToSchdulerPriority(se.type), () => {
			callback.call(null, se);
		});
		// 阻止事件传播
		if (se.__stopPropagation) {
			break;
		}
	}
}

function getEventCallbackNameFromEventType(
	eventType: string
): string[] | undefined {
	return {
		// 第零项是捕获阶段，第一项是冒泡阶段
		click: ['onClickCapture', 'onClick']
	}[eventType];
}

/**
 * 从 target 向 container 回溯，收集捕获和冒泡回调。
 *
 * 捕获阶段执行顺序是从外到内，所以使用 unshift；
 * 冒泡阶段执行顺序是从内到外，所以使用 push。
 */
function collectPaths(
	targetElement: DOMElement,
	container: Container,
	eventType: string
) {
	const paths: Paths = {
		capture: [],
		bubble: []
	};

	while (targetElement && targetElement !== container) {
		const elementProps = targetElement[elementPropsKey];
		if (elementProps) {
			// click=>onClick onClickCapture
			const callbackNameList = getEventCallbackNameFromEventType(eventType);
			if (callbackNameList) {
				callbackNameList.forEach((callbackName, i) => {
					const eventCallback = elementProps[callbackName];
					if (eventCallback) {
						if (i === 0) {
							// 捕获（反向插入）
							paths.capture.unshift(eventCallback);
						} else {
							paths.bubble.push(eventCallback);
						}
					}
				});
			}
		}
		// 收集过程
		targetElement = targetElement.parentNode as DOMElement;
	}
	return paths;
}

function eventTypeToSchdulerPriority(eventType: string) {
	switch (eventType) {
		case 'click':
		case 'keydown':
		case 'keyup':
			return unstable_ImmediatePriority;
		case 'scroll':
			return unstable_UserBlockingPriority;
		default:
			return unstable_NormalPriority;
	}
}
