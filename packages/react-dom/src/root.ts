import { ReactElementType } from './../../shared/ReactTypes';

import {
	createContainer,
	updateContainer
} from 'react-reconciler/src/fiberReconciler';
import { Container } from './hostConfig';
import { initEvent } from './SyntheticEvent';

/**
 * ReactDOM.createRoot(container).render(<App />) 的 DOM 入口。
 *
 * 这里属于 renderer 层，只做两件事：
 * 1. 调用 reconciler 的 createContainer 创建 FiberRootNode；
 * 2. 在 render 时把 ReactElement 交给 updateContainer，后续调度、render、commit 都由 reconciler 接管。
 */
export function createRoot(container: Container) {
	const root = createContainer(container);
	return {
		render(element: ReactElementType) {
			// 当前实现只初始化 click 事件委托，后续可以扩展更多事件类型。
			initEvent(container, 'click');
			return updateContainer(element, root);
		}
	};
}
