import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react';
import type { BlockFormat, FormatState, HeadingLevel, InlineFormat } from './format-commands.ts';
import styles from './FormatToolbar.module.css';

export type ToolbarMode = 'edit' | 'read';

interface FormatToolbarProps {
  readonly state: FormatState;
  readonly disabled: boolean;
  readonly mode: ToolbarMode;
  readonly onInline: (format: InlineFormat) => void;
  readonly onBlock: (format: BlockFormat) => void;
  readonly onHeading: (level: HeadingLevel) => void;
  readonly onLink: () => void;
  readonly onToggleMode: () => void;
  readonly onHistory: () => void;
}

interface ToolButtonProps {
  readonly label: string;
  readonly title: string;
  readonly pressed?: boolean;
  readonly disabled: boolean;
  readonly onClick: () => void;
}

const ToolButton = ({ label, title, pressed, disabled, onClick }: ToolButtonProps): ReactElement => {
  // 按下时阻止默认行为，保住编辑器里的选区与焦点
  const keepSelection = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    event.preventDefault();
  };
  return (
    <button
      type="button"
      className={styles.button}
      aria-label={title}
      title={title}
      aria-pressed={pressed}
      disabled={disabled}
      onPointerDown={keepSelection}
      onClick={onClick}
    >
      {label}
    </button>
  );
};

const Divider = (): ReactElement => <span className={styles.divider} aria-hidden="true" />;

/**
 * 文章浮窗内的固定格式工具栏。
 * 只是编辑器动作的入口，不持有文档状态；所有按钮通过 CM6 事务改当前 EditorView。
 */
export const FormatToolbar = ({
  state,
  disabled,
  mode,
  onInline,
  onBlock,
  onHeading,
  onLink,
  onToggleMode,
  onHistory,
}: FormatToolbarProps): ReactElement => {
  const blockDisabled = disabled || state.inCodeBlock;
  if (mode === 'read') {
    return (
      <div className={styles.bar} role="toolbar" aria-label="阅读模式工具栏">
        <ToolButton label="编辑" title="返回编辑模式" disabled={disabled} onClick={onToggleMode} />
        <ToolButton label="历史" title="查看文档历史版本" disabled={false} onClick={onHistory} />
      </div>
    );
  }
  return (
    <div className={styles.bar} role="toolbar" aria-label="格式工具栏">
      <ToolButton
        label="B"
        title="粗体"
        pressed={state.bold}
        disabled={blockDisabled}
        onClick={() => {
          onInline('bold');
        }}
      />
      <ToolButton
        label="I"
        title="斜体"
        pressed={state.italic}
        disabled={blockDisabled}
        onClick={() => {
          onInline('italic');
        }}
      />
      <ToolButton
        label="S"
        title="删除线"
        pressed={state.strike}
        disabled={blockDisabled}
        onClick={() => {
          onInline('strike');
        }}
      />
      <ToolButton
        label="</>"
        title="行内代码"
        pressed={state.code}
        disabled={blockDisabled}
        onClick={() => {
          onInline('code');
        }}
      />
      <ToolButton label="链接" title="插入链接" disabled={blockDisabled} onClick={onLink} />

      <Divider />

      <ToolButton
        label="H1"
        title="一级标题"
        pressed={state.heading === 1}
        disabled={blockDisabled}
        onClick={() => {
          onHeading(1);
        }}
      />
      <ToolButton
        label="H2"
        title="二级标题"
        pressed={state.heading === 2}
        disabled={blockDisabled}
        onClick={() => {
          onHeading(2);
        }}
      />

      <Divider />

      <ToolButton
        label="引用"
        title="引用"
        pressed={state.quote}
        disabled={blockDisabled}
        onClick={() => {
          onBlock('quote');
        }}
      />
      <ToolButton
        label="•"
        title="无序列表"
        pressed={state.list === 'ul'}
        disabled={blockDisabled}
        onClick={() => {
          onBlock('ul');
        }}
      />
      <ToolButton
        label="1."
        title="有序列表"
        pressed={state.list === 'ol'}
        disabled={blockDisabled}
        onClick={() => {
          onBlock('ol');
        }}
      />
      <ToolButton
        label="☐"
        title="任务列表"
        pressed={state.list === 'task'}
        disabled={blockDisabled}
        onClick={() => {
          onBlock('task');
        }}
      />

      <span className={styles.spacer} aria-hidden="true" />
      <ToolButton label="历史" title="查看文档历史版本" disabled={false} onClick={onHistory} />
      <ToolButton label="阅读" title="阅读模式" disabled={disabled} onClick={onToggleMode} />
    </div>
  );
};
