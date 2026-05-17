import { Dispatch, Dispatcher } from 'react/src/currentDispatcher';
import { FiberNode } from './fiber';
// internals是数据共享层中shared的引入(指向的是react的数据共享层)
import internals from 'shared/internals';
import currentBatchConfig from 'react/src/currentBatchConfig';
import {
	Update,
	UpdateQueue,
	createUpdate,
	createUpdateQueue,
	enqueueUpdate,
	processUpdateQueue
} from './updateQueue';
import { Action, ReactContext } from 'shared/ReactTypes';
import { scheduleUpdateOnFiber } from './workLoop';
import { Lane, NoLane, requestUpdateLane } from './fiberLanes';
import { Flags, PassiveEffect } from './fiberFlags';
import { HookHasEffect, Passive } from './hookEffectTags';

// 当前正在执行的函数组件 Fiber。只有 renderWithHooks 期间它才有值。
let currentlyRenderingFiber: FiberNode | null = null;
// 指向 workInProgress Hook 链表中当前正在构建的 Hook。
let workInProgressHook: Hook | null = null;

// update 阶段用于遍历 current Hook 链表，保证本次 Hook 顺序与上次一致。
let currentHook: Hook | null = null;

const { currentDispatcher } = internals;

let renderLane: Lane = NoLane;
interface Hook {
	/** 当前 Hook 保存的值：useState 是 state，useEffect 是 effect，useRef 是 ref 对象。 */
	memoizedState: any;
	/** useState 的 updateQueue 或其他 Hook 需要保存的队列。 */
	updateQueue: unknown;
	/** 下一个 Hook，函数组件的所有 Hook 通过 next 串成单链表。 */
	next: Hook | null;
	/** 跳过低优先级更新后，下次重新计算的基础 state。 */
	baseState: any;
	/** 本次 render 因优先级不足而跳过的 update 队列。 */
	baseQueue: Update<any> | null;
}

/**
 * useEffect 也会形成一条独立的环状链表。
 *
 * 注意这里的 next 指向下一个 effect，Hook.next 指向下一个 Hook，二者是两条不同链表。
 */
export interface Effect {
	tag: Flags;
	create: EffectCallback | void;
	destroy: EffectCallback | void;
	deps: EffectDeps;
	next: Effect | null;
}

export interface FCUpdateQueue<State> extends UpdateQueue<State> {
	// 指向effect链表中的最后一个
	lastEffect: Effect | null;
}

type EffectCallback = () => void;

type EffectDeps = any[] | null;

/**
 * 函数组件 render 入口。
 *
 * renderWithHooks 会在执行组件函数前设置全局 Hook 上下文：
 * - mount 阶段使用 HooksDispatcherOnMount 创建 Hook 链表；
 * - update 阶段使用 HooksDispatcherOnUpdate 复用旧 Hook 并计算新状态。
 *
 * 组件函数执行结束后必须重置这些全局变量，防止 Hook 在组件外被错误调用。
 */
export function renderWithHooks(wip: FiberNode, lane: Lane) {
	// 赋值操作
	currentlyRenderingFiber = wip;
	// 重置hooks链表
	wip.memoizedState = null;
	// 重置effect链表
	wip.updateQueue = null;
	renderLane = lane;

	const current = wip.alternate;
	if (current !== null) {
		// update
		currentDispatcher.current = HooksDispatcherOnUpdate;
	} else {
		// mount
		currentDispatcher.current = HooksDispatcherOnMount;
	}

	// type表示函数组件
	const Component = wip.type;
	const props = wip.pendingProps;
	const children = Component(props);

	// 重置操作
	currentlyRenderingFiber = null;
	workInProgressHook = null;
	currentHook = null;
	renderLane = NoLane;

	return children;
}

const HooksDispatcherOnMount: Dispatcher = {
	useState: mountState,
	useEffect: mountEffect,
	useTransition: mountTransition,
	useRef: mountRef,
	useContext: readContext
};

const HooksDispatcherOnUpdate: Dispatcher = {
	useState: updateState,
	useEffect: updateEffect,
	useTransition: updateTransition,
	useRef: updateRef,
	useContext: readContext
};

function mountEffect(create: EffectCallback | void, deps: EffectDeps | void) {
	// 找到第一个hook
	const hook = mountWorkInProgresHook();
	const nextDeps = deps === undefined ? null : deps;
	// mount需要执行回调
	(currentlyRenderingFiber as FiberNode).flags |= PassiveEffect;
	hook.memoizedState = pushEffect(
		Passive | HookHasEffect,
		create,
		undefined,
		nextDeps
	);
}

function updateEffect(create: EffectCallback | void, deps: EffectDeps | void) {
	// 找到第一个hook
	const hook = updateWorkInProgresHook();
	const nextDeps = deps === undefined ? null : deps;
	let destroy: EffectCallback | void;
	if (currentHook !== null) {
		const prevEffect = currentHook.memoizedState as Effect;
		destroy = prevEffect.destroy;
		if (nextDeps !== null) {
			// 进行浅比较依赖
			const prevDeps = prevEffect.deps;
			if (areHookInputsEqual(nextDeps, prevDeps)) {
				// 依赖值没有改变
				hook.memoizedState = pushEffect(Passive, create, destroy, nextDeps);
				return;
			}
		}
		(currentlyRenderingFiber as FiberNode).flags |= PassiveEffect;
		hook.memoizedState = pushEffect(
			Passive | HookHasEffect,
			create,
			destroy,
			nextDeps
		);
	}
}

