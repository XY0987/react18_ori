import {
	Container,
	Instance,
	appendChildToContainer,
	commitUpdate,
	insertChildToContainer,
	removeChild
} from 'hostConfig';
import { FiberNode, FiberRootNode, PendingPassiveEffects } from './fiber';
import {
	ChildDeletion,
	Flags,
	LayoutMask,
	MutationMask,
	NoFlags,
	PassiveEffect,
	PassiveMask,
	Placement,
	Ref,
	Update
} from './fiberFlags';
import {
	FunctionComponent,
	HostComponent,
	HostRoot,
	HostText
} from './workTags';
import { Effect, FCUpdateQueue } from './fiberHooks';
import { HookHasEffect } from './hookEffectTags';

let nextEffect: FiberNode | null = null;

/**
 * commit 阶段通用副作用遍历器。
 *
 * render 阶段已经通过 bubbleProperties 把子树副作用汇总到 subtreeFlags。
 * 因此 commit 阶段可以先看 subtreeFlags：
 * - 子树有目标副作用，就继续向下找；
 * - 子树没有目标副作用，就执行当前 Fiber 的 callback，并尝试找兄弟或向上回溯。
 */
export const commitEffects = (
	phrase: 'mutation' | 'layout',
	mask: Flags,
	callback: (nextEffect: FiberNode, root: FiberRootNode) => void
) => {
	return (finishedWork: FiberNode, root: FiberRootNode) => {
		nextEffect = finishedWork;
		while (nextEffect !== null) {
			// 向下遍历
			const child: FiberNode | null = nextEffect.child;
			if ((nextEffect.subtreeFlags & mask) !== NoFlags && child !== null) {
				// 子节点存在，并且包含mutation阶段执行的操作
				nextEffect = child;
			} else {
				// 向上遍历
				up: while (nextEffect !== null) {
					callback(nextEffect, root);
					const sibling: FiberNode | null = nextEffect.sibling;
					if (sibling !== null) {
						nextEffect = sibling;
						break up;
					}
					nextEffect = nextEffect.return;
				}
			}
		}
	};
};

// export const commitMutationEffects = (
// 	finishedWork: FiberNode,
// 	root: FiberRootNode
// ) => {
// 	nextEffect = finishedWork;
// 	while (nextEffect !== null) {
// 		// 向下遍历
// 		const child: FiberNode | null = nextEffect.child;
// 		if (
// 			(nextEffect.subtreeFlags & (MutationMask | PassiveMask)) !== NoFlags &&
// 			child !== null
// 		) {
// 			// 子节点存在，并且包含mutation阶段执行的操作
// 			nextEffect = child;
// 		} else {
// 			// 向上遍历
// 			up: while (nextEffect !== null) {
// 				commitMutationEffectsOnFiber(nextEffect, root);
// 				const sibling: FiberNode | null = nextEffect.sibling;
// 				if (sibling !== null) {
// 					nextEffect = sibling;
// 					break up;
// 				}
// 				nextEffect = nextEffect.return;
// 			}
// 		}
// 	}
// };

/** mutation 阶段处理单个 Fiber 上的 DOM 类副作用。 */
const commitMutationEffectsOnFiber = (
	finishedWork: FiberNode,
	root: FiberRootNode
) => {
	const { flags, tag } = finishedWork;
	if ((flags & Placement) !== NoFlags) {
		// 当前节点存在placement操作
		commitPlacement(finishedWork);
		// 将placement标记移除
		finishedWork.flags &= ~Placement;
	}
	// 是否有Update
	if ((flags & Update) !== NoFlags) {
		// 当前节点存在Update操作
		commitUpdate(finishedWork);
		// 将Update标记移除
		finishedWork.flags &= ~Update;
	}
	// 是否有ChildDeletion
	if ((flags & ChildDeletion) !== NoFlags) {
		// 当前节点存在ChildDeletion操作
		const deletions = finishedWork.deletions;
		if (deletions !== null) {
			// 遍历数组执行删除操作
			deletions.forEach((childToDelete) => {
				commitDeletion(childToDelete, root);
			});
		}
		// 将ChildDeletion标记移除
		finishedWork.flags &= ~ChildDeletion;
	}
	if ((flags & PassiveEffect) !== NoFlags) {
		// useEffect 不在 mutation 阶段立即执行，这里只收集到 root.pendingPassiveEffects。
		commitPassiveEffect(finishedWork, root, 'update');
		finishedWork.flags &= ~PassiveEffect;
	}

	if ((flags & Ref) !== NoFlags) {
		// ref 的旧值先在 mutation 阶段解绑，新值会在 layout 阶段绑定。
		safelyDetachRef(finishedWork);
	}
};

function safelyDetachRef(current: FiberNode) {
	const ref = current.ref;
	if (ref !== null) {
		if (typeof ref === 'function') {
			ref(null);
		} else {
			ref.current = null;
		}
	}
}

