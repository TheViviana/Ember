import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_ROOT, toPosix } from './lib.mjs';

/** shell 层单文件行数上限：超过即要求拆分，或逐条登记豁免理由 */
export const SIZE_LIMIT = 600;

const SCAN_EXT = new Set(['.ts', '.tsx']);

/**
 * 逐条豁免：只允许已登记的文件超限。
 * 条目必须写明理由；文件拆分到限额内后必须删除对应条目，否则报 size-stale。
 * 待办（本项只登记，后续单独拆分）：
 * - settings/SettingsPanel.tsx、tools/GalleryEntry.tsx
 */
export const SIZE_WHITELIST = [
  {
    file: 'src/shell/settings/SettingsPanel.tsx',
    reason: '设置面板单文件承载全部分区；待按分区拆分子组件',
  },
  {
    file: 'src/shell/tools/GalleryEntry.tsx',
    reason: '工具画廊单文件承载卡片、筛选与详情；待拆分展示层',
  },
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
    if (entry.name.startsWith('.')) continue;
    const full = join(start, entry.name);
    if (entry.isDirectory()) walk(full, result);
    else if (SCAN_EXT.has(extname(entry.name))) result.push(full);
  }
  return result;
}

/** 与 wc -l 一致：按换行计数，末尾换行不多算一行 */
function countLines(source) {
  let lines = 0;
  for (const char of source) {
    if (char === '\n') lines += 1;
  }
  return source.length > 0 && !source.endsWith('\n') ? lines + 1 : lines;
}

/**
 * 检查 shell 层文件体积。
 * @param {string} root 仓库根
 * @param {{limit?: number, whitelist?: readonly {file: string, reason: string}[]}} [options]
 */
export function checkSize(root, options = {}) {
  const limit = options.limit ?? SIZE_LIMIT;
  const whitelist = options.whitelist ?? SIZE_WHITELIST;
  const allowed = new Map();
  for (const entry of whitelist) allowed.set(toPosix(entry.file), entry.reason);

  const violations = [];
  const seen = new Set();

  for (const file of walk(join(root, 'src', 'shell')).sort()) {
    const rel = toPosix(relative(root, file));
    const lines = countLines(readFileSync(file, 'utf8'));
    const reason = allowed.get(rel);
    seen.add(rel);
    if (lines > limit) {
      if (reason === undefined) {
        violations.push({
          file: rel,
          line: 0,
          rule: 'size',
          detail: `${lines} 行 > ${limit} 行；请拆分，或在 size.mjs 登记豁免理由`,
        });
      } else if (reason.trim().length === 0) {
        violations.push({
          file: rel,
          line: 0,
          rule: 'size-whitelist-reason',
          detail: '白名单条目必须写明理由',
        });
      }
    } else if (reason !== undefined) {
      violations.push({
        file: rel,
        line: 0,
        rule: 'size-stale',
        detail: `${lines} 行已不超过 ${limit} 行；请删除过期豁免`,
      });
    }
  }

  for (const entry of whitelist) {
    const rel = toPosix(entry.file);
    if (!seen.has(rel)) {
      violations.push({
        file: rel,
        line: 0,
        rule: 'size-missing',
        detail: '白名单条目对应的文件不存在',
      });
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
  const violations = checkSize(root);
  if (json) {
    process.stdout.write(`${JSON.stringify({ gate: 'size', root, violations }, null, 2)}\n`);
  } else {
    for (const v of violations) {
      process.stdout.write(`${v.file}:${v.line}  [${v.rule}] ${v.detail}\n`);
    }
    process.stdout.write(
      violations.length === 0
        ? `gate:size 通过：shell 层单文件不超过 ${SIZE_LIMIT} 行\n`
        : `gate:size 失败：${violations.length} 处体积问题\n`,
    );
  }
  process.exit(violations.length === 0 ? 0 : 1);
}
