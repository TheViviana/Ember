import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_ROOT,
  GATE_FLOORS,
  floorViolations,
  listModules,
  maskLiterals,
  readViolations,
  stripComments,
  toPosix,
} from './lib.mjs';

/**
 * 构建目标兼容性门禁：`vite.config.ts` 的 target 是 safari16（macOS 13 的 WebKit），
 * 而 esbuild 只降**语法**、不 polyfill **运行时 API**。类型层用的是 ES2022 lib，
 * 但 lib 只是下限而非上限，所以这里把「Safari 16 不支持的 API」单独列出来扫。
 *
 * 规则刻意只覆盖「会静默通过类型检查、只在真机运行期炸」的那批 API；
 * 语法层面的问题由 esbuild target 自己负责。
 */
export const POST_SAFARI16_APIS = [
  {
    rule: 'api-to-sorted',
    re: /\.to(?:Sorted|Reversed|Spliced)\s*\(/,
    hint: 'Array.prototype.toSorted/toReversed/toSpliced 需要 Safari 18+，请改用 [...arr].sort() / slice().reverse()',
  },
  {
    rule: 'api-array-with',
    re: /\.with\s*\(\s*[0-9A-Za-z_$]/,
    hint: 'Array.prototype.with 需要 Safari 18+，请改用 arr.map 或 splice 复制后赋值',
  },
  {
    rule: 'api-group-by',
    re: /\b(?:Object|Map)\s*\.\s*groupBy\s*(?:<[^>]*>)?\s*\(/,
    hint: 'Object.groupBy / Map.groupBy 需要 Safari 17.4+，请改用 reduce 手动分组',
  },
  {
    rule: 'api-promise-with-resolvers',
    re: /\bPromise\s*\.\s*withResolvers\s*(?:<[^>]*>)?\s*\(/,
    hint: 'Promise.withResolvers 需要 Safari 17.4+，请改用 new Promise 手动保存 resolve',
  },
  {
    rule: 'api-promise-try',
    re: /\bPromise\s*\.\s*try\s*(?:<[^>]*>)?\s*\(/,
    hint: 'Promise.try 需要 Safari 18.4+，请改用 Promise.resolve().then()',
  },
  {
    rule: 'api-abort-signal-any',
    re: /\bAbortSignal\s*\.\s*any\s*\(/,
    hint: 'AbortSignal.any 需要 Safari 17.4+，请改用 AbortController 手动串联',
  },
  {
    rule: 'api-string-well-formed',
    re: /\.(?:isWellFormed|toWellFormed)\s*\(/,
    hint: 'String.prototype.isWellFormed/toWellFormed 需要 Safari 17+，请改用 /[\\uD800-\\uDFFF]/ 自检',
  },
  {
    rule: 'api-set-methods',
    re: /\.(?:intersection|union|difference|symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\s*\(/,
    hint: 'Set 集合运算方法需要 Safari 17+，请改用 filter/has 手动实现',
  },
  {
    rule: 'api-array-from-async',
    re: /\bArray\s*\.\s*fromAsync\s*\(/,
    hint: 'Array.fromAsync 需要 Safari 18.4+，请改用 for await 手动收集',
  },
  {
    rule: 'api-url-parse',
    re: /\bURL\s*\.\s*parse\s*\(/,
    hint: 'URL.parse 需要 Safari 18.4+，请改用 try { new URL(...) } catch',
  },
  {
    rule: 'api-scheduler-yield',
    re: /\bscheduler\s*\.\s*yield\s*\(/,
    hint: 'scheduler.yield 需要 Safari 18+，请改用 await new Promise(setTimeout)',
  },
];

/** 行尾注释：字面量先被抹成空格，剩下的 `//` 一定是真注释 */
const stripTrailingComment = (line) => {
  const at = line.indexOf('//');
  return at === -1 ? line : line.slice(0, at);
};

/**
 * 只留可执行代码：先剥注释（块注释里可能有撇号，必须先处理），
 * 再抹字符串/模板字面量，最后切掉行尾注释，保证行号不变。
 */
export const maskCode = (source) =>
  maskLiterals(stripComments(source))
    .split('\n')
    .map(stripTrailingComment)
    .join('\n');

/**
 * 扫描 post-Safari-16 API，返回 {file, line, rule, detail}。
 * 只扫 src/** 与 packages/*\/src/**（`listModules` 的口径），
 * tests/ 与 scripts/ 跑在 Node 上，不受 WebKit 版本约束。
 */
export function checkSafariCompat(root) {
  const problems = [];
  const modules = listModules(root, problems);
  const violations = [];
  let scanned = 0;

  for (const file of modules) {
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch (error) {
      problems.push({ path: file, detail: `读取文件失败：${error.code ?? error.message}` });
      continue;
    }
    scanned += 1;
    const lines = maskCode(source).split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      for (const { rule, re, hint } of POST_SAFARI16_APIS) {
        if (re.test(line)) {
          violations.push({
            file: toPosix(relative(resolve(root), file)),
            line: i + 1,
            rule,
            detail: hint,
          });
        }
      }
    }
  }

  violations.push(...readViolations(root, problems));
  violations.push(
    ...floorViolations([
      { metric: 'compat 扫描文件数', actual: scanned, expected: GATE_FLOORS.compatFiles },
    ]),
  );
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
  const violations = checkSafariCompat(root);
  if (json) {
    process.stdout.write(`${JSON.stringify({ gate: 'compat', root, violations }, null, 2)}\n`);
  } else {
    for (const v of violations) {
      process.stdout.write(`${v.file}:${v.line}  [${v.rule}] ${v.detail}\n`);
    }
    process.stdout.write(
      violations.length === 0
        ? 'gate:compat 通过：0 处 post-Safari-16 API\n'
        : `gate:compat 失败：${violations.length} 处不兼容 API\n`,
    );
  }
  process.exit(violations.length === 0 ? 0 : 1);
}
