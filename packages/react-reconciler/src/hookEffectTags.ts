// effect 类型标记。当前实现只支持 useEffect，对应 Passive。
export const Passive = 0b0010;

// 本次 commit 是否需要执行该 effect 的 destroy/create。
export const HookHasEffect = 0b0001;
