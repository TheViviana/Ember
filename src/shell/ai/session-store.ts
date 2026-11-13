import type { DocId } from '#doc-model';
import type { DocRevision } from '../../kernel/types.ts';
import { createTauriAiSessionPort, type AiSessionPort } from '../../data/tauri/ai-session-port.ts';
import { toErrorText } from '../../kernel/errors.ts';

// -------- 持久化文件 schema --------

/** 持久化 turns：只存 role + content，id 恢复时重新编号 */
export interface AiSessionTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/** 持久化 proposal：与 proposal.ts 的 Proposal 字段对齐但 rev 不持久化 */
export type AiSessionProposalFile =
  | {
      readonly kind: 'replace';
      readonly docId: DocId;
      readonly base: { readonly hash: string };
      readonly title: string;
      readonly body: string;
      readonly previousBody: string;
    }
  | { readonly kind: 'create'; readonly title: string; readonly body: string }
  | {
      readonly kind: 'delete';
      readonly docId: DocId;
      readonly base: { readonly hash: string };
      readonly title: string;
    };

/** 持久化文件 v1 */
export interface AiSessionFileV1 {
  readonly schemaVersion: 1;
  readonly vaultId: string;
  readonly turns: readonly AiSessionTurn[];
  readonly proposal: AiSessionProposalFile | null;
  /** 崩溃恢复时 applying 转 pending proposal，绝不自动重放 */
  readonly state: 'idle' | 'streaming' | 'applying';
  readonly applyingProposal: AiSessionProposalFile | null;
  readonly savedAt: string;
}

export const CURRENT_SESSION_SCHEMA = 1;
export const MAX_PERSISTED_TURNS = 100;
export const MAX_SESSION_FILE_BYTES = 1024 * 1024; // Rust 侧上限相同
export const MAX_INBOUND_TURNS = 500; // 拒绝注入离谱的脏数据

// -------- 纯函数工具 --------

/** 截取最后 N 条 turn；系统 prompt（role=system）不持久化 */
export const trimTurns = (turns: readonly AiSessionTurn[], max = MAX_PERSISTED_TURNS): AiSessionTurn[] => {
  const filtered = turns.filter((t) => t.role === 'user' || t.role === 'assistant');
  if (filtered.length <= max) return filtered;
  return filtered.slice(filtered.length - max);
};

/** 构造持久化文件：Applying 状态下同时写 proposal + applyingProposal（同内容） */
export const buildSessionFile = (input: {
  vaultId: string;
  turns: readonly AiSessionTurn[];
  proposal: AiSessionProposalFile | null;
  state: 'idle' | 'streaming' | 'applying';
}): AiSessionFileV1 => {
  const trimmed = trimTurns(input.turns);
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  return {
    schemaVersion: CURRENT_SESSION_SCHEMA,
    vaultId: input.vaultId,
    turns: trimmed,
    proposal: input.state === 'applying' ? null : input.proposal,
    state: input.state,
    applyingProposal: input.state === 'applying' ? input.proposal : null,
    savedAt: now,
  };
};

/** 安全 parse：返回 { ok: true, value } 或 { ok: false, reason } */
const safeParse = (text: string): { ok: true; value: unknown } | { ok: false; reason: string } => {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (cause) {
    return { ok: false, reason: toErrorText(cause) };
  }
};

/** 校验 schema + 字段类型，返回规范化文件 */
const validateAndNormalize = (raw: unknown): AiSessionFileV1 | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const version = obj.schemaVersion;
  if (version !== CURRENT_SESSION_SCHEMA) return null;
  const vaultId = obj.vaultId;
  if (typeof vaultId !== 'string' || vaultId.length === 0) return null;
  // turns
  const rawTurns = obj.turns;
  const turns: AiSessionTurn[] = [];
  if (Array.isArray(rawTurns)) {
    for (const t of rawTurns) {
      if (typeof t !== 'object' || t === null) continue;
      const role = (t as Record<string, unknown>).role;
      const content = (t as Record<string, unknown>).content;
      if ((role === 'user' || role === 'assistant') && typeof content === 'string') {
        turns.push({ role, content });
      }
      if (turns.length >= MAX_INBOUND_TURNS) break;
    }
  }
  // state
  const state = obj.state;
  const normalizedState =
    state === 'idle' || state === 'streaming' || state === 'applying'
      ? (state)
      : 'idle';
  // proposal / applyingProposal（只校验 kind 字段存在）
  const normalizeProposal = (value: unknown): AiSessionProposalFile | null => {
    if (typeof value !== 'object' || value === null) return null;
    const p = value as Record<string, unknown>;
    const kind = p.kind;
    if (kind === 'replace' || kind === 'delete') {
      if (typeof p.docId !== 'string' || typeof p.title !== 'string') return null;
      const base = p.base as { hash: unknown } | undefined;
      if (!base || typeof base.hash !== 'string') return null;
      if (kind === 'replace') {
        if (typeof p.body !== 'string' || typeof p.previousBody !== 'string') return null;
        return {
          kind: 'replace',
          docId: p.docId as DocId,
          base: { hash: base.hash },
          title: p.title,
          body: p.body,
          previousBody: p.previousBody,
        };
      }
      return {
        kind: 'delete',
        docId: p.docId as DocId,
        base: { hash: base.hash },
        title: p.title,
      };
    }
    if (kind === 'create') {
      if (typeof p.title !== 'string' || typeof p.body !== 'string') return null;
      return { kind: 'create', title: p.title, body: p.body };
    }
    return null;
  };
  const proposal = normalizeProposal(obj.proposal);
  const applying = normalizeProposal(obj.applyingProposal);
  return {
    schemaVersion: CURRENT_SESSION_SCHEMA,
    vaultId,
    turns: trimTurns(turns),
    proposal,
    state: normalizedState,
    applyingProposal: applying,
    savedAt: typeof obj.savedAt === 'string' ? obj.savedAt : new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
};

