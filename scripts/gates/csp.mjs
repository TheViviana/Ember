import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CSP 门禁：生产 `csp` 与开发 `devCsp` 各自对照一张指令登记表逐条断言。
 *
 * 1. 每条指令的取值必须与登记表精确一致（集合语义，不要求顺序）。
 *    放宽（新增外域/`'unsafe-inline'`）与收紧都必须改登记表，且改动在 review 中可见。
 * 2. `style-src-elem` 的哈希由 index.html 内联 <style> 现算，集合必须相等：
 *    改了防闪屏样式而忘了同步 CSP，生产窗口会闪回桌面底色。
 * 3. `style-src-attr` 必须保留 'unsafe-inline'：KaTeX 排版与颜色宏输出内联 style 属性，
 *    `trust: false` 也不豁免；注入面由 img-src/connect-src 收口。
 * 4. devCsp 单独登记：Vite HMR 需要的 'unsafe-inline'/'unsafe-eval'/localhost 只存在于
 *    dev 表，出现在生产表会因精确集合不匹配而失败。
 */

const CSP_FILE = 'src-tauri/tauri.conf.json';
const INDEX_FILE = 'index.html';

/** 生产登记表：当前真实出现的 12 条指令，逐条精确匹配 */
export const PROD_BASELINE = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'style-src': ["'self'"],
  'style-src-elem': ["'self'"], // 哈希集合另由 index.html 现算
  'style-src-attr': ["'unsafe-inline'"], // KaTeX 例外，唯一允许 inline 的指令
  'img-src': ["'self'", 'data:'],
  'font-src': ["'self'"],
  'connect-src': ["'self'", 'ipc:', 'http://ipc.localhost'],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'none'"],
  'frame-src': ["'none'"],
};

/** 开发登记表：Vite HMR 的额外来源只登记在这里，不放宽生产 */
export const DEV_BASELINE = {
  'default-src': ["'self'"],
  'script-src': ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:'],
  'font-src': ["'self'", 'data:'],
  'connect-src': [
    "'self'",
    'ws://localhost:5173',
    'http://localhost:5173',
    'ipc:',
    'http://ipc.localhost',
  ],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'none'"],
};

/**
 * 仅 dev 允许、绝不能出现在生产 CSP 任何指令里的 token（登记表自检用）。
 * `'unsafe-inline'` 不在此列：生产 `style-src-attr` 是已裁决的 KaTeX 例外，
 * 逐指令精确匹配已保证它不会出现在脚本通道或 style-src。
 */
const DEV_ONLY_TOKENS = ["'unsafe-eval'", 'ws://localhost:5173', 'http://localhost:5173'];

const isHash = (token) => /^'sha256-/i.test(token);
const lower = (token) => token.toLowerCase();

/**
 * 解析 CSP 字符串：返回有序指令与结构性问题。
 * - 允许一个末尾空段（结尾分号），中间空段报错；
 * - 指令名按 ASCII 小写归一后查表，大小写不规范单独报出；
 * - 同名指令只取第一条是浏览器行为，这里直接报重复，避免“看起来放宽了”。
 */
