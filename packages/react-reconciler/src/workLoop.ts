import { scheduleMicroTask } from 'hostConfig';
import { beginWork } from './beginWork';
import {
	commitHookEffectListCreate,
	commitHookEffectListDestroy,
	commitHookEffectListUnmount,
	commitLayoutEffects,
	commitMutationEffects
} from './commitWork';
import { completeWork } from './completeWork';
import {
	FiberNode,
	FiberRootNode,
	createWorkInProgress,
	PendingPassiveEffects
} from './fiber';
import { MutationMask, NoFlags, PassiveMask } from './fiberFlags';
import {
	Lane,
	NoLane,
	SyncLane,
	getHighestPriorityLane,
	lanesToSchedulerPriority,
	markRootFinished,
	mergeLanes
} from './fiberLanes';
import { flushSyncCallbacks, scheduleSyncCallback } from './syncTaskQueue';
import { HostRoot } from './workTags';

import {
	unstable_scheduleCallback as scheduleCallback,
	unstable_NormalPriority as NormalPriority,
	unstable_shouldYield,
	unstable_cancelCallback
} from 'scheduler';
import { HookHasEffect, Passive } from './hookEffectTags';

// 指向当前正在执行的 workInProgress Fiber，render 阶段会不断移动这个指针。
let workInProgress: FiberNode | null;
// 本轮 render 正在处理的优先级。
let wipRootRenderLane: Lane = NoLane;

// 避免同一个 root 的 passive effect 被重复调度。
let rootDoesHasPassiveEffects: boolean = false;
// renderRoot 的退出状态：并发模式下可能未完成就让出主线程。
const RootInComplete = 1;
const RootCompleted = 2;

/**
 * 为一次新的 render 准备 workInProgress 栈。
 *
 * workInProgress 是 current 树的 alternate。render 阶段会在这棵树上计算新状态、创建子 Fiber、收集 flags。
 */
function prepareFreshStack(root: FiberRootNode, lane: Lane) {
	root.finishedLane = NoLane;
	root.finishedWork = null;
	workInProgress = createWorkInProgress(root.current, {});
	wipRootRenderLane = lane;
}

/**
 * 更新调度入口。
 *
 * 不管更新来自 createRoot().render、setState、useTransition，最终都会走到这里：
 * 1. 从触发更新的 Fiber 向上找到 FiberRootNode；
 * 2. 把本次 lane 合并到 root.pendingLanes；
 * 3. 根据最高优先级安排同步微任务或 Scheduler 并发任务。
 */
export function scheduleUpdateOnFiber(fiber: FiberNode, lane: Lane) {
	const root = markUpdateFromFiberToRoot(fiber);
	markRootUpdated(root, lane);
	ensureRootIsSchedule(root);
}

/**
 * schedule 阶段入口：只负责“安排什么时候执行”，不直接做 render。
 *
 * SyncLane 走微任务队列，保证尽快同步刷新；其他 lane 交给 Scheduler，允许时间切片和中断恢复。
 */
function ensureRootIsSchedule(root: FiberRootNode) {
	const updateLane = getHighestPriorityLane(root.pendingLanes);
	const existingCallback = root.callbackNode;

	if (updateLane === NoLane) {
		// 没有待处理更新时，清理已存在的调度回调。
		if (existingCallback !== null) {
			unstable_cancelCallback(existingCallback);
		}
		root.callbackNode = null;
		root.callbackPriority = NoLane;
		return;
	}
	const curPriority = updateLane;
	const prevPriority = root.callbackPriority;

	// 已经有同优先级任务在队列中，无需重复调度。
	if (curPriority === prevPriority) {
		return;
	}

	if (existingCallback !== null) {
		unstable_cancelCallback(existingCallback);
	}
	let newCallbackNode = null;
	if (updateLane === SyncLane) {
		if (__DEV__) {
			console.log('在微任务中调度，优先级:', updateLane);
		}
		scheduleSyncCallback(performSyncWorkOnRoot.bind(null, root));
		// 多次同步更新会先进入同一个 syncQueue，再由一次微任务统一 flush。
		scheduleMicroTask(flushSyncCallbacks);
	} else {
		const schedulerPeriority = lanesToSchedulerPriority(updateLane);
		newCallbackNode = scheduleCallback(
			schedulerPeriority,
			// @ts-ignore
			performConcurrentWorkOnRoot.bind(null, root)
		);
	}
	root.callbackNode = newCallbackNode;
	root.callbackPriority = curPriority;
}

function markRootUpdated(root: FiberRootNode, lane: Lane) {
	root.pendingLanes = mergeLanes(root.pendingLanes, lane);
}

