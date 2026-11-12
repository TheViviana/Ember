import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_ROOT, exemptionViolations, toPosix } from './lib.mjs';

/**
 * 零联网门禁：源码 + 构建产物里不允许出现会被运行期加载的外域 URL。
 *
 * 判定口径：
 * 1. 先剥离注释（JS/TS/CSS 的行注释与块注释、HTML 注释），注释里的 URL 不算引用；
 * 2. 剩余文本中出现 http(s):// 或协议相对地址 `//host.tld/...` 即视为引用；
 * 3. 本机回环（localhost / 127.0.0.1 / [::1]）放行，因为它们是开发服务器与 IPC；
 * 4. 其余命中必须逐条进入 ALLOW 白名单，并写清"为什么不会发请求"。
 */

const SOURCE_TARGETS = [
  'src',
  'packages',
  'src-tauri/src',
  'index.html',
  'vite.config.ts',
  'eslint.config.mjs',
  'src-tauri/tauri.conf.json',
];
const SOURCE_EXT = new Set(['.ts', '.tsx', '.css', '.html', '.json', '.mjs', '.js', '.rs']);
const DIST_EXT = new Set(['.js', '.css', '.html']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'target', 'gen', '.git', '.agents', '.trae', 'fixtures']);
const URL_RE = /\bhttps?:\/\/[^\s"'`<>)\]}]+/gi;
/** 协议相对地址（`//cdn.example.com/x.js`）：浏览器会按当前协议发起请求，同样算外域 */
const PROTOCOL_RELATIVE_RE = /(?<!:)\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:[/?#][^\s"'`<>)\]}]*)?/gi;
const LOOPBACK_RE = /^(?:https?:)?\/\/(?:localhost|ipc\.localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i;

/**
 * 每条白名单都必须能解释"为什么运行期不会产生网络请求"。
 * expires 是复核节点，不是失效开关：到期必须重新裁决，修复后删除条目或论证后改期。
 */
const ALLOW = [
  {
    file: 'src-tauri/tauri.conf.json',
    match: /^https:\/\/schema\.tauri\.app\//,
    reason: '开发期 JSON Schema 标识，只给编辑器补全用，应用运行时不请求',
    expires: '2027-01-31',
  },
  {
    file: 'src-tauri/tauri.conf.json',
    match: /^http:\/\/localhost:5173$/,
    reason: 'devUrl 指向本机 Vite 开发服务器',
    expires: '2027-01-31',
  },
  {
    file: 'dist/**',
    match: /^https:\/\/react\.dev\/errors\//,
    reason: 'React 生产包内的错误说明链接，仅作为错误消息字符串拼接',
    expires: '2027-01-31',
  },
  {
    file: 'dist/**',
    match: /^https:\/\/react\.dev\/link\//,
    reason: 'React 生产包内的文档链接字符串，不会被请求',
    expires: '2027-01-31',
  },
  {
    file: 'dist/**',
    match: /^http:\/\/www\.w3\.org\//,
    reason: 'SVG / XML 命名空间标识符，仅用于 setAttribute，不是可请求地址',
    expires: '2027-01-31',
  },
];

const COMMENT_STRIP_EXT = new Set(['.ts', '.tsx', '.css', '.js', '.mjs']);

/** 把注释替换为等长空白（保留换行），字符串原样保留，URL 偏移与行号不变 */
function stripComments(source) {
  let out = '';
  let index = 0;
  const length = source.length;
  let quote = null;

  while (index < length) {
    const char = source[index] ?? '';
    const next = source[index + 1] ?? '';

    if (quote !== null) {
      out += char;
      if (char === '\\') {
        out += next;
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      out += char;
      index += 1;
      continue;
    }

    if (char === '/' && next === '/') {
      while (index < length && source[index] !== '\n') {
        out += ' ';
        index += 1;
      }
      continue;
    }

    if (char === '/' && next === '*') {
      while (index < length && !(source[index] === '*' && source[index + 1] === '/')) {
        out += source[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      out += '  ';
      index += 2;
      continue;
    }

    out += char;
    index += 1;
  }

  return out;
}

const stripHtmlComments = (source) => source.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));

function readText(file) {
  const raw = readFileSync(file, 'utf8');
  const ext = extname(file).toLowerCase();
  if (ext === '.html') return stripHtmlComments(raw);
  if (ext === '.rs') return stripRustComments(raw);
  if (COMMENT_STRIP_EXT.has(ext)) return stripComments(raw);
  return raw;
}

/** Rust 注释剥离：保留字符串与字符字面量，区分生命周期 `'a`，支持嵌套块注释与原始字符串 */
export function stripRustComments(source) {
  let out = '';
  let index = 0;
  const length = source.length;
  let blockDepth = 0;

  while (index < length) {
    const char = source[index] ?? '';
    const next = source[index + 1] ?? '';

    if (blockDepth > 0) {
      if (char === '/' && next === '*') {
        blockDepth += 1;
        out += '  ';
        index += 2;
        continue;
      }
      if (char === '*' && next === '/') {
        blockDepth -= 1;
        out += '  ';
        index += 2;
        continue;
      }
      out += char === '\n' ? '\n' : ' ';
      index += 1;
      continue;
    }

    if (char === '/' && next === '/') {
      while (index < length && source[index] !== '\n') {
        out += ' ';
        index += 1;
      }
      continue;
    }

    if (char === '/' && next === '*') {
      blockDepth = 1;
      out += '  ';
      index += 2;
      continue;
    }

    const rawEnd = rawStringEnd(source, index);
    if (rawEnd !== null) {
      out += source.slice(index, rawEnd);
      index = rawEnd;
      continue;
    }

    if (char === '"') {
      const end = quotedEnd(source, index);
      out += source.slice(index, end);
      index = end;
      continue;
    }

    if (char === "'") {
      const end = charLiteralEnd(source, index);
      if (end !== null) {
        out += source.slice(index, end);
        index = end;
        continue;
      }
    }

    out += char;
    index += 1;
  }

  return out;
}

function quotedEnd(source, start) {
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '"') return index + 1;
    index += 1;
  }
  return source.length;
}

function rawStringEnd(source, start) {
  if (start > 0 && /[A-Za-z0-9_]/.test(source[start - 1] ?? '')) return null;
  let index = start;
  if (source[index] === 'b' || source[index] === 'c') index += 1;
  if (source[index] !== 'r') return null;
  index += 1;
  let hashes = 0;
  while (source[index] === '#') {
    hashes += 1;
    index += 1;
  }
  if (source[index] !== '"') return null;
  const terminator = `"${'#'.repeat(hashes)}`;
  const close = source.indexOf(terminator, index + 1);
  return close < 0 ? source.length : close + terminator.length;
}

function charLiteralEnd(source, start) {
  let index = start + 1;
  if (source[index] === '\\') {
    index += 2;
    if (source[index - 1] === 'u' && source[index] === '{') {
      const close = source.indexOf('}', index);
      if (close < 0) return null;
      index = close + 1;
    }
    while (index < source.length && source[index] !== "'" && source[index] !== '\n') index += 1;
    return source[index] === "'" ? index + 1 : null;
  }
  if (index >= source.length || source[index] === '\n') return null;
  const code = source.codePointAt(index);
  if (code === undefined) return null;
  index += code > 0xffff ? 2 : 1;
  return source[index] === "'" ? index + 1 : null;
}

function walk(dir, root, result, problems) {
  const start = resolve(dir);
  let entries;
  try {
    entries = readdirSync(start, { withFileTypes: true });
  } catch (error) {
    problems.push({
      file: toPosix(relative(root, start)) || '.',
      detail: `目录无法读取：${error.code ?? error.message}`,
    });
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    const full = join(start, entry.name);
    if (entry.isDirectory()) walk(full, root, result, problems);
    else if (SOURCE_EXT.has(extname(entry.name).toLowerCase())) result.push(full);
  }
  return result;
}

function walkDist(dir, root, result, problems) {
  const start = resolve(dir);
  let entries;
  try {
    entries = readdirSync(start, { withFileTypes: true });
  } catch (error) {
    problems.push({
      file: toPosix(relative(root, start)) || '.',
      detail: `产物目录无法读取：${error.code ?? error.message}`,
    });
    return;
  }
  for (const entry of entries) {
    const full = join(start, entry.name);
    if (entry.isDirectory()) walkDist(full, root, result, problems);
    else if (DIST_EXT.has(extname(entry.name).toLowerCase())) result.push(full);
  }
  return result;
}

function collectSources(root, problems) {
  const files = [];
  for (const target of SOURCE_TARGETS) {
    const full = join(root, target);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full, root, files, problems);
      else if (SOURCE_EXT.has(extname(full).toLowerCase())) files.push(full);
    } catch (error) {
      problems.push({
        file: target,
        detail: `扫描目标不可访问（${error.code ?? error.message}）`,
      });
    }
  }
  return files.sort();
}

