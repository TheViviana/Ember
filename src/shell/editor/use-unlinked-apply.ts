import { splitFrontmatter } from '#doc-model';
import type { DocId } from '#doc-model';
import type { DocService } from '../../kernel/doc-service.ts';
import type { DocRevision, UnlinkedMention } from '../../kernel/types.ts';

/**
 * 把未链接提及「接受」为 [[双链]] 的原子操作：
 * 1. docs.read 拿最新快照 + base revision
 * 2. 校验扫描时的 offset 处仍然是原 match（防 stale）
 * 3. 拼 patch → docs.update
 */
export interface AcceptMentionInput {
  readonly docs: DocService;
  readonly mention: UnlinkedMention;
  /** 要插入的 wikilink 文本（默认 `[[title]]`） */
  readonly wikilink?: string;
}

export type AcceptMentionResult =
  | { readonly ok: true; readonly srcId: DocId }
  | {
      readonly ok: false;
      readonly reason: 'stale' | 'read-failed' | 'update-failed';
      readonly detail: string;
    };

export const acceptUnlinkedMention = async (input: AcceptMentionInput): Promise<AcceptMentionResult> => {
  const { docs, mention } = input;
  const wikilink = input.wikilink ?? `[[${mention.title}]]`;

  let snapshot;
  try {
    snapshot = await docs.read(mention.srcId);
  } catch (error) {
    return {
      ok: false,
      reason: 'read-failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const split = splitFrontmatter(snapshot.text);
  const body = split.body;

  // Stale 校验：扫描时的 from/to 必须仍然是原 match
  if (
    mention.from < 0 ||
    mention.to > body.length ||
    body.slice(mention.from, mention.to) !== mention.match
  ) {
    return {
      ok: false,
      reason: 'stale',
      detail: `位置 ${mention.from}..${mention.to} 已不是 "${mention.match}"，文档在此期间被修改。`,
    };
  }

  const newBody = body.slice(0, mention.from) + wikilink + body.slice(mention.to);
  const baseRev: DocRevision = snapshot.meta.rev;

  let outcome;
  try {
    outcome = await docs.update(mention.srcId, { body: newBody }, { base: baseRev, intent: 'user' });
  } catch (error) {
    return {
      ok: false,
      reason: 'update-failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (outcome.conflict !== null) {
    return {
      ok: false,
      reason: 'update-failed',
      detail: '冲突副本已生成，请手动处理。',
    };
  }

  return { ok: true, srcId: mention.srcId };
};
