import { safeFileName, splitFrontmatter, type DocId } from '#doc-model';
import { EmberError, isEmberError } from '../../kernel/errors.ts';
import type { TrashDestination } from '../../kernel/ports.ts';
import type { CreateDocInput, DocPatch, DocRevision, DocSnapshot, WriteOptions, WriteOutcome } from '../../kernel/types.ts';
import type { PathTools } from '../../kernel/paths.ts';

/**
 * 写回提案的数据层：所有判断都可注入假文档端口做单测。
 * 提案本身仍由面板内存持有（见 AiPanel），这里只负责「拿提案 + 当前磁盘状态 → 一次写入」。
 */
export interface ProposalDocs {
  read(id: DocId): Promise<DocSnapshot>;
  update(id: DocId, patch: DocPatch, opts: WriteOptions): Promise<WriteOutcome>;
  create(input: CreateDocInput): Promise<DocSnapshot>;
  remove(id: DocId, opts: WriteOptions): Promise<TrashDestination | null>;
}

export type Proposal =
  | {
      readonly kind: 'replace';
      readonly docId: DocId;
      readonly base: DocRevision;
      readonly title: string;
      readonly body: string;
      readonly previousBody: string;
    }
  | { readonly kind: 'create'; readonly title: string; readonly body: string }
  | {
      readonly kind: 'delete';
      readonly docId: DocId;
      readonly base: DocRevision;
      readonly title: string;
    };

/** 逆向操作只活在本次运行内，不写 ui.json */
export type UndoAction =
  | {
      readonly kind: 'restore-body';
      readonly docId: DocId;
      readonly title: string;
      readonly body: string;
      /** AI 应用后的正文；撤销前用它识别「替换之后又有人工编辑」的情形 */
      readonly appliedBody: string;
    }
  | { readonly kind: 'remove-created'; readonly docId: DocId; readonly title: string }
  | { readonly kind: 'restore-deleted'; readonly title: string; readonly input: CreateDocInput };

export type ApplyResult =
  | { readonly kind: 'error'; readonly message: string }
  | {
      readonly kind: 'applied';
      readonly notice: string;
      readonly undo: UndoAction | null;
      readonly createdId: DocId | null;
    };

export const REPLACE_STALE_MESSAGE = '文章在生成提案之后已被修改，提案已作废；请重新生成。';
export const DELETE_STALE_MESSAGE = '文章在生成提案之后已被修改，删除已取消；请重新确认。';
export const UNDO_STALE_MESSAGE =
  '替换之后的正文又被修改过，撤销会覆盖人工编辑；已中止，请手动处理。';

const pad = (value: number): string => String(value).padStart(2, '0');

const stamp = (at: Date): string =>
  `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;

type PathNormalizer = Pick<PathTools, 'normalize'>;

/** 新建文章：同一秒内重名按 path_exists 自动加序号 */
export const createProposalDoc = async (
  docs: ProposalDocs,
  paths: PathNormalizer,
  title: string,
  body: string,
  now: () => Date = () => new Date(),
): Promise<DocSnapshot> => {
  const name = safeFileName(title, { fallback: '未命名', maxLength: 60 });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-${attempt + 1}`;
    const path = paths.normalize(`notes/${name}-${stamp(now())}${suffix}.md`);
    try {
      return await docs.create({ path, title, text: body, intent: 'user' });
    } catch (cause) {
      if (!isEmberError(cause) || cause.code !== 'path_exists') throw cause;
    }
  }
  throw new EmberError('path_exists', '同一秒内同名文章过多，换个标题再试');
};

/**
 * 提案 → 一次经 kernel.docs.* 的写入。
 * stale 只读不写；三方合并冲突返回错误且不生成撤销条。
 */
export const applyProposalDoc = async (
  docs: ProposalDocs,
  paths: PathNormalizer,
  proposal: Proposal,
  now: () => Date = () => new Date(),
): Promise<ApplyResult> => {
  if (proposal.kind === 'replace') {
    const current = await docs.read(proposal.docId);
    if (current.meta.rev.hash !== proposal.base.hash) {
      return { kind: 'error', message: REPLACE_STALE_MESSAGE };
    }
    const outcome = await docs.update(
      proposal.docId,
      { body: proposal.body },
      { base: current.meta.rev, intent: 'user' },
    );
    if (outcome.conflict !== null) {
      return {
        kind: 'error',
        message: `三方合并失败，已保留磁盘版本并生成冲突副本：${String(outcome.conflict.path)}`,
      };
    }
    return {
      kind: 'applied',
      notice: `已用 AI 结果替换《${proposal.title}》正文`,
      createdId: null,
      undo: {
        kind: 'restore-body',
        docId: proposal.docId,
        title: proposal.title,
        body: proposal.previousBody,
        appliedBody: proposal.body,
      },
    };
  }

  if (proposal.kind === 'create') {
    const created = await createProposalDoc(docs, paths, proposal.title, proposal.body, now);
    return {
      kind: 'applied',
      notice: `已新建《${proposal.title}》，写入 notes/`,
      createdId: created.meta.id,
      undo: { kind: 'remove-created', docId: created.meta.id, title: proposal.title },
    };
  }

  const current = await docs.read(proposal.docId);
  if (current.meta.rev.hash !== proposal.base.hash) {
    return { kind: 'error', message: DELETE_STALE_MESSAGE };
  }
  const input: CreateDocInput = {
    path: current.meta.path,
    title: current.frontmatter.title ?? proposal.title,
    text: splitFrontmatter(current.text).body,
    tags: current.frontmatter.tags,
    aliases: current.frontmatter.aliases,
    ...(current.frontmatter.summary === null ? {} : { summary: current.frontmatter.summary }),
    intent: 'user',
  };
  await docs.remove(proposal.docId, { base: current.meta.rev, intent: 'user' });
  return {
    kind: 'applied',
    notice: `已删除《${proposal.title}》，文件已移入系统回收站；本次运行内仍可撤销（撤销是重建，不从回收站取回）`,
    createdId: null,
    undo: { kind: 'restore-deleted', title: proposal.title, input },
  };
};

export const undoLabel = (undo: UndoAction): string => {
  if (undo.kind === 'restore-body') return `撤销替换《${undo.title}》`;
  if (undo.kind === 'remove-created') return `撤销新建《${undo.title}》`;
  return `撤销删除《${undo.title}》`;
};

/** 执行逆向操作，返回给界面展示的结果文案 */
export const undoProposalDoc = async (docs: ProposalDocs, undo: UndoAction): Promise<string> => {
  if (undo.kind === 'restore-body') {
    const latest = await docs.read(undo.docId);
    const currentBody = splitFrontmatter(latest.text).body;
    // AI 替换之后若又有人工编辑，按 latest.rev 写回旧正文会把它一并吞掉：
    // 拒绝静默覆盖，抛错交调用方提示
    if (currentBody !== undo.appliedBody) {
      throw new EmberError('stale_revision', UNDO_STALE_MESSAGE);
    }
    await docs.update(undo.docId, { body: undo.body }, { base: latest.meta.rev, intent: 'user' });
    return `已撤销对《${undo.title}》的替换`;
  }
  if (undo.kind === 'remove-created') {
    const created = await docs.read(undo.docId);
    await docs.remove(undo.docId, { base: created.meta.rev, intent: 'user' });
    return '已撤销新建，文件已移入系统回收站';
  }
  await docs.create(undo.input);
  return `已恢复《${undo.title}》`;
};
