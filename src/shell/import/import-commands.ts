import { useEffect } from 'react';
import { asCommandId, type CommandId } from '#doc-model';
import { useKernel } from '../kernel-provider.tsx';
import { useImportStore } from './import-store.ts';

export const IMPORT_FILES_COMMAND = 'ember.import.markdown';
export const IMPORT_FOLDER_COMMAND = 'ember.import.folder';

const commandId = (value: string): CommandId => {
  const id = asCommandId(value);
  if (id === null) throw new Error(`非法命令 id：${value}`);
  return id;
};

/**
 * 导入命令：只负责打开对话框，真正的写盘在用户确认预览清单之后。
 * 与其它命令一样挂在 kernel.commands 上，斜杠菜单与 ⌘K 面板共用同一总线。
 */
export const useImportCommands = (): void => {
  const kernel = useKernel();

  useEffect(() => {
    const files = kernel.commands.register<void>({
      id: commandId(IMPORT_FILES_COMMAND),
      title: '导入 Markdown 文件',
      scope: 'global',
      run: () => {
        useImportStore.getState().request('files');
      },
    });

    const folder = kernel.commands.register<void>({
      id: commandId(IMPORT_FOLDER_COMMAND),
      title: '导入 Markdown 文件夹',
      scope: 'global',
      run: () => {
        useImportStore.getState().request('folder');
      },
    });

    return () => {
      files.dispose();
      folder.dispose();
    };
  }, [kernel]);
};
