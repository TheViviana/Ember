import { useRef, useState, type ReactElement } from 'react';
import type { AssetEntry } from '../../data/tauri/asset-port.ts';
import { useAssetImage, useNearViewport } from './asset-thumbnail.ts';
import styles from './AttachmentPanel.module.css';

export interface AssetCardProps {
  readonly asset: AssetEntry;
  readonly expanded: boolean;
  readonly docRefs: readonly { readonly srcId: string; readonly line: number; readonly raw: string }[];
  readonly canvasRefs: readonly { readonly canvasId: string; readonly canvasTitle: string; readonly nodeId: string }[];
  readonly usageLoading: boolean;
  readonly titleOfDoc: (srcId: string) => string;
  readonly onToggle: () => void;
  readonly onOpenDoc: (srcId: string) => void;
  readonly onOpenCanvas: (canvasId: string, nodeId: string) => void;
  /** 删除入回收站；null = 只读库不可删 */
  readonly onDelete: (asset: AssetEntry) => void;
  readonly deletable: boolean;
}

/** 单张资产卡片：缩略图 + 引用统计 + 展开引用位置 + 两段式删除确认 */
export const AssetCard = ({
  asset,
  expanded,
  docRefs,
  canvasRefs,
  usageLoading,
  titleOfDoc,
  onToggle,
  onOpenDoc,
  onOpenCanvas,
  onDelete,
  deletable,
}: AssetCardProps): ReactElement => {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const near = useNearViewport(cardRef);
  const image = useAssetImage(asset.path, near);
  const [confirming, setConfirming] = useState(false);
  /** 只有 media/ 内容寻址资产归 Ember 管理；磁盘图片属于用户的库文件，不能在这里删 */
  const mediaBacked = asset.path.startsWith('media/');

  return (
    <div className={styles.card} ref={cardRef}>
      <button
        type="button"
        className={styles.thumbButton}
        title={expanded ? '收起引用位置' : '查看被引用位置'}
        onClick={onToggle}
      >
        {image.dataUrl !== null ? (
          <img className={styles.thumb} src={image.dataUrl} alt={asset.name} draggable={false} />
        ) : (
          <span className={styles.thumbPlaceholder}>{image.loading ? '…' : '图'}</span>
        )}
      </button>
      <p className={styles.name} title={asset.path}>
        {asset.name}
      </p>
      <p className={styles.meta}>
        {usageLoading
          ? '统计中…'
          : `${docRefs.length} 篇文档 · ${canvasRefs.length} 张画布引用`}
      </p>
      {expanded ? (
        <div className={styles.usages}>
          {docRefs.length === 0 && canvasRefs.length === 0 ? (
            <p className={styles.usageEmpty}>还没有任何引用</p>
          ) : null}
          {docRefs.map((ref) => (
            <button
              key={`${ref.srcId}-${ref.line}`}
              type="button"
              className={styles.usageRow}
              title={ref.raw}
              onClick={() => {
                onOpenDoc(ref.srcId);
              }}
            >
              文档：{titleOfDoc(ref.srcId)}
            </button>
          ))}
          {canvasRefs.map((ref) => (
            <button
              key={`${ref.canvasId}-${ref.nodeId}`}
              type="button"
              className={styles.usageRow}
              onClick={() => {
                onOpenCanvas(ref.canvasId, ref.nodeId);
              }}
            >
              画布：{ref.canvasTitle}（飞到图片节点）
            </button>
          ))}
          {mediaBacked ? (
            confirming ? (
              <div className={styles.deleteConfirm} role="alertdialog" aria-label="确认删除图片">
                <p className={styles.deleteWarn}>
                  {docRefs.length + canvasRefs.length > 0
                    ? `这张图正被 ${docRefs.length} 篇文档、${canvasRefs.length} 张画布引用；删除后引用处会显示占位，不会自动移除。`
                    : '删除后移入回收站（系统回收站，权限不足时为库内回收目录），可找回。'}
                </p>
                <div className={styles.deleteActions}>
                  <button
                    type="button"
                    className={styles.deleteYes}
                    onClick={() => {
                      setConfirming(false);
                      onDelete(asset);
                    }}
                  >
                    删除
                  </button>
                  <button
                    type="button"
                    className={styles.deleteNo}
                    onClick={() => {
                      setConfirming(false);
                    }}
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className={styles.deleteButton}
                disabled={!deletable}
                title={deletable ? '删除这张图片（移入回收站，可找回）' : '库为只读，无法删除'}
                onClick={() => {
                  setConfirming(true);
                }}
              >
                删除…
              </button>
            )
          ) : (
            <p className={styles.usageEmpty}>磁盘图片由库内文件直接提供，Ember 不在此处删除</p>
          )}
        </div>
      ) : null}
    </div>
  );
};
