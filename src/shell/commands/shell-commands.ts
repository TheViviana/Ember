import { useEffect, useRef } from 'react';
import { asCommandId, createUlid, safeFileName, splitFrontmatter, type CommandId, type DocId } from '#doc-model';
import type { KernelContext } from '../../kernel/context.ts';
import { EmberError, isEmberError } from '../../kernel/errors.ts';
import { useFloatStore } from '../editor/float-store.ts';
import { useKernel } from '../kernel-provider.tsx';
import { readCapturePoint } from '../canvas/canvas-capture.ts';
import { commandDocId } from './palette.ts';

const commandId = (value: string): CommandId => {
  const id = asCommandId(value);
  if (id === null) throw new Error(`非法命令 id：${value}`);
  return id;
};

export const CREATE_DOC_COMMAND = commandId('ember.doc.create');
export const DUPLICATE_DOC_COMMAND = commandId('ember.doc.duplicate');

const pad = (value: number): string => String(value).padStart(2, '0');

/** 本地时间戳：同一秒内连续新建靠 path_exists 重试加序号 */
const stamp = (now: Date): string =>
  `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

interface NoteSeed {
  readonly summary?: string;
  readonly tags?: readonly string[];
}

const createNote = async (
  kernel: KernelContext,
  title: string,
  body: string,
  seed: NoteSeed,
): Promise<DocId> => {
  const name = safeFileName(title, { fallback: '未命名', maxLength: 60 });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-${attempt + 1}`;
    const path = kernel.paths.normalize(`notes/${name}-${stamp(new Date())}${suffix}.md`);
    try {
      const snapshot = await kernel.docs.create({
        path,
        title,
        text: body,
        intent: 'user',
        ...(seed.summary === undefined ? {} : { summary: seed.summary }),
        ...(seed.tags === undefined ? {} : { tags: seed.tags }),
      });
      return snapshot.meta.id;
    } catch (error) {
      if (!isEmberError(error) || error.code !== 'path_exists') throw error;
    }
  }
  throw new EmberError('path_exists', '同一秒内同名文档过多，换个标题再试');
};

const duplicateActive = async (kernel: KernelContext, docId: DocId): Promise<void> => {
  const source = await kernel.docs.read(docId);
  const baseTitle = source.meta.title.trim().length === 0 ? kernel.paths.stem(source.meta.path) : source.meta.title.trim();
  const summary = source.frontmatter.summary;
  const id = await createNote(kernel, `${baseTitle} 副本`, splitFrontmatter(source.text).body, {
    ...(summary === null ? {} : { summary }),
    tags: source.frontmatter.tags,
  });
  useFloatStore.getState().open(id, 'title');
};

/**
 * 注册 shell 侧命令：新建文档、复制当前文档、面板与画布入口。
 * 只通过 kernel.commands 注册，斜杠菜单与命令面板从同一个总线读取并执行。
 */
export const useShellCommands = (): void => {
  const kernel = useKernel();

  useEffect(() => {
    const create = kernel.commands.register<void>({
      id: CREATE_DOC_COMMAND,
      title: '新建文档',
      scope: 'global',
      run: async () => {
        const id = await createNote(kernel, '未命名', '', {});
        useFloatStore.getState().open(id, 'title');
      },
    });

    const duplicate = kernel.commands.register<unknown>({
      id: DUPLICATE_DOC_COMMAND,
      title: '复制当前文档',
      scope: 'editor',
      run: async (args) => {
        const docId = commandDocId(args);
        if (docId === null) {
          throw new EmberError('doc_not_found', '复制命令缺少当前文档 id');
        }
        await duplicateActive(kernel, docId);
      },
    });

    // 快捷捕获：新建文档落在当前镜头中心、进入当前画布
    const capture = kernel.commands.register<void>({
      id: CAPTURE_COMMAND,
      title: '快捷捕获（落在此处）',
      scope: 'canvas',
      run: async () => {
        const point = readCapturePoint();
        if (point === null) {
          throw new EmberError('doc_not_found', '画布未就绪，先打开一张画布');
        }
        const result = await kernel.canvas.createArticle({
          canvasId: point.canvasId as Parameters<typeof kernel.canvas.createArticle>[0]['canvasId'],
          title: '未命名',
          point: point.point,
          nodeId: `n_${createUlid()}`,
          size: { w: 320, h: 200 },
          z: point.z,
        });
        useFloatStore.getState().open(result.snapshot.meta.id, 'title');
      },
    });

    return () => {
      create.dispose();
      duplicate.dispose();
      capture.dispose();
    };
  }, [kernel]);
};

