import type { DecorationSet, EditorView, ViewUpdate } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import type { DocId } from '#doc-model';
import { EmberError } from './errors.ts';
import type { DocService } from './doc-service.ts';
import type { Disposable, DocSnapshot } from './types.ts';

/**
 * 一次打开文档的会话。EditorView 由 shell 创建（内核不碰 DOM），
 * 这里只提供创建视图所需的快照、扩展与装饰槽。
 */
export interface EditorSession {
  readonly docId: DocId;
  /** 打开瞬间的磁盘快照；首次保存必须把它当作 base（E2） */
  readonly snapshot: DocSnapshot;
  /** 打开时内核已登记的扩展快照（语言、主题、快捷键） */
  readonly extensions: readonly Extension[];
  /** 打开时已登记的装饰槽快照 */
  readonly slots: readonly DecorationSlot[];
  /** 关闭会话；不写盘（写盘由 doc-service 的保存流程负责） */
  close(): void;
}

export interface DecorationContext {
  readonly docId: DocId;
  readonly host: EditorHost;
}

/** 必须只按 update.changes 增量重建（I10 / E1） */
export interface DecorationProvider {
  provide(view: EditorView, update: ViewUpdate): DecorationSet;
}

export interface DecorationSlot {
  readonly id: string;
  readonly placement: 'inline' | 'gutter' | 'block';
  readonly provider: (context: DecorationContext) => DecorationProvider;
}

export interface EditorHost {
  open(docId: DocId): Promise<EditorSession>;
  active(): EditorSession | null;
  extend(extension: Extension): Disposable;
  registerDecorationSlot(slot: DecorationSlot): Disposable;
}

export interface EditorHostOptions {
  /** 打开会话时读取最新快照；由 boot 注入，避免内核内部反向依赖 */
  readonly docs: DocService;
}

interface SessionRecord {
  readonly session: EditorSession;
  refs: number;
}

export const createEditorHost = ({ docs }: EditorHostOptions): EditorHost => {
  const extensions: Extension[] = [];
  const slots = new Map<string, DecorationSlot>();
  const sessions = new Map<string, SessionRecord>();
  /** 同一文档的并发 open 共享同一次读盘（否则产生两个会话，违反 E4 幂等） */
  const loadingDocs = new Map<string, Promise<EditorSession>>();
  let activeDocId: string | null = null;

  return {
    open: (docId) => {
      const key = String(docId);
      const opened = sessions.get(key);
      if (opened !== undefined) {
        opened.refs += 1;
        activeDocId = key;
        return Promise.resolve(opened.session);
      }
      const inFlight = loadingDocs.get(key);
      if (inFlight !== undefined) {
        return inFlight.then((session) => {
          const record = sessions.get(key);
          if (record !== undefined && record.session === session) record.refs += 1;
          activeDocId = key;
          return session;
        });
      }
      const pending = (async (): Promise<EditorSession> => {
        const snapshot = await docs.read(docId);
        // 双检：读盘期间可能已有并发 open 建好会话
        const raced = sessions.get(key);
        if (raced !== undefined) return raced.session;
        const session: EditorSession = {
          docId,
          snapshot,
          extensions: [...extensions],
          slots: [...slots.values()],
          close: (): void => {
            const record = sessions.get(key);
            if (record === undefined) return;
            record.refs -= 1;
            if (record.refs > 0) return;
            sessions.delete(key);
            if (activeDocId === key) activeDocId = null;
          },
        };
        sessions.set(key, { session, refs: 1 });
        activeDocId = key;
        return session;
      })();
      loadingDocs.set(key, pending);
      void pending
        .catch(() => undefined)
        .finally(() => {
          loadingDocs.delete(key);
        });
      return pending;
    },

    active: () => (activeDocId === null ? null : (sessions.get(activeDocId)?.session ?? null)),

    extend: (extension) => {
      extensions.push(extension);
      return {
        dispose: (): void => {
          const index = extensions.indexOf(extension);
          if (index >= 0) extensions.splice(index, 1);
        },
      };
    },

    registerDecorationSlot: (slot) => {
      if (slots.has(slot.id)) {
        throw new EmberError('duplicate_slot', `装饰槽 id 重复：${slot.id}`);
      }
      slots.set(slot.id, slot);
      return {
        dispose: (): void => {
          slots.delete(slot.id);
        },
      };
    },
  };
};