export const parseCsp = (csp, baseline, modeLabel) => {
  const issues = [];
  const directives = [];
  const segments = csp.split(';');
  const last = segments.length - 1;
  const seen = new Map();

  segments.forEach((segment, index) => {
    const raw = segment.trim();
    if (raw === '') {
      if (index !== last) {
        issues.push({
          file: CSP_FILE,
          rule: 'csp-empty-directive',
          detail: `${modeLabel}存在空指令段（第 ${index + 1} 段）`,
        });
      }
      return;
    }
    const [rawName, ...values] = raw.split(/\s+/);
    const name = lower(rawName);
    if (rawName !== name) {
      issues.push({
        file: CSP_FILE,
        rule: 'csp-directive-case',
        detail: `${modeLabel}指令名必须小写：期望 ${name}，实际 ${rawName}`,
      });
    }
    if (seen.has(name)) {
      issues.push({
        file: CSP_FILE,
        rule: 'csp-duplicate-directive',
        detail: `${modeLabel}${name}：期望只出现一次，实际重复（第 ${seen.get(name) + 1} 段与第 ${index + 1} 段，浏览器只取第一条）`,
      });
      return;
    }
    seen.set(name, index);
    if (values.length === 0) {
      issues.push({
        file: CSP_FILE,
        rule: 'csp-empty-directive',
        detail: `${modeLabel}${name}：期望至少一个来源，实际为空`,
      });
      return;
    }
    directives.push({ name, values, raw, index });
  });

  for (const { name } of directives) {
    if (baseline[name] === undefined) {
      issues.push({
        file: CSP_FILE,
        rule: 'csp-unknown-directive',
        detail: `${modeLabel}${name}：未登记指令，若确需新增请同步登记表与自测`,
      });
    }
  }
  for (const name of Object.keys(baseline)) {
    if (!seen.has(name)) {
      issues.push({
        file: CSP_FILE,
        rule: 'csp-missing-directive',
        detail: `${modeLabel}${name}：期望 ${baseline[name].join(' ')}，实际缺失该指令`,
      });
    }
  }

  return { directives, issues };
};

/** 逐条比对登记表并扫描禁止项；详情统一为「指令：期望 X，实际 Y」 */
export const checkDirectives = (directives, baseline, modeLabel) => {
  const violations = [];

  for (const { name, values } of directives) {
    const expected = baseline[name];
    if (expected === undefined) continue;

    const registered = expected.map(lower);
    for (const token of values) {
      const folded = lower(token);
      if (token === '*') {
        violations.push({
          file: CSP_FILE,
          rule: 'csp-forbidden-token',
          detail: `${modeLabel}${name}：禁止通配符 *，实际 ${token}`,
        });
      }
      // 已登记进当前模式基线的 token 视为显式裁决（如 dev 的 'unsafe-eval'），不再重复报禁止
      if (registered.includes(folded)) continue;
      if (name === 'default-src' || name.startsWith('script-src')) {
        if (folded === "'unsafe-eval'" || folded === "'wasm-unsafe-eval'") {
          violations.push({
            file: CSP_FILE,
            rule: 'csp-forbidden-token',
            detail: `${modeLabel}${name}：禁止 eval，实际 ${token}`,
          });
        }
        if (folded === "'unsafe-inline'") {
          violations.push({
            file: CSP_FILE,
            rule: 'csp-forbidden-token',
            detail: `${modeLabel}${name}：脚本通道禁止 'unsafe-inline'，实际 ${token}`,
          });
        }
        if (folded === 'data:' || folded === 'blob:' || folded === 'filesystem:') {
          violations.push({
            file: CSP_FILE,
            rule: 'csp-forbidden-token',
            detail: `${modeLabel}${name}：脚本通道禁止 ${token}`,
          });
        }
      }
    }

    // 哈希由专属规则校验，精确集合比较只覆盖非哈希 token
    const actual = values.filter((token) => !isHash(token)).map(lower).sort();
    const wanted = expected.map(lower).sort();
    const missing = wanted.filter((token) => !actual.includes(token));
    const extra = actual.filter((token) => !wanted.includes(token));
    if (missing.length > 0 || extra.length > 0) {
      const parts = [];
      if (extra.length > 0) parts.push(`多余 ${extra.join(' ')}`);
      if (missing.length > 0) parts.push(`缺少 ${missing.join(' ')}`);
      violations.push({
        file: CSP_FILE,
        rule: 'csp-directive',
        detail: `${modeLabel}${name}：期望 ${expected.join(' ')}，实际 ${values.join(' ')}（${parts.join('，')}）`,
      });
    }
  }

  return violations;
};

