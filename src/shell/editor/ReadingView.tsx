import type { ReactElement } from 'react';
import { MarkdownView } from '../canvas/MarkdownView.tsx';
import { AssetImage } from './AssetImage.tsx';
import styles from './ReadingView.module.css';

/** 阅读栏宽度：组件内常量，不新增 CSS 变量 */
const READING_COLUMN_WIDTH = '680px';

const renderImage = (src: string, alt: string): ReactElement => (
  <AssetImage src={src} alt={alt} />
);

export interface ReadingViewProps {
  readonly markdown: string;
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
  onWikiLink,
  translations,
  note = null,
}: ReadingViewProps): ReactElement => (
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
