import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CSP 门禁（生产 csp）：
 *
 * 1. `style-src-elem` 的哈希必须与 index.html 内联 <style> 的实际内容一致。
 *    唯一的内联样式是「透明窗口首帧兜底」（避免启动闪出桌面），用内容哈希放行：
 *    改了这段样式而忘了同步 CSP，生产窗口会闪回桌面底色——用门禁把这种漂移钉死。
 * 2. `style-src-attr` 必须保留 'unsafe-inline'：KaTeX 的排版与颜色宏输出内联
 *    style 属性（`trust: false` 也不豁免），去掉会破坏公式渲染；注入面由
 *    img-src/connect-src 'self' 收口（CSS 无法把数据带到外网）。
 * 3. devCsp 不检查：开发模式 Vite HMR 需要内联样式，且不进生产包。
 */

const CSP_FILE = 'src-tauri/tauri.conf.json';
const INDEX_FILE = 'index.html';

const parseDirective = (csp, name) => {
  for (const directive of csp.split(';')) {
    const parts = directive.trim().split(/\s+/);
    if (parts[0] === name) return parts.slice(1);
  }
  return null;
};

export const checkCsp = (root) => {
  const violations = [];
  let conf;
  try {
    conf = JSON.parse(readFileSync(join(root, CSP_FILE), 'utf8'));
  } catch (error) {
    return [{ file: CSP_FILE, rule: 'csp-json', detail: `读取失败：${error.message}` }];
  }
  const csp = conf?.app?.security?.csp;
  if (typeof csp !== 'string') {
    return [{ file: CSP_FILE, rule: 'csp-missing', detail: '缺少 app.security.csp' }];
  }

  // 1. 内联 <style> 内容哈希必须都在 style-src-elem 白名单里
  const elemSources = parseDirective(csp, 'style-src-elem') ?? [];
  const html = readFileSync(join(root, INDEX_FILE), 'utf8');
  const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  if (styleBlocks.length === 0) {
    violations.push({
      file: INDEX_FILE,
      rule: 'csp-elem-empty',
      detail: 'index.html 没有内联样式：style-src-elem 的哈希应同步移除，避免死配置',
    });
  }
  for (const content of styleBlocks) {
    // CSP 源 token 自带引号：'sha256-<base64>'
    const hash = `'sha256-${createHash('sha256').update(content).digest('base64')}'`;
    if (!elemSources.includes(hash)) {
      violations.push({
        file: CSP_FILE,
        rule: 'csp-elem-hash',
        detail: `index.html 内联样式与 style-src-elem 不匹配：期望 ${hash}（防闪屏样式改动后必须同步 CSP）`,
      });
    }
  }

  // 2. KaTeX 依赖内联 style 属性，attr 通道不能收紧
  const attrSources = parseDirective(csp, 'style-src-attr') ?? [];
  if (!attrSources.includes("'unsafe-inline'")) {
    violations.push({
      file: CSP_FILE,
      rule: 'csp-attr-katex',
      detail: "style-src-attr 必须保留 'unsafe-inline'：KaTeX 排版/颜色宏输出内联 style 属性",
    });
  }

  return violations;
};
