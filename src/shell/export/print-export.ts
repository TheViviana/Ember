import { splitFrontmatter, type DocId } from '#doc-model';
import { resolveArticleImage } from '../../data/tauri/asset-port.ts';
import { readingBlocks, type ReadBlock, type ReadInline } from '../canvas/read-markdown.ts';
import type { KernelContext } from '../../kernel/context.ts';
import { toErrorText } from '../../kernel/errors.ts';

/**
 * 导出当前文档 PDF：正文走内核唯一的 Markdown 解析管线（readingBlocks），
 * 组装成打印用 HTML 后丢进隐藏 iframe 调 print() —— 走系统打印对话框的
 * 「存储为 PDF」，不装任何导出依赖，也不引用外域资源。
 * 图片：按文章路径解析（文章目录 → images → 库根）后内嵌 data URL；外链一律跳过（运行时零联网）。
 */

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

type ImageResolver = (src: string) => Promise<string | null>;

const makeImageResolver = (log: KernelContext['log'], documentPath: string): ImageResolver => async (src) => {
  const trimmed = src.trim();
  if (trimmed.startsWith('data:')) return trimmed;
  try {
    const resolved = await resolveArticleImage(documentPath, trimmed);
    if (resolved.status === 'missing') {
      log.error('导出 PDF：图片未解析到，已跳过该图', { path: trimmed, reason: resolved.reason });
      return null;
    }
    return `data:${resolved.mime};base64,${resolved.data}`;
  } catch (error) {
    // 导出时跳过读不出的图片，但要留下线索：否则导出件里少图没有任何原因可查
    log.error('导出 PDF：图片读取失败，已跳过该图', { path: trimmed, error: toErrorText(error) });
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

const PRINT_ROOT_ID = 'ember-print-root';
const PRINT_STYLE_HREF = '/print.css';
/** 打印结束的兜底清理：afterprint 不触发时也不能把注入节点永久留在 DOM 里 */
const PRINT_CLEANUP_MS = 300_000;

/** 打印样式只在打印期间挂载，避免 body 等全局规则污染应用界面 */
const mountPrintStyle = (): HTMLLinkElement => {
  document.querySelectorAll<HTMLLinkElement>('link[data-ember-print-style]').forEach((link) => {
    link.remove();
  });
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = PRINT_STYLE_HREF;
  link.dataset.emberPrintStyle = '';
  document.head.appendChild(link);
  return link;
};

/** 等图片解码完再弹打印，否则图还没画出来就进了预览 */
const waitForImages = async (root: HTMLElement, timeoutMs: number): Promise<void> => {
  const images = [...root.querySelectorAll('img')];
  if (images.length === 0) return;
  const settled = Promise.all(images.map((image) => image.decode().catch(() => undefined)));
  await Promise.race([settled, new Promise<void>((resolve) => window.setTimeout(resolve, timeoutMs))]);
};

/**
 * 打印用 HTML：渲染进主文档的隐藏容器，靠 /print.css 的 @media print
 * 隐藏应用外壳、只显示这个容器，然后直接调主窗口的 window.print()。
 * 不能走 iframe：WKWebView 下子 frame 的 print() 是空操作。
 */
const printHtml = async (title: string, bodyHtml: string): Promise<void> => {
  document.querySelectorAll(`#${PRINT_ROOT_ID}`).forEach((node) => {
    node.remove();
  });
  const style = mountPrintStyle();

  const root = document.createElement('div');
  root.id = PRINT_ROOT_ID;
  root.setAttribute('aria-hidden', 'true');
  root.innerHTML = `<h1>${escapeHtml(title)}</h1>${bodyHtml}`;
  document.body.appendChild(root);

  let cleaned = false;
  let fallback = 0;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    window.clearTimeout(fallback);
    window.removeEventListener('afterprint', cleanup);
    root.remove();
    style.remove();
  };
  window.addEventListener('afterprint', cleanup);
  fallback = window.setTimeout(cleanup, PRINT_CLEANUP_MS);

  try {
    await waitForImages(root, 5_000);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
    const printed = window.print() as unknown;
    // Tauri 覆写的 window.print 返回 invoke 的 Promise：失败要冒泡给调用方
    if (printed instanceof Promise) await printed;
  } catch (error) {
    cleanup();
    throw error;
  }
};

export const PRINT_EXPORT_TITLE = 'ember.doc.export-pdf';

/** 导出当前文档为 PDF（系统打印对话框）：失败抛错由调用方提示 */
export const exportDocPdf = async (kernel: KernelContext, docId: DocId, title: string): Promise<void> => {
  const snapshot = await kernel.docs.read(docId);
  const body = splitFrontmatter(snapshot.text).body;
  const blocks = readingBlocks(body);
  const bodyHtml = await blocksToHtml(blocks, makeImageResolver(kernel.log, snapshot.meta.path));
  const displayTitle = title.trim().length === 0 ? '未命名文档' : title.trim();
  await printHtml(displayTitle, bodyHtml);
};