export const CAPTURE_COMMAND = commandId('ember.doc.capture');
export const PANEL_DOCUMENTS_COMMAND = commandId('ember.panel.documents');
export const PANEL_CONFLICTS_COMMAND = commandId('ember.panel.conflicts');
export const PANEL_HEALTH_COMMAND = commandId('ember.panel.health');
export const PANEL_INBOX_COMMAND = commandId('ember.panel.inbox');
export const PANEL_ATTACHMENTS_COMMAND = commandId('ember.panel.attachments');
export const AI_CHAT_COMMAND = commandId('ember.ai.chat');
export const CANVAS_OVERVIEW_COMMAND = commandId('ember.canvas.overview');
export const CANVAS_NEW_COMMAND = commandId('ember.canvas.new');

/** UI 面板与画布导航的命令：handlers 由 App 传入，命令总线只做转发 */
export const usePanelCommands = (handlers: {
  readonly openDocuments: () => void;
  readonly openConflicts: () => void;
  readonly openHealth: () => void;
  readonly openInbox: () => void;
  readonly openAttachments: () => void;
  readonly openAi: () => void;
  readonly showOverview: () => void;
  readonly createCanvas: () => void;
}): void => {
  const kernel = useKernel();
  // handlers 只是闭包转发；用 ref 持最新值，effect 只依赖 kernel——
  // 否则外壳每次渲染（library 身份变化）都会 dispose+register 一轮命令
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const documents = kernel.commands.register<void>({
      id: PANEL_DOCUMENTS_COMMAND,
      title: '打开文档列表',
      scope: 'global',
      run: () => {
        handlersRef.current.openDocuments();
      },
    });
    const conflicts = kernel.commands.register<void>({
      id: PANEL_CONFLICTS_COMMAND,
      title: '打开冲突处理中心',
      scope: 'global',
      run: () => {
        handlersRef.current.openConflicts();
      },
    });
    const health = kernel.commands.register<void>({
      id: PANEL_HEALTH_COMMAND,
      title: '库健康检查',
      scope: 'global',
      run: () => {
        handlersRef.current.openHealth();
      },
    });
    const inbox = kernel.commands.register<void>({
      id: PANEL_INBOX_COMMAND,
      title: '快速收集箱',
      scope: 'global',
      run: () => {
        handlersRef.current.openInbox();
      },
    });
    const attachments = kernel.commands.register<void>({
      id: PANEL_ATTACHMENTS_COMMAND,
      title: '打开附件面板',
      scope: 'global',
      run: () => {
        handlersRef.current.openAttachments();
      },
    });
    const ai = kernel.commands.register<void>({
      id: AI_CHAT_COMMAND,
      title: 'AI 对话',
      scope: 'global',
      run: () => {
        handlersRef.current.openAi();
      },
    });
    const overview = kernel.commands.register<void>({
      id: CANVAS_OVERVIEW_COMMAND,
      title: '进入总览画布',
      scope: 'global',
      run: () => {
        handlersRef.current.showOverview();
      },
    });
    const newCanvas = kernel.commands.register<void>({
      id: CANVAS_NEW_COMMAND,
      title: '新建画布',
      scope: 'global',
      run: () => {
        handlersRef.current.createCanvas();
      },
    });
    return () => {
      documents.dispose();
      conflicts.dispose();
      health.dispose();
      inbox.dispose();
      attachments.dispose();
      ai.dispose();
      overview.dispose();
      newCanvas.dispose();
    };
  }, [kernel]);
};
