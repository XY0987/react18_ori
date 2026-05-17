import { ReactContext } from 'shared/ReactTypes';

// 保存当前 Provider 覆盖前的 context 值。
let prevContextValue: any = null;

// Provider 可以嵌套，因此需要栈结构保存更外层的历史值。
const prevContextValueStack: any[] = [];

/**
 * 进入 ContextProvider 的 beginWork 时调用。
 *
 * 当前 Provider 的 value 会临时写入 context._currentValue，
 * 后续子树里的 useContext 读取到的就是这个最新值。
 */
export function pushProvider<T>(context: ReactContext<T>, newValue: T) {
	prevContextValueStack.push(prevContextValue);
	prevContextValue = context._currentValue;
	context._currentValue = newValue;
}

/**
 * 离开 ContextProvider 的 completeWork 时调用。
 *
 * 子树处理完成后恢复进入 Provider 前的值，避免影响兄弟子树或外层 Provider。
 */
export function popProvider<T>(context: ReactContext<T>) {
	context._currentValue = prevContextValue;
	prevContextValue = prevContextValueStack.pop();
}
