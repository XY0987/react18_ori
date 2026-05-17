import { Dispatch } from 'react/src/currentDispatcher';
import { Action } from 'shared/ReactTypes';
import { Lane, NoLane, isSubsetOfLanes } from './fiberLanes';

export interface Update<State> {
	/** setState 传入的值或函数；HostRoot 场景下是要渲染的 ReactElement。 */
	action: Action<State>;
	/** 本次更新所属优先级，render 时只有优先级足够的 update 才会被消费。 */
	lane: Lane;
	/** updateQueue 使用环状链表，next 指向下一个 update。 */
	next: Update<any> | null;
}

export interface UpdateQueue<State> {
	shared: {
		/** 指向环状链表中最后插入的 update，pending.next 才是第一个 update。 */
		pending: Update<State> | null;
	};
	// dispatch 用于 hook 更新；HostRoot 的 updateQueue 不需要 dispatch。
	dispatch: Dispatch<State> | null;
}

/** 创建一次更新。 */
export const createUpdate = <State>(
	action: Action<State>,
	lane: Lane
): Update<State> => {
	return {
		action,
		lane,
		next: null
	};
};

/** 创建更新队列。 */
export const createUpdateQueue = <State>() => {
	return {
		shared: {
			pending: null
		},
		dispatch: null
	} as UpdateQueue<State>;
};

/**
 * 将 update 追加到环状链表尾部。
 *
 * 使用环状链表的好处是：只保存最后一个 pending update，也能通过 pending.next 快速找到第一个 update。
 */
export const enqueueUpdate = <State>(
	updateQueue: UpdateQueue<State>,
	update: Update<State>
) => {
	const pending = updateQueue.shared.pending;
	if (pending === null) {
		// 首个 update 自己指向自己，形成 a -> a 的环。
		update.next = update;
	} else {
		// 新 update 插入到 pending 和 pending.next 之间，成为新的尾节点。
		update.next = pending.next;
		pending.next = update;
	}
	updateQueue.shared.pending = update;
};

/**
 * 消费 updateQueue，计算本次 render 应得到的最新状态。
 *
 * 优先级不足的 update 不会丢弃，而是克隆到 baseQueue 中，等待后续更合适的 renderLane 再处理。
 */
export const processUpdateQueue = <State>(
	baseState: State,
	pendingUpdate: Update<State> | null,
	renderLane: Lane
): {
	memoizedState: State;
	baseState: State;
	baseQueue: Update<State> | null;
} => {
	const result: {
		memoizedState: State;
		baseState: State;
		baseQueue: Update<State> | null;
	} = {
		memoizedState: baseState,
		baseState: baseState,
		baseQueue: null
	};
	if (pendingUpdate !== null) {
		// 第一个update
		const first = pendingUpdate.next;
		let pending = pendingUpdate.next as Update<any>;

		let newBaseState = baseState;
		// 用链表保存updateQueue
		let newBaseQueueFirst: Update<State> | null = null;
		let newBaseQueueLast: Update<State> | null = null;
		let newState = baseState;

		do {
			const updateLane = pending.lane;
			if (!isSubsetOfLanes(renderLane, updateLane)) {
				// 优先级不够，被跳过
				// 被跳过的update
				const clone = createUpdate(pending.action, pending.lane);
				// 判断是否是第一个被跳过的update
				if (newBaseQueueFirst === null) {
					newBaseQueueFirst = clone;
					newBaseQueueLast = clone;
					newBaseState = newState;
				} else {
					// 不是第一个被跳过的
					(newBaseQueueLast as Update<State>).next = clone;
					newBaseQueueLast = clone;
				}
			} else {
				// 优先级足够,判断有没有被跳过的
				if (newBaseQueueLast !== null) {
					const clone = createUpdate(pending.action, NoLane);
					newBaseQueueLast.next = clone;
					newBaseQueueLast = clone;
				}
				// 传递的一种是值，另一种是一个函数
				const action = pending.action;
				if (action instanceof Function) {
			/* 
				setState传函数和传值不同的点就在这里，多次更新传函数时
				newState的值一直都会改变，而传值时只会赋值。
				注意：这里应基于 newState（前一个 update 的累积值）而非 baseState 来计算。
				*/
				newState = action(newState);
				} else {
					newState = action;
				}
			}
			pending = pending?.next as Update<any>;
		} while (pending !== first);

		if (newBaseQueueLast === null) {
			// 本次计算没有update被跳过
			newBaseState = newState;
		} else {
			// 本次计算有update被跳过
			newBaseQueueLast.next = newBaseQueueFirst;
		}
		result.memoizedState = newState;
		result.baseState = newBaseState;
		result.baseQueue = newBaseQueueLast;
	}
	return result;
};
