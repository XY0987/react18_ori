import {
	Container,
	appendInitialChild,
	createInstance,
	createTextInstance
} from 'hostConfig';
import { FiberNode } from './fiber';
import {
	ContextProvider,
	Fragment,
	FunctionComponent,
	HostComponent,
	HostRoot,
	HostText
} from './workTags';
import { NoFlags, Ref, Update } from './fiberFlags';
import { updateFiberProps } from 'react-dom/src/SyntheticEvent';
import { popProvider } from './fiberContext';

/** 标记当前 Fiber 在 commit mutation 阶段需要执行更新。 */
function markUpdate(fiber: FiberNode) {
	fiber.flags |= Update;
}

/** 标记当前 Fiber 在 commit 阶段需要处理 ref 解绑/绑定。 */
function markRef(fiber: FiberNode) {
	fiber.flags |= Ref;
}

/**
 * render 阶段的“归”阶段。
 *
 * completeWork 的核心职责：
 * - mount 时创建离屏 DOM 实例，并把子孙 DOM 挂到当前 DOM 上；
 * - update 时比较文本、ref 等变化并打 flags；
 * - 最后把子树 flags 冒泡到父 Fiber，方便 commit 阶段快速定位副作用。
 */
export const completeWork = (wip: FiberNode) => {
	// 递归中的归
	const newProps = wip.pendingProps;
	const current = wip.alternate;
	switch (wip.tag) {
		case HostComponent:
			// 构建离屏的dom树
			if (current !== null && wip.stateNode) {
				// update
				// 1. 判断props是否变化
				// 2. 变了打一个Update 标记
				updateFiberProps(wip.stateNode, newProps);
				if (current.ref !== wip.ref) {
					markRef(wip);
				}
			} else {
				//1. 构建DOM
				const instance = createInstance(wip.type, newProps);
				//2. 将DOM插入到DOM树中
				appendAllChildren(instance, wip);
				wip.stateNode = instance;
				// 标记ref
				if (wip.ref !== null) {
					markRef(wip);
				}
			}
			bubbleProperties(wip);
			return null;
		case HostText:
			// 构建离屏的dom树
			if (current !== null && wip.stateNode) {
				// update
				// 更新之前的文本值
				const oldText = current.memoizedProps.content;
				const newText = newProps.content;
				if (oldText !== newText) {
					// 标记更新
					markUpdate(wip);
				}
			} else {
				//1. 构建DOM
				const instance = createTextInstance(newProps.content);
				wip.stateNode = instance;
			}
			bubbleProperties(wip);
			return null;
		case HostRoot:
		case FunctionComponent:
		case Fragment:
			// 标记冒泡
			bubbleProperties(wip);
			return null;
		case ContextProvider:
			const context = wip.type._context;
			popProvider(context);
			// 标记冒泡
			bubbleProperties(wip);
			return null;
		default:
			if (__DEV__) {
				console.warn('未处理的completeWork情况');
			}
			break;
	}
};

// 将节点插入到parent中
function appendAllChildren(parent: Container, wip: FiberNode) {
	let node = wip.child;
	while (node !== null) {
		if (node.tag === HostComponent || node.tag === HostText) {
			appendInitialChild(parent, node.stateNode);
		} else if (node.child !== null) {
			node.child.return = node;
			node = node.child;
			continue;
		}

		if (node === wip) {
			return;
		}

		// 没有兄弟节点了
		while (node.sibling === null) {
			if (node.return === null || node.return == wip) {
				return;
			}
			// 没有兄弟节点之后往上找
			node = node?.return;
		}
		node.sibling.return = node.return;
		node = node.sibling;
	}
}

// 将子树的标记冒泡到父亲节点中
function bubbleProperties(wip: FiberNode) {
	let subtreeFlags = NoFlags;
	let child = wip.child;
	while (child !== null) {
		subtreeFlags |= child.subtreeFlags;
		subtreeFlags |= child.flags;

		child.return = wip;
		child = child.sibling;
	}

	wip.subtreeFlags |= subtreeFlags;
}