// 比较依赖值是否改变，返回false表示改变了
function areHookInputsEqual(nextDeps: EffectDeps, prevDeps: EffectDeps) {
	if (prevDeps === null || nextDeps === null) {
		return false;
	}
	for (let i = 0; i < prevDeps.length && i < nextDeps.length; i++) {
		if (Object.is(prevDeps[i], nextDeps[i])) {
			continue;
		}
		return false;
	}
	return true;
}

// function pushEffect(
// 	hookFlags: Flags,
// 	create: EffectCallback | void,
// 	destroy: EffectCallback | void,
// 	deps: EffectDeps
// ): Effect {
// 	const effect: Effect = {
// 		tag: hookFlags,
// 		create,
// 		destroy,
// 		deps,
// 		next: null
// 	};
// 	const fiber = currentlyRenderingFiber as FiberNode;
// 	// useEffect的链表保存在fiber的updateQueue
// 	const updateQueue = fiber.updateQueue as FCUpdateQueue<any>;
// 	if (updateQueue === null) {
// 		const updateQueue = createFCUpdateQueue();
// 		fiber.updateQueue = updateQueue;
// 		// next指向自己，形成环状链表
// 		effect.next = effect;
// 		updateQueue.lastEffect = effect;
// 	} else {
// 		// 插入effect操作
// 		const lastEffect = updateQueue.lastEffect;
// 		if (lastEffect === null) {
// 			effect.next = effect;
// 			updateQueue.lastEffect = effect;
// 		} else {
// 			const firstEffect = lastEffect.next;
// 			lastEffect.next = effect;
// 			effect.next = firstEffect;
// 			updateQueue.lastEffect = effect;
// 		}
// 	}
// 	console.log(effect);

// 	return effect;
// }

function pushEffect(
	hookFlags: Flags,
	create: EffectCallback | void,
	destroy: EffectCallback | void,
	deps: EffectDeps
): Effect {
	const effect: Effect = {
		tag: hookFlags,
		create,
		destroy,
		deps,
		next: null
	};
	const fiber = currentlyRenderingFiber as FiberNode;
	const updateQueue = fiber.updateQueue as FCUpdateQueue<any>;
	if (updateQueue === null) {
		const updateQueue = createFCUpdateQueue();
		fiber.updateQueue = updateQueue;
		effect.next = effect;
		updateQueue.lastEffect = effect;
	} else {
		// 插入effect
		const lastEffect = updateQueue.lastEffect;
		if (lastEffect === null) {
			effect.next = effect;
			updateQueue.lastEffect = effect;
		} else {
			const firstEffect = lastEffect.next;
			lastEffect.next = effect;
			effect.next = firstEffect;
			updateQueue.lastEffect = effect;
		}
	}
	return effect;
}

function createFCUpdateQueue<State>() {
	const updateQueue = createUpdateQueue<State>() as FCUpdateQueue<State>;
	updateQueue.lastEffect = null;
	return updateQueue;
}

/** update 阶段的 useState：复用旧 Hook，并消费 pending/baseQueue 计算新 state。 */
function updateState<State>(): [State, Dispatch<State>] {
	// 找到当前useState对应的Hook数据
	const hook = updateWorkInProgresHook();
	// 计算新state的逻辑
	const queue = hook.updateQueue as UpdateQueue<State>;

	const baseState = hook.baseState;

	const pending = queue.shared.pending;

	const current = currentHook as Hook;
	let baseQueue = current.baseQueue;

	if (pending !== null) {
		// 将本轮新产生的 pending 队列接到上次遗留的 baseQueue 后面，保证更新顺序不丢失。
		if (baseQueue !== null) {
			const baseFirst = baseQueue.next;
			const pengdingFirst = pending.next;
			baseQueue.next = pengdingFirst;
			pending.next = baseFirst;
		}
		baseQueue = pending;
		// 保存在current中
		current.baseQueue = pending;
		queue.shared.pending = null;
	}
	if (baseQueue !== null) {
		const {
			memoizedState,
			baseQueue: newBaseQueue,
			baseState: newBaseState
		} = processUpdateQueue(baseState, baseQueue, renderLane);
		hook.memoizedState = memoizedState;
		hook.baseState = newBaseState;
		hook.baseQueue = newBaseQueue;
	}

	return [hook.memoizedState, queue.dispatch as Dispatch<State>];
}