/**
 * 应用层 API：从持久化 JSON 水合，自动降级、自动过期校验。
 * 返回 { file, staleProposalIds, applyingDowngraded, error }
 */
export interface HydrateInput {
  vaultId: string;
  /** docs.read 封装，用于校验 proposal 的 base.hash 是否仍然有效 */
  readDoc: (id: DocId) => Promise<{ meta: { rev: DocRevision } } | null>;
  port: AiSessionPort;
}

export interface HydrateResult {
  readonly turns: AiSessionTurn[];
  readonly proposal: AiSessionProposalFile | null;
  /** 恢复时 applying 转 pending 的 proposal（同内容） */
  readonly applyingDowngraded: boolean;
  /** base.hash 过期的 proposal（含 applyingProposal 降级过来的） */
  readonly staleProposalMessage: string | null;
  /** 持久化文件损坏 / schema 过高时的提示 */
  readonly fileError: string | null;
}

/** 过期判定：replace / delete 的 base.hash 必须与当前磁盘 hash 一致 */
const isStale = async (
  proposal: AiSessionProposalFile | null,
  readDoc: HydrateInput['readDoc'],
): Promise<boolean> => {
  if (proposal === null) return false;
  if (proposal.kind === 'create') return false; // create 不依赖现有文档 hash
  const doc = await readDoc(proposal.docId);
  return doc === null || doc.meta.rev.hash !== proposal.base.hash;
};

export const hydrateSession = async (input: HydrateInput): Promise<HydrateResult> => {
  const raw = await input.port.read(input.vaultId);
  if (raw === null) {
    return {
      turns: [],
      proposal: null,
      applyingDowngraded: false,
      staleProposalMessage: null,
      fileError: null,
    };
  }
  if (raw.length > MAX_SESSION_FILE_BYTES) {
    return {
      turns: [],
      proposal: null,
      applyingDowngraded: false,
      staleProposalMessage: null,
      fileError: `AI 会话文件超过 ${MAX_SESSION_FILE_BYTES / 1024} KB，无法读取`,
    };
  }
  const parsed = safeParse(raw);
  if (!parsed.ok) {
    return {
      turns: [],
      proposal: null,
      applyingDowngraded: false,
      staleProposalMessage: null,
      fileError: `AI 会话文件损坏（JSON 解析失败）：${parsed.reason}`,
    };
  }
  const normalized = validateAndNormalize(parsed.value);
  if (normalized === null) {
    return {
      turns: [],
      proposal: null,
      applyingDowngraded: false,
      staleProposalMessage: null,
      fileError: 'AI 会话文件 schema 不支持或字段缺失',
    };
  }
  // 崩溃恢复：applyingProposal → 普通 pending proposal
  let working: AiSessionProposalFile | null = normalized.proposal;
  let applyingDowngraded = false;
  if (normalized.applyingProposal !== null && normalized.state === 'applying') {
    working = normalized.applyingProposal;
    applyingDowngraded = true;
  }
  // 过期校验
  const stale = await isStale(working, input.readDoc);
  let staleMessage: string | null = null;
  if (stale) {
    staleMessage = applyingDowngraded
      ? '上次程序在应用 AI 提案时意外退出，该提案已过期（文档在此期间被修改），请重新生成。'
      : 'AI 生成的提案已过期（原文档在此期间被修改），请重新生成。';
    working = null;
  }
  return {
    turns: normalized.turns as AiSessionTurn[],
    proposal: working,
    applyingDowngraded,
    staleProposalMessage: staleMessage,
    fileError: null,
  };
};

/** 持久化写入；静默吞掉错误（端口层已有 warn） */
export const persistSession = async (input: {
  vaultId: string;
  turns: readonly AiSessionTurn[];
  proposal: AiSessionProposalFile | null;
  state: 'idle' | 'streaming' | 'applying';
  port: AiSessionPort;
}): Promise<void> => {
  const file = buildSessionFile(input);
  const json = JSON.stringify(file);
  if (json.length > MAX_SESSION_FILE_BYTES) {
    console.warn('AI 会话持久化跳过：JSON 超过 1 MiB 上限');
    return;
  }
  await input.port.write(input.vaultId, json);
};

// -------- 默认端口（Tauri） --------

let defaultPort: AiSessionPort | null = null;
export const getDefaultSessionPort = (): AiSessionPort => {
  if (defaultPort === null) defaultPort = createTauriAiSessionPort();
  return defaultPort;
};
