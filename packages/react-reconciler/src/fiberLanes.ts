import {
	unstable_IdlePriority,
	unstable_ImmediatePriority,
	unstable_NormalPriority,
	unstable_UserBlockingPriority,
	unstable_getCurrentPriorityLevel
} from 'scheduler';
import { FiberRootNode } from './fiber';

import currentBatchConfig from 'react/src/currentBatchConfig';

export type Lane = number;
export type Lanes = number;

/**
 * Lane 是 React 18 的更新优先级模型。
 *
 * 每个 lane 占用一个二进制位，多个更新可以通过按位或合并到同一个 Lanes 集合中。
 * 数值越靠右，优先级越高；NoLane/NoLanes 表示没有待处理更新。
 */
export const SyncLane = 0b00001;
export const NoLane = 0b00000;

export const InputContinuousLane = 0b00010;
export const DefaultLane = 0b00100;
export const TransitionLane = 0b01000;
export const IdleLane = 0b10000;

export const NoLanes = 0b000;

/** 合并多个 lane，表示 root 上同时存在多种优先级的待处理更新。 */
export function mergeLanes(laneA: Lane, laneB: Lane): Lanes {
	return laneA | laneB;
}

/**
 * 为一次更新选择 lane。
 *
 * - startTransition 包裹的更新会进入 TransitionLane；
 * - 其他更新根据当前 Scheduler priority 映射到对应 lane。
 */
export function requestUpdateLane() {
	const isTransition = currentBatchConfig.transition !== null;
	if (isTransition) {
		return TransitionLane;
	}
	// 从上下文环境中获取优先级
	const currentSchedulerPriority = unstable_getCurrentPriorityLevel();
	const lane = schedulerPriorityToLane(currentSchedulerPriority);
	return lane;
}

/** 取出 Lanes 中最靠右的 1，也就是当前最高优先级 lane。 */
export function getHighestPriorityLane(lanes: Lanes): Lane {
	return lanes & -lanes;
}

/** 判断 subset 是否完全包含在 set 中，用于判断当前 renderLane 能否消费某个 update。 */
export function isSubsetOfLanes(set: Lanes, subset: Lane) {
	return (set & subset) === subset;
}

/** 某个 lane 提交完成后，从 root.pendingLanes 中移除它。 */
export function markRootFinished(root: FiberRootNode, lane: Lane) {
	root.pendingLanes &= ~lane;
}

/** 将 React 内部 lane 映射成 Scheduler 可识别的任务优先级。 */
export function lanesToSchedulerPriority(lanes: Lanes) {
	const lane = getHighestPriorityLane(lanes);
	if (lane === SyncLane) {
		return unstable_ImmediatePriority;
	}
	if (lane === InputContinuousLane) {
		return unstable_UserBlockingPriority;
	}
	if (lane === DefaultLane) {
		return unstable_NormalPriority;
	}
	return unstable_IdlePriority;
}

/** 将 Scheduler 当前优先级反向映射成 React 更新 lane。 */
export function schedulerPriorityToLane(schedulerPriority: number): Lane {
	if (schedulerPriority === unstable_ImmediatePriority) {
		return SyncLane;
	}
	if (schedulerPriority === unstable_UserBlockingPriority) {
		return InputContinuousLane;
	}
	if (schedulerPriority === unstable_NormalPriority) {
		return DefaultLane;
	}
	return NoLane;
}