const commitLayoutEffectsOnFiber = (
	finishedWork: FiberNode,
	root: FiberRootNode
) => {
	const { flags, tag } = finishedWork;
	if ((flags & Ref) !== NoFlags && tag === HostComponent) {
		// 绑定新的ref
		safelyAttachRef(finishedWork);
		finishedWork.flags &= ~Ref;
	}
};

function safelyAttachRef(fiber: FiberNode) {
	const ref = fiber.ref;
	if (ref !== null) {
		const instance = fiber.stateNode;
		if (typeof ref === 'function') {
			ref(instance);
		} else {
			ref.current = instance;
		}
	}
}

export const commitMutationEffects = commitEffects(
	'mutation',
	MutationMask | PassiveMask,
	commitMutationEffectsOnFiber
);

export const commitLayoutEffects = commitEffects(
	'layout',
	LayoutMask,
	commitLayoutEffectsOnFiber
);

/**
 * 收集 passive effect。
 *
 * useEffect 的 destroy/create 不会在 mutation 阶段同步执行，
 * 这里只把函数组件的 effect 环状链表挂到 root.pendingPassiveEffects，之后由 flushPassiveEffects 统一处理。
 */
function commitPassiveEffect(
	fiber: FiberNode,
	root: FiberRootNode,
	type: keyof PendingPassiveEffects
) {
	// update、unmount
	if (
		fiber.tag !== FunctionComponent ||
		(type === 'update' && (fiber.flags & PassiveEffect) === NoFlags)
	) {
		// 不存在依赖的情况
		return;
	}
	const updateQueue = fiber.updateQueue as FCUpdateQueue<any>;
	if (updateQueue !== null) {
		if (updateQueue.lastEffect === null && __DEV__) {
			console.error('当FC存在PassiveEffect flag时，不应该不存在effect');
		}
		root.pendingPassiveEffects[type].push(updateQueue.lastEffect as Effect);
	}
}

/** 遍历 effect 环状链表，只处理 tag 命中的 effect。 */
function commitHookEffectList(
	flags: Flags,
	lastEffect: Effect,
	callback: (effect: Effect) => void
) {
	let effect = lastEffect.next as Effect;
	do {
		if ((effect.tag & flags) === flags) {
			callback(effect);
		}
		effect = effect.next as Effect;
	} while (effect !== lastEffect.next);
}

// 组件卸载
export function commitHookEffectListUnmount(flags: Flags, lastEffect: Effect) {
	commitHookEffectList(flags, lastEffect, (effect) => {
		const destroy = effect.destroy;
		if (typeof destroy === 'function') {
			destroy();
		}
		// 执行了销毁，其以后都不会执行create，所以需要把标记移除
		effect.tag &= ~HookHasEffect;
	});
}

// useEffect返回了一个函数
export function commitHookEffectListDestroy(flags: Flags, lastEffect: Effect) {
	commitHookEffectList(flags, lastEffect, (effect) => {
		const destroy = effect.destroy;
		if (typeof destroy === 'function') {
			destroy();
		}
	});
}
// useEffect传入的回调
export function commitHookEffectListCreate(flags: Flags, lastEffect: Effect) {
	commitHookEffectList(flags, lastEffect, (effect) => {
		const create = effect.create;
		if (typeof create === 'function') {
			effect.destroy = create();
		}
	});
}

function recordHostChildrenToDelete(
	childrenToDelete: FiberNode[],
	unmountFiber: FiberNode
) {
	// 1. 找到第一个Root host节点
	const lastOne = childrenToDelete[childrenToDelete.length - 1];
	if (!lastOne) {
		childrenToDelete.push(unmountFiber);
	} else {
		// 不是第一个，把所有的兄弟节点都加入到对应数组中，之后统一删除（Fragment 相当于一个组件，需要把里边的节点都删除）
		let node = lastOne.sibling;
		while (node !== null) {
			if (unmountFiber === node) {
				childrenToDelete.push(unmountFiber);
			}
			node = node.sibling;
		}
	}
	// 2. 每找到一个 host 节点，判断它是否是第 1 步找到的那个节点的兄弟节点
}

/**
 * 删除子树。
 *
 * 需要做的不只是 removeChild：
 * - 找到子树中所有真实 Host 节点并从宿主父节点移除；
 * - 对 HostComponent 解绑 ref；
 * - 对 FunctionComponent 收集 unmount passive effect。
 */
