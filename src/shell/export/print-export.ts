import { splitFrontmatter, type DocId } from '#doc-model';
import { readAsset } from '../../data/tauri/asset-port.ts';
import { localAssetPath } from '../editor/reading-asset.ts';
import { readingBlocks, type ReadBlock, type ReadInline } from '../canvas/read-markdown.ts';
import type { KernelContext } from '../../kernel/context.ts';
import { toErrorText } from '../../kernel/errors.ts';

/**
 * 导出当前文档 PDF：正文走内核唯一的 Markdown 解析管线（readingBlocks），
 * 组装成自包含 HTML 后丢进隐藏 iframe 调 print() —— 走系统打印对话框的
 * 「存储为 PDF」，不装任何导出依赖，也不引用外域资源。
 * 图片：media/ 资产读盘转 data URL 内嵌；外链一律跳过（运行时零联网）。
 */

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

type ImageResolver = (src: string) => Promise<string | null>;

const makeImageResolver = (log: KernelContext['log']): ImageResolver => async (src) => {
  const trimmed = src.trim();
  if (trimmed.startsWith('data:')) return trimmed;
  const assetPath = localAssetPath(trimmed);
  if (assetPath === null) return null;
  try {
    const asset = await readAsset(assetPath);
    return `data:${asset.mime};base64,${asset.data}`;
  } catch (error) {
    // 导出时跳过读不出的图片，但要留下线索：否则导出件里少图没有任何原因可查
    log.error('导出 PDF：图片资产读取失败，已跳过该图', { path: assetPath, error: toErrorText(error) });
    return null;
  }
};

const inlineToHtml = async (inline: ReadInline, images: ImageResolver): Promise<string> => {
  switch (inline.kind) {
    case 'text':
      return escapeHtml(inline.value);
    case 'strong':
      return `<strong>${await inlinesToHtml(inline.children, images)}</strong>`;
    case 'emphasis':
      return `<em>${await inlinesToHtml(inline.children, images)}</em>`;
    case 'code':
      return `<code>${escapeHtml(inline.value)}</code>`;
    case 'math':
      return `<span class="math">${escapeHtml(inline.value)}</span>`;
    case 'link':
      // 本地文档内相对跳转在打印里没有意义：只保留文字
      return `<span>${await inlinesToHtml(inline.children, images)}</span>`;
    case 'wiki':
      return `<span class="wiki">${escapeHtml(inline.label)}</span>`;
    case 'image': {
      const src = await images(inline.src);
      if (src === null) return `<span class="missing-image">[图片缺失：${escapeHtml(inline.alt || inline.src)}]</span>`;
      return `<img src="${escapeHtml(src)}" alt="${escapeHtml(inline.alt)}" />`;
    }
    case 'break':
      return '<br />';
  }
};

const inlinesToHtml = async (inlines: readonly ReadInline[], images: ImageResolver): Promise<string> => {
  const parts: string[] = [];
  for (const inline of inlines) parts.push(await inlineToHtml(inline, images));
  return parts.join('');
};

const blocksToHtml = async (blocks: readonly ReadBlock[], images: ImageResolver): Promise<string> => {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case 'heading': {
        const level = Math.min(6, Math.max(1, block.depth));
        parts.push(`<h${level}>${await inlinesToHtml(block.children, images)}</h${level}>`);
        break;
      }
      case 'paragraph':
        parts.push(`<p>${await inlinesToHtml(block.children, images)}</p>`);
        break;
      case 'code':
        parts.push(`<pre><code>${escapeHtml(block.value)}</code></pre>`);
        break;
      case 'math':
        parts.push(`<pre class="math">${escapeHtml(block.value)}</pre>`);
        break;
      case 'table': {
        const head = await Promise.all(block.header.map((cell) => inlinesToHtml(cell, images)));
        const rowsHtml: string[] = [];
        for (const row of block.rows) {
          const cells = await Promise.all(row.map((cell) => inlinesToHtml(cell, images)));
          rowsHtml.push(`<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`);
        }
        parts.push(
          `<table><thead><tr>${head.map((cell) => `<th>${cell}</th>`).join('')}</tr></thead><tbody>${rowsHtml.join('')}</tbody></table>`,
        );
        break;
      }
      case 'list': {
        const tag = block.ordered ? 'ol' : 'ul';
        const items: string[] = [];
        for (const item of block.items) {
          items.push(`<li>${await blocksToHtml(item, images)}</li>`);
        }
        const startAttr = block.ordered && block.start !== 1 ? ` start="${block.start}"` : '';
        parts.push(`<${tag}${startAttr}>${items.join('')}</${tag}>`);
        break;
      }
      case 'quote':
        parts.push(`<blockquote>${await blocksToHtml(block.children, images)}</blockquote>`);
        break;
      case 'rule':
        parts.push('<hr />');
        break;
      case 'text':
        parts.push(`<p>${escapeHtml(block.value)}</p>`);
        break;
    }
  }
  return parts.join('\n');
};

