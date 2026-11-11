import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { isEscTop, useEscLayer } from '../esc-arbiter.ts';
import { FloatSwitcher } from '../editor/FloatSwitcher.tsx';
import { GalleryEntry } from './GalleryEntry.tsx';
import { PomodoroEntry } from './PomodoroEntry.tsx';
import { RecallEntry } from './RecallEntry.tsx';
import { useToolCommands, type ToolPanelKey } from './tool-commands.ts';
import styles from './ToolRail.module.css';

/**
 * 画布左下角的唯一横排：侧栏启动图标之后的全部入口。
 * 顺序固定为 今日回顾 → 番茄钟 → 图库 → 浮窗胶囊，
 * 胶囊永远在最后：入口增删只影响它自己的位置，前面的按钮不会被顶动。
 * 同一时间只展开一个工具面板，避免两个浮层在左下角互相遮挡。
 */
export const ToolRail = (): ReactElement => {
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
      <RecallEntry
        open={panel === 'recall'}
        onToggle={() => {
          toggle('recall');
        }}
        onClose={() => {
          setPanel(null);
        }}
      />
      <PomodoroEntry
        open={panel === 'pomodoro'}
        onToggle={() => {
          toggle('pomodoro');
        }}
        onClose={() => {
          setPanel(null);
        }}
      />
      <GalleryEntry
        open={panel === 'gallery'}
        onToggle={() => {
          toggle('gallery');
        }}
        onClose={() => {
          setPanel(null);
        }}
      />
      <FloatSwitcher />
    </div>
  );
};
