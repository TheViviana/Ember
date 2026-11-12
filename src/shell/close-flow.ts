/**
 * 关窗收尾：先做「可拦截」的落盘，全部成功才拆解内核。
 * 落盘失败必须阻止关闭——Tauri 关窗请求返回后窗口立即销毁，
 * 用户会以为最后一次修改已经保存，实际却丢了内容。
 */
import { toErrorText } from '../kernel/errors.ts';
import type { Logger } from '../kernel/types.ts';

export type CloseOutcome =
  | { readonly kind: 'close' }
  | { readonly kind: 'block'; readonly failures: readonly string[] };

export interface CloseFlowDeps {
  /** 阶段一：所有可拦截的落盘动作，并行执行并汇总全部失败 */
  readonly flushers: readonly (() => Promise<void>)[];
  /** 阶段二：内核拆解；失败时窗口仍关闭（已无可挽回），只记录 */
  readonly shutdown: () => Promise<void>;
  readonly log: Pick<Logger, 'error'>;
}

export const runCloseFlow = async ({
  flushers,
  shutdown,
  log,
}: CloseFlowDeps): Promise<CloseOutcome> => {
  const results = await Promise.allSettled(flushers.map((flush) => flush()));
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [toErrorText(result.reason)] : [],
  );
  if (failures.length > 0) return { kind: 'block', failures };

  try {
    await shutdown();
  } catch (error) {
    log.error('关窗收尾失败（窗口仍会关闭）', { error: toErrorText(error) });
  }
  return { kind: 'close' };
};