const PRINT_CSS = `
  * { box-sizing: border-box; }
  body {
    margin: 0 auto;
    max-width: 720px;
    padding: 32px 24px;
    color: #1f2328;
    background: #ffffff;
    font-family: "Songti SC", "PingFang SC", Georgia, serif;
    font-size: 14px;
    line-height: 1.75;
  }
  h1, h2, h3, h4, h5, h6 { line-height: 1.4; margin: 1.6em 0 0.6em; }
  h1 { font-size: 1.7em; }
  h2 { font-size: 1.4em; }
  h3 { font-size: 1.2em; }
  p { margin: 0.6em 0; }
  pre {
    padding: 10px 12px;
    background: #f6f7f9;
    border-radius: 6px;
    font-family: "SF Mono", Menlo, monospace;
    font-size: 12px;
    overflow-x: auto;
    break-inside: avoid;
  }
  code { font-family: "SF Mono", Menlo, monospace; font-size: 0.92em; background: #f0f1f3; padding: 1px 4px; border-radius: 4px; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; break-inside: avoid; }
  th, td { border: 1px solid #d5d9de; padding: 6px 10px; text-align: left; }
  th { background: #f6f7f9; }
  img { max-width: 100%; }
  blockquote { margin: 1em 0; padding: 4px 16px; border-left: 3px solid #d5d9de; color: #57606a; }
  hr { border: none; border-top: 1px solid #d5d9de; margin: 1.6em 0; }
  .math { font-family: Georgia, serif; font-style: italic; }
  .wiki { color: #0969da; }
  .missing-image { color: #a40e26; font-size: 0.9em; }
`;

/** 打印自包含 HTML：iframe onload 后触发系统打印（含「存储为 PDF」） */
const printHtml = (title: string, bodyHtml: string): void => {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.position = 'fixed';
  frame.style.right = '0';
  frame.style.bottom = '0';
  frame.style.width = '0';
  frame.style.height = '0';
  frame.style.border = '0';
  frame.srcdoc =
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
    `<style>${PRINT_CSS}</style></head><body>${bodyHtml}</body></html>`;
  frame.onload = () => {
    window.setTimeout(() => {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
      window.setTimeout(() => {
        frame.remove();
      }, 30_000);
    }, 150);
  };
  document.body.appendChild(frame);
};

export const PRINT_EXPORT_TITLE = 'ember.doc.export-pdf';

/** 导出当前文档为 PDF（系统打印对话框）：失败抛错由调用方提示 */
export const exportDocPdf = async (kernel: KernelContext, docId: DocId, title: string): Promise<void> => {
  const snapshot = await kernel.docs.read(docId);
  const body = splitFrontmatter(snapshot.text).body;
  const blocks = readingBlocks(body);
  const bodyHtml = await blocksToHtml(blocks, makeImageResolver(kernel.log));
  const displayTitle = title.trim().length === 0 ? '未命名文档' : title.trim();
  printHtml(displayTitle, `<h1>${escapeHtml(displayTitle)}</h1>${bodyHtml}`);
};
