import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_ROOT, toPosix } from './lib.mjs';

const SCAN_EXT = new Set(['.ts', '.tsx', '.mjs', '.js', '.rs']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'target', 'gen', '.git', 'fixtures']);

/** 禁用项：规则名 → 正则（正则与提示文案都不写触发字面量，避免扫描脚本命中自身） */
export const BANNED_PATTERNS = [
  { rule: 'explicit-any', re: /:\s*any\b/, hint: '禁止显式 any 类型' },
  { rule: 'explicit-any', re: /\bas\s+any\b/, hint: '禁止 any 断言' },
  { rule: 'explicit-any', re: /<\s*any\s*>/, hint: '禁止泛型实参为 any' },
  { rule: 'ts-suppress', re: new RegExp('@ts-' + 'ignore'), hint: '禁止 TypeScript 抑制注释' },
  { rule: 'ts-suppress', re: new RegExp('@ts-' + 'nocheck'), hint: '禁止 TypeScript 抑制注释' },
  { rule: 'ts-suppress', re: new RegExp('@ts-' + 'expect-error'), hint: '禁止 TypeScript 抑制注释' },
  { rule: 'eslint-suppress', re: new RegExp('eslint-' + 'disable'), hint: '禁止 ESLint 抑制注释' },
  { rule: 'rust-suppress', re: new RegExp('#\\[allow\\('), hint: '禁止 Rust allow 属性' },
  { rule: 'rust-suppress', re: new RegExp('#\\[expect\\('), hint: '禁止 Rust expect 属性' },
];

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
    else if (SCAN_EXT.has(extname(entry.name))) result.push(full);
  }
  return result;
}

/** 扫描禁用项，返回 {file, line, rule, detail} */
export function scanBans(root) {
  const violations = [];
  for (const file of walk(root).sort()) {
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      for (const { rule, re, hint } of BANNED_PATTERNS) {
        if (re.test(line)) {
          violations.push({
            file: toPosix(relative(root, file)),
            line: i + 1,
            rule,
            detail: hint,
          });
        }
      }
    }
  }
  return violations;
}

function parseArgs(argv) {
  const rootIndex = argv.indexOf('--root');
  if (rootIndex >= 0 && argv[rootIndex + 1] === undefined) {
    throw new Error('--root 需要一个目录参数');
  }
  return {
    root: resolve(rootIndex >= 0 ? (argv[rootIndex + 1] ?? DEFAULT_ROOT) : DEFAULT_ROOT),
    json: argv.includes('--json'),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { root, json } = parseArgs(process.argv.slice(2));
  const violations = scanBans(root);
  if (json) {
    process.stdout.write(`${JSON.stringify({ gate: 'bans', root, violations }, null, 2)}\n`);
  } else {
    for (const v of violations) {
      process.stdout.write(`${v.file}:${v.line}  [${v.rule}] ${v.detail}\n`);
    }
    process.stdout.write(
      violations.length === 0
        ? 'gate:bans 通过：0 处禁用项\n'
        : `gate:bans 失败：${violations.length} 处禁用项\n`,
    );
  }
  process.exit(violations.length === 0 ? 0 : 1);
}
