import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_ROOT, toPosix } from './lib.mjs';

/**
 * 零联网门禁：源码 + 构建产物里不允许出现会被运行期加载的外域 URL。
 *
 * 判定口径：
 * 1. 先剥离注释（JS/TS/CSS 的行注释与块注释、HTML 注释），注释里的 URL 不算引用；
 * 2. 剩余文本中出现 http(s):// 即视为引用；
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
const URL_RE = /\bhttps?:\/\/[^\s"'`<>)\]}]+/g;
const LOOPBACK_RE = /^https?:\/\/(?:localhost|ipc\.localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/;

/** 每条白名单都必须能解释"为什么运行期不会产生网络请求" */
const ALLOW = [
  {
    file: 'src-tauri/tauri.conf.json',
    match: /^https:\/\/schema\.tauri\.app\//,
    reason: '开发期 JSON Schema 标识，只给编辑器补全用，应用运行时不请求',
  },
  {
    file: 'src-tauri/tauri.conf.json',
    match: /^http:\/\/localhost:5173$/,
    reason: 'devUrl 指向本机 Vite 开发服务器',
  },
  {
    file: 'dist/**',
    match: /^https:\/\/react\.dev\/errors\//,
    reason: 'React 生产包内的错误说明链接，仅作为错误消息字符串拼接',
  },
  {
    file: 'dist/**',
    match: /^https:\/\/react\.dev\/link\//,
    reason: 'React 生产包内的文档链接字符串，不会被请求',
  },
  {
    file: 'dist/**',
    match: /^http:\/\/www\.w3\.org\//,
    reason: 'SVG / XML 命名空间标识符，仅用于 setAttribute，不是可请求地址',
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

function walk(dir, result = []) {
  const start = resolve(dir);
  let entries;
  try {
    entries = readdirSync(start, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    const full = join(start, entry.name);
    if (entry.isDirectory()) walk(full, result);
    else if (SOURCE_EXT.has(extname(entry.name).toLowerCase())) result.push(full);
  }
  return result;
}

function walkDist(dir, result = []) {
  let entries;
  try {
    entries = readdirSync(resolve(dir), { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    const full = join(resolve(dir), entry.name);
    if (entry.isDirectory()) walkDist(full, result);
    else if (DIST_EXT.has(extname(entry.name).toLowerCase())) result.push(full);
  }
  return result;
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
  URL_RE.lastIndex = 0;
  let match = URL_RE.exec(text);
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
    match = URL_RE.exec(text);
  }
  return { relPath, found };
}

function collectSources(root) {
  const files = [];
  for (const target of SOURCE_TARGETS) {
    const full = join(root, target);
    if (!existsSync(full)) continue;
    const stat = statSync(full);
    if (stat.isDirectory()) files.push(...walk(full));
    else if (SOURCE_EXT.has(extname(full).toLowerCase())) files.push(full);
  }
  return files.sort();
}

function main() {
  const rootArg = process.argv.indexOf('--root');
  const root = resolve(rootArg >= 0 ? (process.argv[rootArg + 1] ?? DEFAULT_ROOT) : DEFAULT_ROOT);
  const distDir = join(root, 'dist');

  const sources = collectSources(root);
  const dist = existsSync(distDir) ? walkDist(distDir) : [];
  if (dist.length === 0) {
    process.stdout.write('✗ offline：dist 不存在或为空，请先运行 pnpm build 再检查产物\n');
    process.exit(1);
  }

  const scans = [...sources.map((file) => scanFile(root, file)), ...dist.map((file) => scanFile(root, file))];
  const hits = scans.flatMap((scan) => scan.found.map((hit) => ({ ...hit, file: scan.relPath })));
  const allowed = hits.filter((hit) => hit.allowed);
  const violations = hits.filter((hit) => !hit.allowed);

  for (const hit of allowed) {
    process.stdout.write(`  · 白名单 ${hit.file}:${hit.line} ${hit.url} — ${hit.reason}\n`);
  }
  for (const hit of violations) {
    process.stdout.write(`  ✗ ${hit.file}:${hit.line} ${hit.url}（${hit.reason}）\n`);
  }

  const fontFiles = [
    'orbitron-latin.woff2',
    'roboto-latin.woff2',
    'anonymous-pro-latin-400.woff2',
    'anonymous-pro-latin-700.woff2',
    'geist-sans-variable.woff2',
  ];
  const missingFonts = fontFiles.filter((name) => !existsSync(join(root, 'public', 'fonts', name)));

  process.stdout.write(
    `offline：源码 ${sources.length} 个文件、产物 ${dist.length} 个文件；` +
      `外域引用 ${violations.length} 处，白名单 ${allowed.length} 处；` +
      `本地字体 ${fontFiles.length - missingFonts.length}/${fontFiles.length}\n`,
  );
  if (missingFonts.length > 0) {
    process.stdout.write(`  ✗ 缺少本地字体：${missingFonts.join(', ')}\n`);
  }

  const failed = violations.length > 0 || missingFonts.length > 0;
  process.stdout.write(failed ? 'gate:offline 失败\n' : 'gate:offline 通过：运行期零外域引用\n');
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