// 找到根节点
function markUpdateFromFiberToRoot(fiber: FiberNode) {
	let node = fiber;
	let parent = node.return;
	while (parent !== null) {
		node = parent;
		parent = node.return;
	}
	if (node.tag === HostRoot) {
		return node.stateNode;
	}
	return null;
}

/** 并发更新入口：可以被 Scheduler 中断，并在下一帧继续执行。 */
function performConcurrentWorkOnRoot(
	root: FiberRootNode,
	didTimeout: boolean
): any {
	// passive effect 中可能触发更高优先级更新，因此正式 render 前先 flush 一次。
	const didFlushPassiveEffect = flushPassiveEffects(root.pendingPassiveEffects);
	const curCallback = root.callbackNode;
	if (didFlushPassiveEffect) {
		// 如果 flush passive effect 导致当前任务被更高优先级任务替换，直接退出。
		if (root.callbackNode !== curCallback) {
			return null;
		}
	}

	const lane = getHighestPriorityLane(root.pendingLanes);
	const curCallbackNode = root.callbackNode;
	if (lane === NoLane) {
		return null;
	}
	const needSync = lane === SyncLane || didTimeout;
	const exitStatus = renderRoot(root, lane, !needSync);

	ensureRootIsSchedule(root);

	if (exitStatus === RootInComplete) {
		// 时间片用尽但任务没完成：如果没有被更高优先级任务替换，就返回 continuation 继续调度。
		if (root.callbackNode !== curCallbackNode) {
			return null;
		}
		return performConcurrentWorkOnRoot.bind(null, root);
	}
	if (exitStatus === RootCompleted) {
		const finishedWork = root.current.alternate;
		root.finishedWork = finishedWork;
		root.finishedLane = lane;
		wipRootRenderLane = NoLane;
		commitRoot(root);
	} else if (__DEV__) {
		console.error('还未实现的并发更新结束状态');
	}
}

/** 同步更新入口：不会让出主线程，一次性完成 render 并进入 commit。 */
function performSyncWorkOnRoot(root: FiberRootNode) {
	// 同一批同步更新可能多次入队，这里再次确认 root 上最高优先级仍然是 SyncLane。
	const nextLane = getHighestPriorityLane(root.pendingLanes);
	if (nextLane !== SyncLane) {
		ensureRootIsSchedule(root);
		return;
	}

	const exitStatus = renderRoot(root, nextLane, false);
	if (exitStatus === RootCompleted) {
		const finishedWork = root.current.alternate;
		root.finishedWork = finishedWork;
		root.finishedLane = nextLane;
		wipRootRenderLane = NoLane;
		commitRoot(root);
	} else if (__DEV__) {
		console.log('还未实现同步更新结束状态');
	}
}

/**
 * render 阶段总入口。
 *
 * render 阶段只在内存中构建 workInProgress 树并收集 flags，不会修改真实 DOM。
 * shouldTimeSlice 为 true 时使用 workLoopConcurrent，循环中会通过 shouldYield 判断是否让出主线程。
 */
function renderRoot(root: FiberRootNode, lane: Lane, shouldTimeSlice: boolean) {
	if (__DEV__) {
		console.log(`开始${shouldTimeSlice ? '并发' : '同步'}更新`, root);
	}
	if (wipRootRenderLane !== lane) {
		// 初始化
		prepareFreshStack(root, lane);
	}
	do {
		try {
			shouldTimeSlice ? workLoopConcurrent() : workLoopSync();
			break;
		} catch (error) {
			if (__DEV__) {
				console.warn('workLoop发生错误', error);
			}
			workInProgress = null;
		}
	} while (true);

	// 中断执行||render阶段执行完了
	if (shouldTimeSlice && workInProgress !== null) {
		// 中断了但是还没有执行完
		return RootInComplete;
	}

	if (!shouldTimeSlice && workInProgress !== null && __DEV__) {
		console.error('render阶段结束时，wip应该是null');
	}

	return RootCompleted;
}

/**
 * commit 阶段入口。
 *
 * render 阶段完成后，finishedWork 是一棵带 flags 的 workInProgress 树。
 * commit 阶段不可中断，主要做三件事：
 * 1. mutation：根据 Placement/Update/ChildDeletion 等 flags 修改宿主环境；
 * 2. 切换 root.current，让新 Fiber 树成为 current 树；
 * 3. layout/passive：执行 ref、useEffect 等副作用。
 */
