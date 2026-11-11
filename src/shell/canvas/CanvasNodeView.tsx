import { memo, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { CanvasNode, CanvasRect } from '#canvas-engine';
import type { DocMeta } from '../../kernel/types.ts';
import { cssVars } from './css-vars.ts';
import { RESIZE_CORNERS, RESIZE_HANDLE_PX, RESIZE_HIT_PX } from './geometry.ts';
import { MarkdownView } from './MarkdownView.tsx';
import { resolveNodeTags } from './node-tags.ts';
import styles from './CanvasNodeView.module.css';

export interface CanvasNodeViewProps {
  readonly node: CanvasNode;
  /** 拖动中的临时矩形优先于 node.rect */
  readonly rect: CanvasRect;
  readonly selected: boolean;
  readonly doc: DocMeta | null;
  readonly editing: boolean;
  /** 正在被拖拽连线指向（高亮用） */
  readonly connectTarget: boolean;
  readonly onStartEdit: (id: string) => void;
  readonly onCommitText: (id: string, text: string) => void;
  /** 文档节点双击打开浮窗 */
  readonly onOpenDoc: (id: string) => void;
}

const positionVars = (rect: CanvasRect): ReturnType<typeof cssVars> =>
  cssVars({
    '--node-x': `${rect.x}px`,
    '--node-y': `${rect.y}px`,
    '--node-w': `${rect.w}px`,
    '--node-h': `${rect.h}px`,
    '--resize-handle': `${RESIZE_HANDLE_PX}px`,
    '--resize-hit': `${RESIZE_HIT_PX}px`,
  });

const colorOf = (node: CanvasNode): string | null => {
  const value = node.meta.color;
  return typeof value === 'string' && value.length > 0 ? value : null;
};

/** memo 隔离：画布平移/缩放与其它节点拖动时，未受影响节点的 props 全部引用稳定，整体跳过重渲染 */
export const CanvasNodeView = memo(function CanvasNodeView({
  node,
  rect,
  selected,
  doc,
  editing,
  connectTarget,
  onStartEdit,
  onCommitText,
  onOpenDoc,
}: CanvasNodeViewProps): ReactElement {
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const [draft, setDraft] = useState(node.text ?? '');
  /** 只在 editing 的 false→true 沿初始化草稿：编辑中外部更新不得清空正在输入的内容 */
  const wasEditingRef = useRef(false);

  useEffect(() => {
    if (editing === wasEditingRef.current) return;
    wasEditingRef.current = editing;
    if (!editing) return;
    setDraft(node.text ?? '');
    areaRef.current?.focus();
    areaRef.current?.select();
  }, [editing, node.text]);

  const tags = useMemo(
    () => resolveNodeTags(node.kind, node.meta, doc?.tags),
    [node.kind, node.meta, doc],
  );

  const tagList =
    tags.length === 0 ? null : (
      <div className={styles.tags}>
        {tags.map((tag, index) => (
          <span key={`${tag}-${index}`} className={styles.tag}>
            {tag}
          </span>
        ))}
      </div>
    );

  const className = [
    styles.node,
    node.kind === 'group' ? styles.group : '',
    node.kind === 'note' ? styles.note : '',
    node.kind === 'doc' ? styles.doc : '',
    selected ? styles.selected : '',
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ');

  /** 自由文本与分组标题共用同一套就地编辑交互：失焦 / Esc / ⌘+Enter 退出，均保留未保存内容 */
  const textArea = (areaClass: string | undefined): ReactElement => (
    <textarea
      ref={areaRef}
      className={areaClass}
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
      }}
      onBlur={() => {
        onCommitText(node.id, draft);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onCommitText(node.id, draft);
        }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          onCommitText(node.id, draft);
        }
      }}
    />
  );

  /** 外层只负责定位与锚点，内层保留原来的排版与裁剪 */
  const shell = (content: ReactElement, onDouble: (() => void) | null): ReactElement => (
    <div
      className={[styles.shell, connectTarget ? styles.connectTarget : '']
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .join(' ')}
      data-node-id={node.id}
      data-color={colorOf(node)}
      data-editing={editing ? 'true' : 'false'}
      style={positionVars(rect)}
      onDoubleClick={
        onDouble === null
          ? undefined
          : (event) => {
              event.stopPropagation();
              onDouble();
            }
      }
    >
      {content}
      {node.kind === 'group' ? null : (
        <>
          <span className={styles.anchorLeft} data-anchor-side="left" aria-hidden="true" />
          <span className={styles.anchorRight} data-anchor-side="right" aria-hidden="true" />
        </>
      )}
      {/* 四角手柄只给选中节点（含组）：热区屏幕像素固定，缩放不影响可点性 */}
      {selected
        ? RESIZE_CORNERS.map((corner) => (
            <span
              key={corner}
              className={styles.resize}
              data-resize-corner={corner}
              data-corner={corner}
              aria-hidden="true"
            />
          ))
        : null}
    </div>
  );

  if (node.kind === 'group') {
    return shell(
      <div className={className}>
        {editing ? (
          textArea(styles.groupArea)
        ) : (
          <span className={styles.groupTitle}>{node.text ?? '分组'}</span>
        )}
      </div>,
      () => {
        onStartEdit(node.id);
      },
    );
  }

  if (node.kind === 'doc') {
    const summary = doc === null ? '节点引用的文档已不在库内' : doc.summary;
    return shell(
      <article className={className}>
        <header className={styles.header}>
          <span className={styles.title} title={doc?.title ?? ''}>
            {doc?.title ?? '文档不可用'}
          </span>
          <span className={styles.kind} role="img" aria-label="文档" title="文档">
            <svg
              viewBox="0 0 16 16"
              width="12"
              height="12"
              aria-hidden="true"
              focusable="false"
            >
              <path
                d="M4 1.75h5.2L12.5 5v9.25H4V1.75Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinejoin="round"
              />
              <path
                d="M9 1.75V5h3.5M6 8h4.5M6 10.5h4.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        </header>
        {tagList}
        <p className={styles.summary}>{summary.length === 0 ? '暂无简介' : summary}</p>
      </article>,
      () => {
        onOpenDoc(node.id);
      },
    );
  }

  return shell(
    <div className={className}>
      {editing ? (
        textArea(styles.area)
      ) : (
        <>
          {node.text === null || node.text.trim().length === 0 ? (
            <p className={styles.noteHint}>双击编辑</p>
          ) : (
            <MarkdownView markdown={node.text} className={styles.noteBody ?? ''} />
          )}
          {tagList}
        </>
      )}
    </div>,
    () => {
      onStartEdit(node.id);
    },
  );
});
