import { Container } from 'hostConfig';
import { FiberNode, FiberRootNode } from './fiber';
import { HostRoot } from './workTags';
import {
	UpdateQueue,
	createUpdate,
	createUpdateQueue,
	enqueueUpdate
} from './updateQueue';
import { ReactElementType } from 'shared/ReactTypes';
import { scheduleUpdateOnFiber } from './workLoop';
import { requestUpdateLane } from './fiberLanes';
import {
	unstable_ImmediatePriority,
	unstable_runWithPriority
} from 'scheduler';

/**
 * 创建应用根节点。
 *
 * ReactDOM.createRoot(container) 会进入这里：
 * - HostRoot Fiber 是整棵 Fiber 树的根工作单元；
 * - FiberRootNode 保存宿主容器、当前树 current、待提交树 finishedWork、待处理优先级等根级状态；
 * - HostRoot 的 updateQueue 用来接收后续 render(element) 产生的首个更新。
 */
export function createContainer(container: Container) {
	const hostRootFiber = new FiberNode(HostRoot, {}, null);
	const root = new FiberRootNode(container, hostRootFiber);
	// HostRoot 的状态就是本次要渲染的 ReactElement，因此也需要一条更新队列。
	hostRootFiber.updateQueue = createUpdateQueue();
	return root;
}

/**
 * 将 ReactElement 包装成一次更新，并把更新调度到 HostRoot Fiber 上。
 *
 * 首屏 render 本质上不是“立刻递归渲染 DOM”，而是：
 * ReactElement -> Update -> UpdateQueue -> scheduleUpdateOnFiber。
 * 后续由 workLoop 根据 lane 决定同步执行还是并发调度。
 */
export function updateContainer(
	element: ReactElementType | null,
	root: FiberRootNode
) {
	// 首屏渲染使用 ImmediatePriority，因此 requestUpdateLane 会得到 SyncLane。
	unstable_runWithPriority(unstable_ImmediatePriority, () => {
		const hostRootFiber = root.current;
		const lane = requestUpdateLane();
		const update = createUpdate<ReactElementType | null>(element, lane);
		// updateQueue 使用环状链表保存同一批次内的多个更新。
		enqueueUpdate(
			hostRootFiber.updateQueue as UpdateQueue<ReactElementType | null>,
			update
		);
		scheduleUpdateOnFiber(hostRootFiber, lane);
	});

	return element;
}