function commitDeletion(childToDelete: FiberNode, root: FiberRootNode) {
	const rootChildrenToDelete: FiberNode[] = [];
	// 递归子树
	commitNestedComponent(childToDelete, (unmountFiber) => {
		switch (unmountFiber.tag) {
			case HostComponent:
				// if (rootHostNode === null) {
				// 	rootHostNode = unmountFiber;
				// }
				// 原本是一个节点，现在加入Fragment之后，可能是多个节点，需要都处理
				recordHostChildrenToDelete(rootChildrenToDelete, unmountFiber);
				// 解绑ref
				safelyDetachRef(unmountFiber);
				return;
			case HostText:
				// if (rootHostNode === null) {
				// 	rootHostNode = unmountFiber;
				// }
				recordHostChildrenToDelete(rootChildrenToDelete, unmountFiber);
				return;
			case FunctionComponent:
			// useEffect unmount 的处理：收集 unmount passive effect
			commitPassiveEffect(unmountFiber, root, 'unmount');
				return;
			default:
				if (__DEV__) {
					console.warn('未处理的unmount类型');
				}
				break;
		}
	});
	// 移除真实DOM
	if (rootChildrenToDelete.length) {
		const hostParent = getHostParent(childToDelete);
		if (hostParent !== null) {
			rootChildrenToDelete.forEach((node) => {
				removeChild(node.stateNode, hostParent);
			});
		}
	}
	// 删除之后重置标记
	childToDelete.return = null;
	childToDelete.child = null;
}

// 接收当前的一个节点和一个回调函数
function commitNestedComponent(
	root: FiberNode,
	onCommitUnmount: (fiber: FiberNode) => void
) {
	let node = root;
	while (true) {
		onCommitUnmount(node);
		if (node.child !== null) {
			// 向下遍历
			node.child.return = node;
			node = node.child;
			continue;
		}

		if (node === root) {
			// 终止条件
			return;
		}
		while (node.sibling === null) {
			if (node.return === null || node.return === root) {
				return;
			}
			// 向上归
			node = node.return;
		}
		node.sibling.return = node.return;
		node = node.sibling;
	}
}

/**
 * 执行 Placement：找到宿主父节点和稳定兄弟节点，然后插入真实 DOM。
 *
 * 注意 finishedWork 可能是函数组件或 Fragment，本身没有 DOM，
 * 所以后续 insertOrAppendPlacementNodeIntoContainer 会向下找到真正的 Host 节点。
 */
const commitPlacement = (finishedWork: FiberNode) => {
	if (__DEV__) {
		console.warn('执行Placement操作', finishedWork);
	}
	const hostParent = getHostParent(finishedWork);

	const sibling = getHostSibling(finishedWork);

	if (hostParent !== null) {
		insertOrAppendPlacementNodeIntoContainer(finishedWork, hostParent, sibling);
	}
};

/** 寻找可以作为 insertBefore 参照物的稳定宿主兄弟节点。 */
function getHostSibling(fiber: FiberNode) {
	let node: FiberNode = fiber;
	findSibling: while (true) {
		// 向上找（找父级的兄弟节点）
		while (node.sibling === null) {
			const parent = node.return;
			if (
				parent === null ||
				parent.tag === HostComponent ||
				parent.tag === HostRoot
			) {
				return;
			}
			node = parent;
		}
		node.sibling.return = node.return;
		node = node.sibling;
		while (node.tag !== HostText && node.tag !== HostComponent) {
			// 直接的兄弟节点不是一个元素而是一个组件，要向下遍历
			if ((node.flags & Placement) !== NoFlags) {
				// 如果标记移动的节点，不能作为插入的依据节点
				continue;
			}
			if (node.child === null) {
				continue findSibling;
			} else {
				node.child.return = node;
				node = node.child;
			}
		}
		if ((node.flags & Placement) === NoFlags) {
			return node.stateNode;
		}
	}
}

// 获取到当前节点的原生父节点
function getHostParent(fiber: FiberNode): Container | null {
	let parent = fiber.return;
	while (parent) {
		const parentTag = parent.tag;
		// HostComponent
		if (parentTag === HostComponent) {
			return parent.stateNode as Container;
		}
		if (parentTag === HostRoot) {
			return (parent.stateNode as FiberRootNode).container;
		}
		parent = parent.return;
	}
	if (__DEV__) {
		console.warn('未找到host parent');
	}
	return null;
}

// 将当前节点和兄弟节点都执行对应的操作
function insertOrAppendPlacementNodeIntoContainer(
	finishedWork: FiberNode,
	hostParent: Container,
	before?: Instance
) {
	if (finishedWork.tag === HostComponent || finishedWork.tag === HostText) {
		if (before) {
			insertChildToContainer(finishedWork.stateNode, hostParent, before);
		} else {
			// 是HostComponent节点或text节点，就插入
			appendChildToContainer(hostParent, finishedWork.stateNode);
		}
		return;
	}
	// 操作兄弟节点
	const child = finishedWork.child;
	if (child !== null) {
		insertOrAppendPlacementNodeIntoContainer(child, hostParent);
		let sibling = child.sibling;
		while (sibling !== null) {
			insertOrAppendPlacementNodeIntoContainer(sibling, hostParent);
			sibling = sibling.sibling;
		}
	}
}
