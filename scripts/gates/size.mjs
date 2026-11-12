import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { activeExemptions, DEFAULT_ROOT, exemptionViolations, toPosix } from './lib.mjs';

/** shell 层单文件行数上限：超过即要求拆分，或逐条登记豁免理由 */
export const SIZE_LIMIT = 600;

const SCAN_EXT = new Set(['.ts', '.tsx']);
/** shell 层是 TypeScript 源码目录：出现这些扩展名视为绕过体积门禁 */
const FORBIDDEN_EXT = new Set(['.js', '.jsx', '.mjs', '.cjs']);
/** 只跳过依赖目录；隐藏目录同样扫描，避免用 `.tmp/` 藏超限文件 */
const SKIP_DIRS = new Set(['node_modules']);

/**
 * 逐条豁免：只允许已登记的文件超限。
 * 条目必须写明理由；文件拆分到限额内后必须删除对应条目，否则报 size-stale。
 * expires 是复核节点，不是失效开关：到期必须重新裁决，修复后删除条目或论证后改期。
 * 待办（本项只登记，后续单独拆分）：
 * - settings/SettingsPanel.tsx、tools/GalleryEntry.tsx
 */
export const SIZE_WHITELIST = [
  {
    file: 'src/shell/settings/SettingsPanel.tsx',
    reason: '设置面板单文件承载全部分区；待按分区拆分子组件',
    expires: '2027-01-31',
  },
  {
    file: 'src/shell/tools/GalleryEntry.tsx',
    reason: '工具画廊单文件承载卡片、筛选与详情；待拆分展示层',
    expires: '2027-01-31',
  },
];

/**
 * 递归收集源码文件。读取失败与禁止扩展名都记为问题而不是静默跳过——
 * 否则改个扩展名、放个隐藏目录或制造不可读目录就能让门禁假通过。
 */
function walk(dir, root, files, problems) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    problems.push({
      file: toPosix(relative(root, dir)),
      rule: 'size-read',
      detail: `目录无法读取：${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      problems.push({
        file: toPosix(relative(root, full)),
        rule: 'size-symlink',
        detail: 'shell 层不允许符号链接：扫描无法保证覆盖真实文件',
      });
      continue;
    }
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, root, files, problems);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).toLowerCase();
    if (SCAN_EXT.has(ext)) {
      files.push(full);
    } else if (FORBIDDEN_EXT.has(ext)) {
      problems.push({
        file: toPosix(relative(root, full)),
        rule: 'size-ext',
        detail: `shell 层应为 TypeScript，禁止 ${ext} 文件（或改回 .ts/.tsx 接受行数检查）`,
      });
    }
  }
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
 * @param {{limit?: number, whitelist?: readonly {file: string, reason: string, expires: string}[]}} [options]
 */
export function checkSize(root, options = {}) {
  const limit = options.limit ?? SIZE_LIMIT;
  const whitelist = options.whitelist ?? SIZE_WHITELIST;
  const allowed = new Map();
  for (const entry of activeExemptions(whitelist, { now: options.now })) {
    allowed.set(toPosix(entry.file), entry.reason);
  }

  const violations = [
    ...exemptionViolations(whitelist, { rule: 'size-whitelist', label: 'size', now: options.now }),
  ];
  const seen = new Set();
  const shellDir = join(root, 'src', 'shell');

  let info;
  try {
    info = statSync(shellDir);
  } catch {
    violations.push({
      file: 'src/shell',
      line: 0,
      rule: 'size-root',
      detail: 'shell 目录不存在或不可访问；拒绝以空结果通过',
    });
    return violations;
  }
  if (!info.isDirectory()) {
    violations.push({
      file: 'src/shell',
      line: 0,
      rule: 'size-root',
      detail: 'src/shell 不是目录；拒绝以空结果通过',
    });
    return violations;
  }

  const files = [];
  const problems = [];
  walk(shellDir, root, files, problems);
  violations.push(...problems);

  for (const file of files.sort()) {
    const rel = toPosix(relative(root, file));
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch (error) {
      violations.push({
        file: rel,
        line: 0,
        rule: 'size-read',
        detail: `文件无法读取：${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    const lines = countLines(source);
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

  // 目录存在却一个源码文件都没扫到：多半是根路径给错或目录被搬走，
  // 与「确实没有 shell 代码」无法区分，一律拒绝放行。
  if (files.length === 0 && problems.length === 0) {
    violations.push({
      file: 'src/shell',
      line: 0,
      rule: 'size-empty',
      detail: '未扫描到任何 .ts/.tsx 文件；拒绝以空结果通过',
    });
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
