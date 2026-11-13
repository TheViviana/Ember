import {
  Fragment,
  memo,
  useMemo,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import { readingBlocks, type ReadBlock, type ReadInline, type TableAlign } from './read-markdown.ts';
import { MathContent } from './MathContent.tsx';
import styles from './MarkdownView.module.css';

/** 图片与双链的渲染钩子；不传时降级为纯文本（canvas note 保持原样） */
interface InlineContext {
  readonly renderImage?: ((src: string, alt: string) => ReactNode) | undefined;
  readonly onWikiLink?: ((target: string) => void) | undefined;
}

export interface MarkdownViewProps extends InlineContext {
  readonly markdown: string;
  readonly className?: string | undefined;
  /** 顶层块附加内容（阅读态译文）：只在块后追加，不改变块本身的渲染 */
  readonly renderBlockExtra?: ((block: ReadBlock, index: number) => ReactNode) | undefined;
}

const safeHref = (href: string): string | null =>
  /^(https?:|mailto:|#|\/|\.)/i.test(href) ? href : null;

const cellStyle = (align: TableAlign | undefined): CSSProperties | undefined =>
  align === null || align === undefined ? undefined : { textAlign: align };

const renderInlines = (inlines: readonly ReadInline[], context: InlineContext): ReactNode =>
  inlines.map((inline, index) => {
    switch (inline.kind) {
      case 'text':
        return inline.value;
      case 'strong':
        return <strong key={index}>{renderInlines(inline.children, context)}</strong>;
      case 'emphasis':
        return <em key={index}>{renderInlines(inline.children, context)}</em>;
      case 'code':
        return (
          <code key={index} className={styles.inlineCode}>
            {inline.value}
          </code>
        );
      case 'math':
        return <MathContent key={index} tex={inline.value} display={false} />;
      case 'link': {
        const href = safeHref(inline.href);
        if (href === null) {
          return <span key={index}>{renderInlines(inline.children, context)}</span>;
        }
        return (
          <a
            key={index}
            className={styles.link}
            href={href}
            rel="noreferrer"
            target="_blank"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            {renderInlines(inline.children, context)}
          </a>
        );
      }
      case 'image': {
        if (context.renderImage === undefined) {
          return inline.alt.length > 0 ? <span key={index}>{inline.alt}</span> : null;
        }
        return <Fragment key={index}>{context.renderImage(inline.src, inline.alt)}</Fragment>;
      }
      case 'wiki': {
        const onWikiLink = context.onWikiLink;
        if (onWikiLink === undefined) {
          // 没有点击钩子（canvas note）时保留原有字面量，不改变既有阅读外观
          const literal =
            inline.label === inline.target
              ? `[[${inline.target}]]`
              : `[[${inline.target}|${inline.label}]]`;
          return <span key={index}>{literal}</span>;
        }
        return (
          <button
            key={index}
            type="button"
            className={styles.wiki}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onWikiLink(inline.target);
            }}
          >
            {inline.label}
          </button>
        );
      }
      case 'break':
        return <br key={index} />;
    }
  });

const renderBlock = (block: ReadBlock, context: InlineContext): ReactNode => {
  switch (block.kind) {
    case 'heading': {
      const className = [styles.heading, styles[`heading${block.depth}`]]
        .filter((value): value is string => typeof value === 'string')
        .join(' ');
      const tag = `h${block.depth}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      const Heading = tag;
      return <Heading className={className}>{renderInlines(block.children, context)}</Heading>;
    }
    case 'paragraph':
      return <p className={styles.paragraph}>{renderInlines(block.children, context)}</p>;
    case 'code':
      return (
        <pre className={styles.codeBlock} data-lang={block.lang ?? undefined}>
          <code>{block.value}</code>
        </pre>
      );
    case 'math':
      return <MathContent tex={block.value} display />;
    case 'table':
      return (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                {block.header.map((cell, cellIndex) => (
                  <th key={cellIndex} style={cellStyle(block.align[cellIndex])}>
                    {renderInlines(cell, context)}
                  </th>
                ))}
              </tr>
            </thead>
            {block.rows.length === 0 ? null : (
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex} style={cellStyle(block.align[cellIndex])}>
                        {renderInlines(cell, context)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>
      );
    case 'list': {
      const items = block.items.map((item, itemIndex) => (
        <li key={itemIndex}>{renderBlocks(item, context)}</li>
      ));
      return block.ordered ? (
        <ol className={styles.list} start={block.start}>
          {items}
        </ol>
      ) : (
        <ul className={styles.list}>{items}</ul>
      );
    }
    case 'quote':
      return <blockquote className={styles.quote}>{renderBlocks(block.children, context)}</blockquote>;
    case 'rule':
      return <hr className={styles.rule} />;
    case 'text':
      return <p className={styles.paragraph}>{block.value}</p>;
  }
};

const renderBlocks = (
  blocks: readonly ReadBlock[],
  context: InlineContext,
  extras?: (block: ReadBlock, index: number) => ReactNode,
): ReactNode =>
  blocks.map((block, index) => (
    <Fragment key={index}>
      {renderBlock(block, context)}
      {extras === undefined ? null : extras(block, index)}
    </Fragment>
  ));

/** note 阅读态：mdast 渲染树 → React；只有数学公式使用 KaTeX 生成的受控 HTML。
 * memo 隔离：画布手势期间父组件高频重渲染时，markdown/className 不变的节点整体跳过。 */
export const MarkdownView = memo(function MarkdownView({
  markdown,
  className,
  renderImage,
  onWikiLink,
  renderBlockExtra,
}: MarkdownViewProps): ReactElement {
  // 拖动时组件会随 rAF 高频重渲染，解析结果按源码缓存
  const blocks = useMemo(() => readingBlocks(markdown), [markdown]);
  return (
    <div
      className={[styles.body, className ?? '']
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .join(' ')}
    >
      {renderBlocks(blocks, { renderImage, onWikiLink }, renderBlockExtra)}
    </div>
  );
});
