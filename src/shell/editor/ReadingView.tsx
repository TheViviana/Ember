import { useCallback, type ReactElement } from 'react';
import { MarkdownView } from '../canvas/MarkdownView.tsx';
import { AssetImage } from './AssetImage.tsx';
import styles from './ReadingView.module.css';

/** 阅读栏宽度：组件内常量，不新增 CSS 变量 */
const READING_COLUMN_WIDTH = '680px';

export interface ReadingViewProps {
  readonly markdown: string;
  /** 文章在库内的相对路径；正文图片按它解析文章目录与 images/ 子目录 */
  readonly documentPath?: string | null;
  readonly onWikiLink: (target: string) => void;
  /** 顶层块下标 → 译文纯文本；只在这里渲染，不写回正文 */
  readonly translations?: Readonly<Record<number, string>>;
  /** 翻译状态提示（失败 / 无需翻译 / 未配置） */
  readonly note?: string | null;
}

/**
 * 文章浮窗的阅读态：与 canvas note 共用同一棵阅读渲染树。
 * 只接管滚动容器，图片与双链由本层注入，不污染 MarkdownView。
 * 双语对照的译文按块下标追加在原文下方，始终是纯文本节点。
 */
export const ReadingView = ({
  markdown,
  documentPath = null,
  onWikiLink,
  translations,
  note = null,
}: ReadingViewProps): ReactElement => {
  const renderImage = useCallback(
    (src: string, alt: string): ReactElement => (
      <AssetImage src={src} alt={alt} documentPath={documentPath} />
    ),
    [documentPath],
  );

  return (
    <div className={styles.scroll}>
      <div className={styles.column} style={{ maxWidth: READING_COLUMN_WIDTH }}>
        {note === null ? null : (
          <p className={styles.note} role="status">
            {note}
          </p>
        )}
        <MarkdownView
          markdown={markdown}
          className={styles.article}
          renderImage={renderImage}
          onWikiLink={onWikiLink}
          renderBlockExtra={(block, index) => {
            if (translations === undefined) return null;
            const text = translations[index];
            if (text === undefined || text.trim() === '') return null;
            return (
              <p className={styles.translation} data-read-translation={`${block.kind}-${index}`}>
                {text}
              </p>
            );
          }}
        />
      </div>
    </div>
  );
};
