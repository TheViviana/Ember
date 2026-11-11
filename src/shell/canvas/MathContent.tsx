import katex from 'katex';
import 'katex/dist/katex.min.css';
import type { ReactElement } from 'react';
import styles from './MarkdownView.module.css';

export interface MathContentProps {
  readonly tex: string;
  /** true = 块级公式（$$...$$），false = 行内公式（$...$） */
  readonly display: boolean;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * KaTeX 本地渲染：CSS 与字体由 Vite 打包，不引用 CDN。
 * throwOnError 打开后出错会抛异常，这里降级成「原始 TeX + 可见错误说明」，不会整段消失。
 */
export const MathContent = ({ tex, display }: MathContentProps): ReactElement => {
  try {
    const html = katex.renderToString(tex, {
      displayMode: display,
      throwOnError: true,
      strict: 'ignore',
      output: 'html',
      trust: false,
    });
    return display ? (
      <div className={styles.mathBlock} dangerouslySetInnerHTML={{ __html: html }} />
    ) : (
      <span className={styles.mathInline} dangerouslySetInnerHTML={{ __html: html }} />
    );
  } catch (error) {
    return (
      <span className={styles.mathError} role="alert">
        <code className={styles.mathErrorTex}>{tex}</code>
        <span className={styles.mathErrorNote}>公式语法错误：{errorMessage(error)}</span>
      </span>
    );
  }
};
