import { describeIpcError } from '../../data/tauri/ipc-error.ts';
import type { VaultOpenMode, VaultStartupView } from '../../data/tauri/vault-session.ts';

/** 切库依赖全部以闭包传入：顺序与中止行为可在不挂载 React 的情况下验证。 */
export interface VaultSwitchDeps {
  readonly flushFloatEditors: () => Promise<void>;
  readonly flushDocs: () => Promise<void>;
  readonly flushCanvas: () => Promise<void>;
  readonly flushSettings: () => Promise<void>;
  readonly open: (root: string, mode: VaultOpenMode) => Promise<VaultStartupView>;
  readonly reload: () => void;
}

export type VaultSwitchOutcome =
  | { readonly kind: 'switched' }
  | { readonly kind: 'aborted'; readonly reason: string };

/**
 * 切库：先把当前库所有待写内容落盘，再打开目标库，最后才重载窗口。
 * 浮窗编辑器的写入带 600ms 防抖，不冲掉就 reload 等于丢掉用户最后一段输入；
 * 任一步失败都中止并保留当前库，不做半切换。
 */
export const runVaultSwitch = async (
  deps: VaultSwitchDeps,
  root: string,
  mode: VaultOpenMode,
): Promise<VaultSwitchOutcome> => {
  try {
    await deps.flushFloatEditors();
    await deps.flushDocs();
    await deps.flushCanvas();
    await deps.flushSettings();
  } catch (cause: unknown) {
    return {
      kind: 'aborted',
      reason: `切换已中止，当前库保持不变：${describeIpcError(cause)}`,
    };
  }

  let view: VaultStartupView;
  try {
    view = await deps.open(root, mode);
  } catch (cause: unknown) {
    return { kind: 'aborted', reason: `未切换：${describeIpcError(cause)}` };
  }
  if (view.status !== 'ready') {
    return { kind: 'aborted', reason: '目标库没有就绪，当前库保持不变。' };
  }

  deps.reload();
  return { kind: 'switched' };
};

/** 字面同一目录（尾斜杠不敏感）；软链等差异由 Rust 侧规范化兜底。 */
export const isSameDirectory = (left: string, right: string): boolean => {
  const normalize = (path: string): string => path.trim().replace(/\/+$/, '');
  return normalize(left) === normalize(right);
};