function commitRoot(root: FiberRootNode) {
	// 表示有标记的fiber树
	const finishedWork = root.finishedWork;
	if (finishedWork === null) {
		// commit阶段不存在
		return;
	}
	if (__DEV__) {
		console.warn('commit阶段开始', finishedWork);
	}

	const lane = root.finishedLane;

	if (lane === NoLane && __DEV__) {
		console.warn('commit阶段finishedLane不应该是NoLane');
	}

	// 重置
	root.finishedWork = null;
	root.finishedLane = NoLane;

	// 移除已经完成的lane
	markRootFinished(root, lane);

	// 判断是否要执行effect
	if (
		(finishedWork.flags & PassiveMask) !== NoFlags ||
		(finishedWork.subtreeFlags & PassiveMask) !== NoFlags
	) {
		// 防止多次触发调度时，多次执行该操作
		if (!rootDoesHasPassiveEffects) {
			rootDoesHasPassiveEffects = true;
			// passive effect 不阻塞 DOM 提交，提交后以 NormalPriority 异步执行。
			scheduleCallback(NormalPriority, () => {
				console.log('root.pendingPassiveEffects', root.pendingPassiveEffects);
				// 执行副作用
				flushPassiveEffects(root.pendingPassiveEffects);
				return;
			});
		}
	}

	// 判断是否存在3个子阶段需要执行的操作
	// 判断root flags root subtreeFlags
	const subtreeHasEffect =
		(finishedWork.subtreeFlags & MutationMask) !== NoFlags;

	const rootHasEffect = (finishedWork.flags & MutationMask) !== NoFlags;

	if (subtreeHasEffect || rootHasEffect) {
		// beforeMutation阶段
		// mutation阶段

		commitMutationEffects(finishedWork, root);
		// mutation 完成后切换双缓冲树，此后页面对应的 current 就是 finishedWork。
		root.current = finishedWork;
		// layout阶段
		commitLayoutEffects(finishedWork, root);
	} else {
		root.current = finishedWork;
	}

	rootDoesHasPassiveEffects = false;
	ensureRootIsSchedule(root);
}

/** 按 React 的语义顺序 flush passive effect：卸载 destroy -> 更新 destroy -> 更新 create。 */
function flushPassiveEffects(pendingPassiveEffects: PendingPassiveEffects) {
	// 当前是否有回调要执行
	let didFlushPassiveEffect = false;

	// 先执行destroy回调
	pendingPassiveEffects.unmount.forEach((effect) => {
		didFlushPassiveEffect = true;
		commitHookEffectListUnmount(Passive, effect);
	});
	pendingPassiveEffects.unmount = [];

	pendingPassiveEffects.update.forEach((effect) => {
		didFlushPassiveEffect = true;
		commitHookEffectListDestroy(Passive | HookHasEffect, effect);
	});
	pendingPassiveEffects.update.forEach((effect) => {
		didFlushPassiveEffect = true;
		commitHookEffectListCreate(Passive | HookHasEffect, effect);
	});
	pendingPassiveEffects.update = [];
	// effect 执行过程中可能触发同步更新，这里顺手 flush 掉。
	flushSyncCallbacks();
	return didFlushPassiveEffect;
}

/** 同步工作循环：不判断时间片，直到整棵 workInProgress 树处理完。 */
function workLoopSync() {
	while (workInProgress !== null) {
		performUnitOfWork(workInProgress);
	}
}

/** 并发工作循环：每处理一个 Fiber 单元后检查是否需要让出主线程。 */
function workLoopConcurrent() {
	while (workInProgress !== null && !unstable_shouldYield()) {
		performUnitOfWork(workInProgress);
	}
}

/**
 * 执行一个 Fiber 工作单元。
 *
 * beginWork 是“递”阶段：根据当前 Fiber 计算/复用子 Fiber。
 * 如果没有子 Fiber，说明当前分支已经到底，立刻进入 completeUnitOfWork 的“归”阶段。
 */
function performUnitOfWork(fiber: FiberNode) {
	// 可能是fiber的子fiber也可能是null
	const next = beginWork(fiber, wipRootRenderLane);
	fiber.memoizedProps = fiber.pendingProps;
	if (next === null) {
		completeUnitOfWork(fiber);
	} else {
		workInProgress = next;
	}
}

/**
 * completeWork 是“归”阶段：创建/更新宿主实例，并向父级冒泡 subtreeFlags。
 *
 * 完成当前节点后优先找兄弟节点；没有兄弟节点就继续向父节点归并，直到回到 HostRoot。
 */
function completeUnitOfWork(fiber: FiberNode) {
	// 如果有子节点就遍历子节点，没有子节点，就遍历兄弟节点
	let node: FiberNode | null = fiber;
	do {
		completeWork(node);
		const sibling = node.sibling;
		if (sibling !== null) {
			workInProgress = sibling;
			return;
		}
		node = node.return;
		workInProgress = node;
	} while (node !== null);
}