const inlineHashes = (html) => {
  const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  return {
    count: styleBlocks.length,
    hashes: styleBlocks.map(
      (content) => `'sha256-${createHash('sha256').update(content).digest('base64')}'`,
    ),
  };
};

const checkStyleSources = (directives, html) => {
  const violations = [];
  const { count, hashes } = inlineHashes(html);
  const elem = directives.find((item) => item.name === 'style-src-elem');
  const elemSources = elem === undefined ? [] : elem.values;

  if (count === 0) {
    violations.push({
      file: INDEX_FILE,
      rule: 'csp-elem-empty',
      detail: 'index.html 没有内联样式：style-src-elem 的哈希应同步移除，避免死配置',
    });
  }
  for (const hash of hashes) {
    if (!elemSources.includes(hash)) {
      violations.push({
        file: CSP_FILE,
        rule: 'csp-elem-hash',
        detail: `index.html 内联样式与 style-src-elem 不匹配：期望 ${hash}（防闪屏样式改动后必须同步 CSP）`,
      });
    }
  }
  for (const token of elemSources) {
    if (isHash(token) && !hashes.includes(token)) {
      violations.push({
        file: CSP_FILE,
        rule: 'csp-elem-hash',
        detail: `style-src-elem 含 index.html 不存在的哈希：实际 ${token}，期望集合 ${hashes.join(' ') || '（空）'}`,
      });
    }
  }

  // KaTeX 依赖内联 style 属性，attr 通道不能收紧
  const attr = directives.find((item) => item.name === 'style-src-attr');
  const attrSources = attr === undefined ? [] : attr.values;
  if (!attrSources.includes("'unsafe-inline'")) {
    violations.push({
      file: CSP_FILE,
      rule: 'csp-attr-katex',
      detail: "style-src-attr 必须保留 'unsafe-inline'：KaTeX 排版/颜色宏输出内联 style 属性",
    });
  }
  return violations;
};

const readConfig = (root) => {
  try {
    return JSON.parse(readFileSync(join(root, CSP_FILE), 'utf8'));
  } catch (error) {
    return error;
  }
};

const checkOne = (csp, baseline, label, html) => {
  const parsed = parseCsp(csp, baseline, label);
  const violations = [...parsed.issues, ...checkDirectives(parsed.directives, baseline, label)];
  if (label === '') violations.push(...checkStyleSources(parsed.directives, html));
  return violations;
};

export const checkCsp = (root) => {
  const conf = readConfig(root);
  if (conf instanceof Error) {
    return [{ file: CSP_FILE, rule: 'csp-json', detail: `读取失败：${conf.message}` }];
  }
  const security = conf?.app?.security;
  const csp = security?.csp;
  if (typeof csp !== 'string') {
    return [{ file: CSP_FILE, rule: 'csp-missing', detail: '缺少 app.security.csp' }];
  }
  const devCsp = security?.devCsp;
  if (typeof devCsp !== 'string') {
    return [{ file: CSP_FILE, rule: 'csp-missing', detail: '缺少 app.security.devCsp' }];
  }

  let html;
  try {
    html = readFileSync(join(root, INDEX_FILE), 'utf8');
  } catch (error) {
    return [{ file: INDEX_FILE, rule: 'csp-index', detail: `读取失败：${error.message}` }];
  }

  // 登记表自检：仅 dev 允许的 token 不得出现在生产表（防止复制粘贴放宽生产）
  const prodTokens = Object.values(PROD_BASELINE).flat().map(lower);
  const leaked = DEV_ONLY_TOKENS.filter((token) => prodTokens.includes(lower(token)));
  if (leaked.length > 0) {
    return [
      {
        file: CSP_FILE,
        rule: 'csp-baseline-leak',
        detail: `生产登记表含仅 dev 允许的 token：${leaked.join(' ')}`,
      },
    ];
  }

  return [
    ...checkOne(csp, PROD_BASELINE, '', html),
    ...checkOne(devCsp, DEV_BASELINE, 'devCsp ', html),
  ];
};
