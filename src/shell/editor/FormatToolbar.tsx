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
  readonly onCodeBlock: () => void;
  readonly onHorizontalRule: () => void;
  readonly onTable: () => void;
  readonly onContinue: () => void;
  readonly continueDisabled: boolean;
  readonly onToggleMode: () => void;
  readonly onHistory: () => void;
  /** 撤销 / 重做：走 CM6 历史命令，与 ⌘Z / ⇧⌘Z 同一套事务 */
  readonly onUndo: () => void;
  readonly onRedo: () => void;
  /** 整篇双语对照：文字随状态变化（翻译 / 翻译中 3/12 / 收起译文） */
  readonly translateLabel: string;
  readonly translateTitle: string;
  readonly translateDisabled: boolean;
  readonly onTranslate: () => void;
}

interface ToolButtonProps {
  readonly label: string;
  /** 图标按钮用内联 SVG 顶替文字标签；不引图标库 */
  readonly icon?: ReactElement;
  readonly title: string;
  readonly pressed?: boolean;
  readonly disabled: boolean;
  readonly onClick: () => void;
}

const ToolButton = ({ label, icon, title, pressed, disabled, onClick }: ToolButtonProps): ReactElement => {
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
      {icon ?? label}
    </button>
  );
};

/** 撤销：左向弧线箭头；只用 path，不引图标库 */
const UndoIcon = (): ReactElement => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <path d="M5.6 3.4 2.4 6.6l3.2 3.2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M2.6 6.6h6.1a3.7 3.7 0 0 1 0 7.4H6.1" strokeLinecap="round" />
  </svg>
);

/** 重做：撤销的镜像 */
const RedoIcon = (): ReactElement => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <path d="M10.4 3.4l3.2 3.2-3.2 3.2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M13.4 6.6H7.3a3.7 3.7 0 0 0 0 7.4h2.6" strokeLinecap="round" />
  </svg>
);

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
  onCodeBlock,
  onHorizontalRule,
  onTable,
  onContinue,
  continueDisabled,
  onToggleMode,
  onHistory,
  onUndo,
  onRedo,
  translateLabel,
  translateTitle,
  translateDisabled,
  onTranslate,
}: FormatToolbarProps): ReactElement => {
  const blockDisabled = disabled || state.inCodeBlock;
  if (mode === 'read') {
    return (
      <div className={styles.bar} role="toolbar" aria-label="阅读模式工具栏">
        <ToolButton label="编辑" title="返回编辑模式" disabled={disabled} onClick={onToggleMode} />
        <ToolButton
          label={translateLabel}
          title={translateTitle}
          disabled={disabled || translateDisabled}
          onClick={onTranslate}
        />
        <ToolButton label="历史" title="查看文档历史版本" disabled={false} onClick={onHistory} />
      </div>
    );
  }
  return (
    <div className={styles.bar} role="toolbar" aria-label="格式工具栏">
      <ToolButton label="阅读" title="阅读模式" disabled={disabled} onClick={onToggleMode} />
      <Divider />
      <ToolButton
        label="撤销"
        icon={<UndoIcon />}
        title="撤销"
        disabled={disabled || !state.canUndo}
        onClick={onUndo}
      />
      <ToolButton
        label="重做"
        icon={<RedoIcon />}
        title="重做"
        disabled={disabled || !state.canRedo}
        onClick={onRedo}
      />
      <Divider />
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
      <ToolButton
        label="H3"
        title="三级标题"
        pressed={state.heading === 3}
        disabled={blockDisabled}
        onClick={() => {
          onHeading(3);
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
      <ToolButton label="代码块" title="代码块围栏" disabled={blockDisabled} onClick={onCodeBlock} />
      <ToolButton label="—" title="水平分割线" disabled={blockDisabled} onClick={onHorizontalRule} />
      <ToolButton label="⊞" title="插入表格" disabled={blockDisabled} onClick={onTable} />

      <ToolButton
        label="续写"
        title="在光标处续写正文（AI）"
        disabled={disabled || continueDisabled}
        onClick={onContinue}
      />

      <span className={styles.spacer} aria-hidden="true" />
      <ToolButton
        label={translateLabel}
        title={translateTitle}
        disabled={disabled || translateDisabled}
        onClick={onTranslate}
      />
      <ToolButton label="历史" title="查看文档历史版本" disabled={false} onClick={onHistory} />
    </div>
  );
};