function whitelistFor(relPath, url) {
  for (const entry of ALLOW) {
    if (entry.file === relPath && entry.match.test(url)) return entry;
    if (entry.file === 'dist/**' && relPath.startsWith('dist/') && entry.match.test(url)) return entry;
  }
  return null;
}

function scanFile(root, file) {
  const relPath = toPosix(relative(root, file));
  const text = readText(file);
  const found = [];
  for (const pattern of [URL_RE, PROTOCOL_RELATIVE_RE]) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match !== null) {
      const url = match[0].replace(/[;,]+$/, '');
      const line = text.slice(0, match.index).split('\n').length;
      if (LOOPBACK_RE.test(url)) {
        found.push({ url, line, allowed: true, reason: '本机回环（开发服务器 / IPC）' });
      } else {
        const allow = whitelistFor(relPath, url);
        found.push({
          url,
          line,
          allowed: allow !== null,
          reason: allow === null ? '未登记的外域引用' : allow.reason,
        });
      }
      match = pattern.exec(text);
    }
  }
  return { relPath, found };
}

const FONT_FILES = [
  'orbitron-latin.woff2',
  'roboto-latin.woff2',
  'anonymous-pro-latin-400.woff2',
  'anonymous-pro-latin-700.woff2',
  'geist-sans-variable.woff2',
];

