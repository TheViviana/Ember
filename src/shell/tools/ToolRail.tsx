import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { isEscTop, useEscLayer } from '../esc-arbiter.ts';
import { FloatSwitcher } from '../editor/FloatSwitcher.tsx';
import { PomodoroEntry } from './PomodoroEntry.tsx';
import { useToolCommands, type ToolPanelKey } from './tool-commands.ts';
import entryStyles from './ToolEntry.module.css';
import styles from './ToolRail.module.css';

export interface ToolRailProps {
  /** 工具能力化开关（settings.ui.tool*，默认全关）：关闭时入口不出现 */
  readonly entries: { readonly pomodoro: boolean; readonly gallery: boolean };
  /** 附件面板入口（与左下角按钮同一开关态，面板本体由 App 挂载） */
  readonly onOpenAttachments: () => void;
  readonly attachmentsOpen: boolean;
}

/**
 * 画布左下角的唯一横排：常驻工具入口 + 浮窗胶囊。
 * 工具入口能力化：默认关闭，设置里开启后才出现；胶囊永远在最后，
 * 入口增删只影响它自己的位置，前面的按钮不会被顶动。
 * 同一时间只展开一个工具面板，避免两个浮层在左下角互相遮挡。
 */
export const ToolRail = ({ entries, onOpenAttachments, attachmentsOpen }: ToolRailProps): ReactElement => {
  const [panel, setPanel] = useState<ToolPanelKey | null>(null);

  // 命令总线的「打开某面板」与横排按钮共用同一份开关状态
  const openPanel = useCallback((key: ToolPanelKey): void => {
    setPanel(key);
  }, []);
  useToolCommands(openPanel);

  // Esc 关闭当前面板：统一仲裁，更晚打开的浮层（设置/命令面板/专注浮窗）优先
  useEscLayer('tool-panel', panel !== null);

  useEffect(() => {
    if (panel === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      // IME 组合态按 Esc 是取消候选词，不该连带关掉面板
      if (event.isComposing) return;
      if (!isEscTop('tool-panel')) return;
      setPanel(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [panel]);

  const toggle = (key: ToolPanelKey): void => {
    setPanel((current) => (current === key ? null : key));
  };

  return (
    <div className={styles.rail} data-tool-rail="">
      {entries.pomodoro ? (
        <PomodoroEntry
          open={panel === 'pomodoro'}
          onToggle={() => {
            toggle('pomodoro');
          }}
          onClose={() => {
            setPanel(null);
          }}
        />
      ) : null}
      {entries.gallery ? (
        <button
          type="button"
          className={entryStyles.entry}
          aria-expanded={attachmentsOpen}
          title="附件面板"
          onClick={onOpenAttachments}
        >
          ◧ 附件
        </button>
      ) : null}
      <FloatSwitcher />
    </div>
  );
};