function updateWorkInProgresHook(): Hook {
	// TODO: render阶段的更新
	let nextCurrentHook: Hook | null;
	if (currentHook === null) {
		// 这是 FC update 时的第一个 hook
		const current = currentlyRenderingFiber?.alternate;
		if (current !== null) {
			nextCurrentHook = current?.memoizedState;
		} else {
			nextCurrentHook = null;
		}
	} else {
		// 这是 FC update 时后续的 Hook
		nextCurrentHook = currentHook.next;
	}

	if (nextCurrentHook === null) {
		// hook的数量变了
		throw new Error(
			`组件${currentlyRenderingFiber?.type}本次执行时的Hook比上次执行的多`
		);
	}

	// 复用Hook
	currentHook = nextCurrentHook as Hook;
	const newHook: Hook = {
		memoizedState: currentHook.memoizedState,
		updateQueue: currentHook.updateQueue,
		next: null,
		baseQueue: currentHook.baseQueue,
		baseState: currentHook.baseState
	};
	if (workInProgressHook === null) {
		// update 阶段的第一个 hook
		if (currentlyRenderingFiber === null) {
			// 没有在函数组件内调用hook(当前指向的fiber树为null)
			throw new Error('请在函数组件内调用Hook');
		} else {
			workInProgressHook = newHook;
			// update 的第一个 hook，挂到 fiber.memoizedState 上
			currentlyRenderingFiber.memoizedState = workInProgressHook;
		}
	} else {
		// update 后续的 hook（使用链表的方式连接起来）
		workInProgressHook.next = newHook;
		// 更新hook的指向
		workInProgressHook = newHook;
	}
	return workInProgressHook;
}

/** mount 阶段的 useState：创建 Hook、初始化 state，并绑定 dispatch。 */
function mountState<State>(
	initialState: (() => State) | State
): [State, Dispatch<State>] {
	// 找到当前useState对应的Hook数据
	const hook = mountWorkInProgresHook();
	let memoizedState;
	if (initialState instanceof Function) {
		memoizedState = initialState();
	} else {
		memoizedState = initialState;
	}

	// dispatch可以触发更新，创建一个updateQueue
	const queue = createUpdateQueue<State>();
	hook.updateQueue = queue;
	hook.memoizedState = memoizedState;
	hook.baseState = memoizedState;

	//@ts-ignore
	const dispatch = disPatchSetState.bind(null, currentlyRenderingFiber, queue);
	queue.dispatch = dispatch;
	return [memoizedState, dispatch];
}

// 返回第一个参数是是否在更新中（isPending），第二个是 startTransition 函数
function mountTransition(): [boolean, (callback: () => void) => void] {
	const [isPending, setPending] = mountState(false);
	const hook = mountWorkInProgresHook();
	const start = startTransition.bind(null, setPending);
	hook.memoizedState = start;
	return [isPending, start];
}

function updateTransition(): [boolean, (callback: () => void) => void] {
	const [isPending] = updateState();
	const hook = updateWorkInProgresHook();
	const start = hook.memoizedState;
	return [isPending as boolean, start];
}
/* 
setPenging本质是创建一个update
*/
function startTransition(setPenging: Dispatch<boolean>, callback: () => void) {
	// 触发一个优先级
	setPenging(true);
	const prevTransition = currentBatchConfig.transition;
	currentBatchConfig.transition = 1;
	// 触发另一个优先级,currentBatchConfig.transition不为null
	callback();
	setPenging(false);
	currentBatchConfig.transition = prevTransition;
}

function mountRef<T>(initialValue: T): { current: T } {
	const hook = mountWorkInProgresHook();
	const ref = { current: initialValue };
	hook.memoizedState = ref;
	return ref;
}

function updateRef<T>(): { current: T } {
	const hook = updateWorkInProgresHook();
	return hook.memoizedState;
}

/** dispatch(setState) 入口：创建 update，入队，然后从当前 Fiber 调度到 root。 */
function disPatchSetState<State>(
	fiber: FiberNode,
	updateQueue: UpdateQueue<State>,
	action: Action<State>
) {
	const lane = requestUpdateLane();
	const update = createUpdate(action, lane);
	enqueueUpdate(updateQueue, update);
	// 触发更新流程(scheduleUpdateOnFiber该函数会先找到根节点)
	scheduleUpdateOnFiber(fiber, lane);
}

/** mount 阶段创建 Hook，并挂到 currentlyRenderingFiber.memoizedState 链表上。 */
function mountWorkInProgresHook(): Hook {
	const hook: Hook = {
		memoizedState: null,
		updateQueue: null,
		next: null,
		baseState: null,
		baseQueue: null
	};
	if (workInProgressHook === null) {
		// mount 并且是第一个hook
		if (currentlyRenderingFiber === null) {
			// 没有在函数组件内调用hook(当前指向的fiber树为null)
			throw new Error('请在函数组件内调用Hook');
		} else {
			workInProgressHook = hook;
			// mount的第一个hook
			currentlyRenderingFiber.memoizedState = workInProgressHook;
		}
	} else {
		// mount 后续的hook(使用链表的方式连接起来)
		workInProgressHook.next = hook;
		// 更新hook的指向
		workInProgressHook = hook;
	}
	return workInProgressHook;
}

function readContext<T>(context: ReactContext<T>): T {
	const consumer = currentlyRenderingFiber;
	if (consumer === null) {
		// 脱离了函数组件
		throw new Error('只能在函数组件中调用');
	}
	const value = context._currentValue;
	return value;
}