/**
 * 审计库内源码与 dist 产物的外域引用。
 * 读取失败一律变成 `offline-read`：不可读子树、缺失的扫描目标都不允许冒充「零外域」。
 * @param {string} root 仓库根
 * @param {{requireDist?: boolean, checkFonts?: boolean}} [options]
 */
export function checkOffline(root, options = {}) {
  const requireDist = options.requireDist ?? true;
  const checkFonts = options.checkFonts ?? true;
  const problems = [];
  const sources = collectSources(root, problems);
  const distDir = join(root, 'dist');
  const dist = existsSync(distDir) ? walkDist(distDir, root, [], problems) : [];

  const violations = [
    ...exemptionViolations(ALLOW, { rule: 'offline-allow', label: 'offline' }),
    ...problems.map((problem) => ({
      file: problem.file,
      line: 0,
      rule: 'offline-read',
      detail: problem.detail,
    })),
  ];
  if (requireDist && dist.length === 0) {
    violations.push({
      file: 'dist',
      line: 0,
      rule: 'offline-dist',
      detail: 'dist 不存在或为空，请先运行 pnpm build 再检查产物',
    });
  }

  const scans = [...sources.map((file) => scanFile(root, file)), ...dist.map((file) => scanFile(root, file))];
  const hits = scans.flatMap((scan) => scan.found.map((hit) => ({ ...hit, file: scan.relPath })));
  const allowed = hits.filter((hit) => hit.allowed);
  for (const hit of hits.filter((hit) => !hit.allowed)) {
    violations.push({
      file: hit.file,
      line: hit.line,
      rule: 'offline-url',
      detail: `${hit.url}（${hit.reason}）`,
    });
  }

  const missingFonts = checkFonts
    ? FONT_FILES.filter((name) => !existsSync(join(root, 'public', 'fonts', name)))
    : [];
  for (const name of missingFonts) {
    violations.push({
      file: `public/fonts/${name}`,
      line: 0,
      rule: 'offline-font',
      detail: '缺少本地字体；运行期会回退到系统字体或尝试联网',
    });
  }

  return { violations, allowed, sources, dist, missingFonts };
}

function main() {
  const rootArg = process.argv.indexOf('--root');
  const root = resolve(rootArg >= 0 ? (process.argv[rootArg + 1] ?? DEFAULT_ROOT) : DEFAULT_ROOT);
  const result = checkOffline(root);

  for (const hit of result.allowed) {
    process.stdout.write(`  · 白名单 ${hit.file}:${hit.line} ${hit.url} — ${hit.reason}\n`);
  }
  for (const violation of result.violations) {
    process.stdout.write(`  ✗ ${violation.file}:${violation.line} [${violation.rule}] ${violation.detail}\n`);
  }

  const external = result.violations.filter((violation) => violation.rule === 'offline-url').length;
  process.stdout.write(
    `offline：源码 ${result.sources.length} 个文件、产物 ${result.dist.length} 个文件；` +
      `外域引用 ${external} 处，白名单 ${result.allowed.length} 处；` +
      `本地字体 ${FONT_FILES.length - result.missingFonts.length}/${FONT_FILES.length}\n`,
  );

  const failed = result.violations.length > 0;
  process.stdout.write(
    failed ? 'gate:offline 失败\n' : 'gate:offline 通过：源码与产物中零字面量外域引用（动态拼接地址不在覆盖范围）\n',
  );
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
