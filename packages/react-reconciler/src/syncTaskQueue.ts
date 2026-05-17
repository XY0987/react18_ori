// 同步任务队列，SyncLane 更新会先进入这里，再由微任务统一 flush。
let syncQueue: ((...args: any) => void)[] | null = null;

// 防止 flush 过程中再次递归 flush，造成重复执行或状态错乱。
let isFlushingSyncQueue: boolean = false;

/** 收集一个同步任务。多次同步更新会被暂存在同一个 syncQueue 中。 */
export function scheduleSyncCallback(callback: (...args: any) => void) {
	if (syncQueue === null) {
		syncQueue = [callback];
	} else {
		syncQueue.push(callback);
	}
}

/**
 * 执行同步任务队列。
 *
 * workLoop 中的 SyncLane 会通过 scheduleMicroTask(flushSyncCallbacks) 调度到微任务，
 * 这样同一轮事件中的多次同步更新可以先合并入队，再统一执行。
 */
export function flushSyncCallbacks() {
	if (!isFlushingSyncQueue && syncQueue) {
		isFlushingSyncQueue = true;
		try {
			syncQueue.forEach((callback) => callback());
		} catch (error) {
			if (__DEV__) {
				console.warn('flushSyncCallbacks出错了', error);
			}
		} finally {
			isFlushingSyncQueue = false;
			syncQueue = null;
		}
	}
}
