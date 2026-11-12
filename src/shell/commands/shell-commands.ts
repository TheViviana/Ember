import { useEffect } from 'react';
import { asCommandId, safeFileName, splitFrontmatter, type CommandId, type DocId } from '#doc-model';
import type { KernelContext } from '../../kernel/context.ts';
import { EmberError, isEmberError } from '../../kernel/errors.ts';
import { useFloatStore } from '../editor/float-store.ts';
import { useKernel } from '../kernel-provider.tsx';
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
 * 注册 shell 侧命令：新建文档、复制当前文档。
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

    return () => {
      create.dispose();
      duplicate.dispose();
    };
  }, [kernel]);
};
