export type Flags = number;

export const NoFlags = 0b0000000;
// 插入或移动宿主节点。
export const Placement = 0b0000001;
// 更新宿主节点，例如文本内容变化。
export const Update = 0b0000010;
// 删除子节点，具体删除列表保存在父 Fiber.deletions 上。
export const ChildDeletion = 0b0000100;

// 当前 Fiber 上存在需要在 commit 后处理的 passive effect。
export const PassiveEffect = 0b0001000;
// ref 需要解绑或绑定。
export const Ref = 0b0010000;

// mutation 阶段要处理的副作用集合。
export const MutationMask = Placement | Update | ChildDeletion | Ref;
// layout 阶段要处理的副作用集合。
export const LayoutMask = Ref;

// passive effect 收集相关副作用集合；删除子树时也要触发 useEffect destroy。
export const PassiveMask = PassiveEffect | ChildDeletion;
