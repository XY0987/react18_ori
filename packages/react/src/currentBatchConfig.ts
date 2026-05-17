interface BatchConfig {
	transition: number | null;
}

/**
 * 当前批处理上下文。
 *
 * startTransition 执行期间会临时把 transition 置为非 null，
 * requestUpdateLane 据此把 callback 内产生的更新标记为 TransitionLane。
 */
const ReactCurrentBatchConfig: BatchConfig = {
	transition: null
};

export default ReactCurrentBatchConfig;
