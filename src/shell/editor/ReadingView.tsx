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
}

/**
 * 文章浮窗的阅读态：与 canvas note 共用同一棵阅读渲染树。
 * 只接管滚动容器，图片与双链由本层注入，不污染 MarkdownView。
 */
export const ReadingView = ({ markdown, onWikiLink }: ReadingViewProps): ReactElement => (
  <div className={styles.scroll}>
    <div className={styles.column} style={{ maxWidth: READING_COLUMN_WIDTH }}>
      <MarkdownView
        markdown={markdown}
        className={styles.article}
        renderImage={renderImage}
        onWikiLink={onWikiLink}
      />
    </div>
  </div>
);
