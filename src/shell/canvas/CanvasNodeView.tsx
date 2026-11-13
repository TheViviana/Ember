import { memo, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { CanvasNode, CanvasRect } from '#canvas-engine';
import type { DocMeta } from '../../kernel/types.ts';
import { useAssetImage, useNearViewport } from '../attachments/asset-thumbnail.ts';
import { cssVars } from './css-vars.ts';
import { RESIZE_CORNERS, RESIZE_HANDLE_PX, RESIZE_HIT_PX } from './geometry.ts';
import { MarkdownView } from './MarkdownView.tsx';
import { resolveNodeTags } from './node-tags.ts';
import styles from './CanvasNodeView.module.css';

/** Portal 节点的目标画布信息（由 render-pass 从画布清单解析） */
export interface PortalInfo {
  readonly target: string;
  readonly title: string;
  readonly nodeCount: number;
  /** 目标画布已被删除 */
  readonly missing: boolean;
}

export interface CanvasNodeViewProps {
  readonly node: CanvasNode;
  /** 拖动中的临时矩形优先于 node.rect */
  readonly rect: CanvasRect;
  readonly selected: boolean;
  readonly doc: DocMeta | null;
  readonly editing: boolean;
  /** 正在被拖拽连线指向（高亮用） */
  readonly connectTarget: boolean;
  /** 过滤器不匹配时压暗 */
  readonly dimmed?: boolean;
  /** 在画布中定位：短暂高亮 */
  readonly highlighted?: boolean;
  /** portal 节点的目标画布信息；其它 kind 为 null */
  readonly portal: PortalInfo | null;
  readonly onStartEdit: (id: string) => void;
  readonly onCommitText: (id: string, text: string) => void;
  /** 文档节点双击打开浮窗 */
  readonly onOpenDoc: (id: string) => void;
  /** Portal 节点双击进入目标画布 */
  readonly onEnterPortal: (target: string) => void;
  /** 图片节点双击打开大图 */
  readonly onOpenAsset: (assetPath: string) => void;
}

/** 图片节点视图：懒加载缩略图 + 失效资产占位（独立组件以便使用 hook） */
const ImageNodeView = ({
  node,
  rect,
  selected,
  connectTarget,
  dimmed,
  highlighted,
  assetPath,
  onOpenAsset,
}: {
  readonly node: CanvasNode;
  readonly rect: CanvasRect;
  readonly selected: boolean;
  readonly connectTarget: boolean;
  readonly dimmed: boolean;
  readonly highlighted: boolean;
  readonly assetPath: string | null;
  readonly onOpenAsset: (assetPath: string) => void;
}): ReactElement => {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const near = useNearViewport(shellRef);
  const image = useAssetImage(assetPath ?? '', near && assetPath !== null);
  const className = [
    styles.node,
    styles.image,
    selected ? styles.selected : '',
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ');
  return (
    <div
      ref={shellRef}
      className={[styles.shell, connectTarget ? styles.connectTarget : '', dimmed ? styles.dimmed : '', highlighted ? styles.highlighted : '']
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .join(' ')}
      data-node-id={node.id}
      data-color={colorOf(node)}
      data-editing="false"
      style={positionVars(rect)}
      onDoubleClick={
        assetPath === null
          ? undefined
          : (event) => {
              event.stopPropagation();
              onOpenAsset(assetPath);
            }
      }
    >
      <div className={className}>
        {assetPath === null ? (
          <p className={styles.imageMissing}>资产路径缺失</p>
        ) : image.loading && image.dataUrl === null ? (
          <p className={styles.imageHint}>加载中…</p>
        ) : image.dataUrl !== null ? (
          <img className={styles.imageBody} src={image.dataUrl} alt={assetPath ?? ''} draggable={false} />
        ) : (
          <p className={styles.imageMissing}>图片读取失败</p>
        )}
      </div>
      <span className={styles.anchorLeft} data-anchor-side="left" aria-hidden="true" />
      <span className={styles.anchorRight} data-anchor-side="right" aria-hidden="true" />
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
};

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
  dimmed = false,
  highlighted = false,
  portal,
  onStartEdit,
  onCommitText,
  onOpenDoc,
  onEnterPortal,
  onOpenAsset,
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
    node.kind === 'portal' ? styles.portal : '',
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
        // IME 组合态的 Esc 是取消候选词，不得把半截拼音提交为节点内容
        if (event.nativeEvent.isComposing) return;
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
      className={[
        styles.shell,
        connectTarget ? styles.connectTarget : '',
        dimmed ? styles.dimmed : '',
        highlighted ? styles.highlighted : '',
      ]
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

  /** 图片节点：缩略图进画布，双击看大图 */
  if (node.kind === 'image') {
    const metaAssetPath = node.meta['assetPath'];
    const assetPath = typeof metaAssetPath === 'string' ? metaAssetPath : null;
    return <ImageNodeView node={node} rect={rect} selected={selected} connectTarget={connectTarget}
      dimmed={dimmed} highlighted={highlighted} assetPath={assetPath} onOpenAsset={onOpenAsset} />;
  }

  if (node.kind === 'doc') {
    // 失效占位（I8）：文件被外部删除后节点保留灰色占位，不自动消失；
    // 右键「删除」即清理；从回收站放回后目录对账恢复，占位自动变回可用。
    const missing = doc === null;
    const summary = missing ? '文件已从库内消失，右键可清理；放回后自动恢复' : doc.summary;
    return shell(
      <article className={[className, missing ? styles.missing : ''].join(' ')}>
        <header className={styles.header}>
          <span className={styles.title} title={doc?.title ?? ''}>
            {doc?.title ?? '已失效'}
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
        if (!missing) onOpenDoc(node.id);
      },
    );
  }

  /** Portal：代表另一张画布，双击进入，可显示该画布节点数 */
  if (node.kind === 'portal' && portal !== null) {
    return shell(
      <article className={className}>
        <header className={styles.header}>
          <span className={styles.title} title={portal.title}>
            {portal.title}
          </span>
          <span className={styles.kind} role="img" aria-label="画布" title="画布">
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
              <rect
                x="2"
                y="2"
                width="5"
                height="5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
              />
              <rect
                x="9"
                y="2"
                width="5"
                height="5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
              />
              <rect
                x="2"
                y="9"
                width="5"
                height="5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
              />
              <rect
                x="9"
                y="9"
                width="5"
                height="5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
              />
            </svg>
          </span>
        </header>
        <p className={styles.summary}>
          {portal.missing ? '目标画布已删除' : `${portal.nodeCount} 个节点 · 双击进入`}
        </p>
        <span className={styles.portalHint} aria-hidden="true">
          ⇥
        </span>
      </article>,
      () => {
        if (!portal.missing) onEnterPortal(portal.target);
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
