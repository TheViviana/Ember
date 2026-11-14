import { useEffect } from 'react';
import { asCommandId, type CommandId } from '#doc-model';
import { useKernel } from '../kernel-provider.tsx';

export type ToolPanelKey = 'pomodoro';

const commandId = (value: string): CommandId => {
  const id = asCommandId(value);
  if (id === null) throw new Error(`非法命令 id：${value}`);
  return id;
};

export const TOOL_POMODORO_COMMAND = commandId('ember.tool.pomodoro');

/**
 * 左下角工具面板的打开命令。
 * 与新建/导入命令一样注册到 kernel.commands，⌘K 面板与编辑器 `/` 菜单从同一总线读取，
 * 指令只是把已有面板切到打开态，不新增任何落盘字段。
 *
 * `enabled` 与入口按钮共用同一个开关（settings.ui.toolPomodoro）：关闭时**不注册**，
 * 这样 ⌘K 与 `/` 菜单里不会留下一个「点了没入口」的命令，与按钮消失保持一致。
 */
export const useToolCommands = (open: (panel: ToolPanelKey) => void, enabled: boolean): void => {
  const kernel = useKernel();

  useEffect(() => {
    if (!enabled) return;
    const pomodoro = kernel.commands.register<void>({
      id: TOOL_POMODORO_COMMAND,
      title: '打开番茄钟',
      scope: 'global',
      run: () => {
        open('pomodoro');
      },
    });

    return () => {
      pomodoro.dispose();
    };
  }, [kernel, open, enabled]);
};
