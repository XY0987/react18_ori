import { Props, Key, Ref, ReactElementType } from 'shared/ReactTypes';
import {
	ContextProvider,
	Fragment,
	FunctionComponent,
	HostComponent,
	WorkTag
} from './workTags';
import { Flags, NoFlags } from './fiberFlags';
import { Container } from 'hostConfig';
import { Lane, Lanes, NoLane, NoLanes } from './fiberLanes';
import { Effect } from './fiberHooks';
import { CallbackNode } from 'scheduler';
import { REACT_PROVIDER_TYPE } from 'shared/ReactSymbols';

/*
协调器的核心任务：
1. 将 ReactElement 转换为 FiberNode；
2. 以深度优先遍历的方式比较 current 树和 workInProgress 树；
3. 在 FiberNode 上收集 Placement、Update、ChildDeletion 等副作用标记；
4. commit 阶段再根据这些标记调用宿主环境 API 更新真实 UI。
*/

export class FiberNode {
	/** 节点类型：函数组件、原生 DOM 节点、文本节点、HostRoot 等。 */
	tag: WorkTag;
	/** ReactElement.key，用于同级子节点 diff 复用。 */
	key: Key;
	/** 宿主实例或根节点状态：HostComponent 对应 DOM，HostRoot 对应 FiberRootNode。 */
	stateNode: any;
	/** 组件类型：HostComponent 是标签名，FunctionComponent 是函数本身。 */
	type: any;
	/** 本轮 render 输入的新 props。 */
	pendingProps: Props;

	/** 父 Fiber。 */
	return: FiberNode | null;
	/** 下一个兄弟 Fiber。 */
	sibling: FiberNode | null;
	/** 第一个子 Fiber。 */
	child: FiberNode | null;
	/** 当前 Fiber 在同级列表中的位置，用于数组 diff 判断移动。 */
	index: number;

	ref: Ref;

	/** 上一次完成 render 后记录的 props。 */
	memoizedProps: Props | null;
	/** 上一次完成 render 后记录的 state；函数组件中保存 Hook 链表头。 */
	memoizedState: any;
	/** 双缓冲指针：current 与 workInProgress 通过 alternate 互相连接。 */
	alternate: FiberNode | null;
	/** 当前 Fiber 自身的副作用标记。 */
	flags: Flags;
	/** 子树中所有副作用标记的汇总，用于 commit 阶段快速跳过无副作用子树。 */
	subtreeFlags: Flags;

	/** HostRoot/useState/useEffect 等都会借助 updateQueue 保存更新或 effect。 */
	updateQueue: unknown;
	/** commit 阶段需要删除的子节点集合。 */
	deletions: FiberNode[] | null;

	constructor(tag: WorkTag, pendingProps: Props, key: Key) {
		this.tag = tag;
		this.key = key || null;
		// 如果是 HostComponent，保存的是对应的 DOM 实例；如果是 HostRoot，保存的是 FiberRootNode
		this.stateNode = null;
		// 如果是FunctionComponent，它对应的就是函数本身
		this.type = null;

		// 定义一些字段用来保存节点之间的关系
		this.return = null; //指向父FiberNode
		this.sibling = null; //指向兄弟FiberNode
		this.child = null; //指向子节点的FiberNode
		this.index = 0; //同级的可能有多个节点用于表示第几个

		this.ref = { current: null };

		// 作为工作单元
		this.pendingProps = pendingProps; //刚开始的时候Props是什么
		this.memoizedState = null;
		this.memoizedProps = null; //工作完成之后它的Props是什么
		this.updateQueue = null;

		// 双缓冲对应的fiberNode树
		this.alternate = null;

		// 副作用
		this.flags = NoFlags;
		this.subtreeFlags = NoFlags; //用于标记子树是否有标记
		this.deletions = null;
	}
}

export interface PendingPassiveEffects {
	/** 组件卸载时需要执行 destroy 的 effect。 */
	unmount: Effect[];
	/** 组件更新时需要先 destroy 再 create 的 effect。 */
	update: Effect[];
}

export class FiberRootNode {
	/** 宿主容器，例如 DOM renderer 中的根 DOM 节点。 */
	container: Container;
	/** 当前屏幕上已经提交的 Fiber 树。 */
	current: FiberNode;
	/** render 阶段完成后等待 commit 的 workInProgress 树。 */
	finishedWork: FiberNode | null;
	/** root 上所有还没被消费的 lane 集合。 */
	pendingLanes: Lanes;
	/** 本次 finishedWork 对应消费的 lane。 */
	finishedLane: Lane;
	/** commit 后异步执行的 passive effect 队列。 */
	pendingPassiveEffects: PendingPassiveEffects;

	/** Scheduler 返回的回调节点，用于取消或复用已调度任务。 */
	callbackNode: CallbackNode | null;
	/** 当前已调度任务的优先级。 */
	callbackPriority: Lane;
	constructor(container: Container, hostRootFiber: FiberNode) {
		this.container = container;
		this.current = hostRootFiber;
		// HostRoot Fiber 通过 stateNode 反向指向 FiberRootNode，便于从任意 Fiber 向上找到 root。
		hostRootFiber.stateNode = this;
		this.finishedWork = null;
		this.pendingLanes = NoLanes;
		this.finishedLane = NoLane;

		this.callbackNode = null;
		this.callbackPriority = NoLane;

		this.pendingPassiveEffects = {
			unmount: [],
			update: []
		};
	}
}

/**
 * 创建或复用 workInProgress Fiber。
 *
 * 双缓冲模型中，同一个逻辑节点最多有两份 Fiber：
 * - current：当前页面正在使用的树；
 * - workInProgress：本轮 render 正在构建的新树。
 *
 * 首次更新时创建 alternate，后续更新复用 alternate 并清理上一轮副作用标记。
 */
export const createWorkInProgress = (
	current: FiberNode,
	pendingProps: Props
): FiberNode => {
	let wip = current.alternate;
	// 首次渲染时是null
	if (wip === null) {
		// mount
		wip = new FiberNode(current.tag, pendingProps, current.key);
		wip.stateNode = current.stateNode;

		wip.alternate = current;
		current.alternate = wip;
	} else {
		//update
		wip.pendingProps = pendingProps;
		// 清除副作用
		wip.flags = NoFlags;
		wip.subtreeFlags = NoFlags;
		wip.deletions = null;
	}
	wip.type = current.type;
	wip.updateQueue = current.updateQueue;
	wip.child = current.child;
	wip.memoizedState = current.memoizedState;
	wip.memoizedProps = current.memoizedProps;
	wip.ref = current.ref;

	return wip;
};
// 根据ReactElement（jsx方法调用创建的）元素类型创建对应的fiber树
export function createFiberFromElement(element: ReactElementType): FiberNode {
	const { type, key, props, ref } = element;
	let fiberTag: WorkTag = FunctionComponent;
	if (typeof type === 'string') {
		fiberTag = HostComponent;
	} else if (
		typeof type === 'object' &&
		type.$$typeof === REACT_PROVIDER_TYPE
	) {
		fiberTag = ContextProvider;
	} else if (typeof type !== 'function' && __DEV__) {
		console.warn('未定义的type类型', element);
	}

	const fiber = new FiberNode(fiberTag, props, key);
	fiber.type = type;
	fiber.ref = ref;
	return fiber;
}

export function createFiberFromFragment(elements: any[], key: Key): FiberNode {
	const fiber = new FiberNode(Fragment, elements, key);
	return fiber;
}
