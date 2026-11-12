import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripRustComments } from './offline.mjs';
import { checkSize, SIZE_LIMIT } from './size.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = { layers: 'layers.mjs', cycles: 'cycles.mjs', bans: 'bans.mjs' };

const runGate = (script, root) => {
  try {
    return JSON.parse(execFileSync(process.execPath, [join(here, script), '--root', root, '--json'], {
      encoding: 'utf8',
    }));
  } catch (error) {
    const stdout = typeof error === 'object' && error !== null && 'stdout' in error ? String(error.stdout) : '';
    if (stdout.trim() === '') throw error;
    return JSON.parse(stdout);
  }
};

const keyOf = (row) => `${row.file}|${row.rule}`;

const countRows = (rows) => {
  const counts = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
};

let failures = 0;

for (const [name, script] of Object.entries(SCRIPTS)) {
  const fixtureRoot = join(here, 'fixtures', name);
  const expected = JSON.parse(readFileSync(join(fixtureRoot, 'expected.json'), 'utf8'));
  const actual = runGate(script, fixtureRoot);
  const expectedCounts = countRows(expected.rows);
  const actualCounts = countRows(actual.violations.map((v) => ({ file: v.file, rule: v.rule })));

  const lines = [];
  for (const [key, count] of expectedCounts) {
    const got = actualCounts.get(key) ?? 0;
    if (got !== count) lines.push(`  期望 ${key} × ${count}，实际 × ${got}`);
  }
  for (const [key, count] of actualCounts) {
    if (!expectedCounts.has(key)) lines.push(`  多报 ${key} × ${count}`);
  }

  if (lines.length === 0) {
    process.stdout.write(`✓ selftest:${name} 报出全部 ${expected.rows.length} 条预期违规，且无多报\n`);
  } else {
    failures += 1;
    process.stdout.write(`✗ selftest:${name}\n${lines.join('\n')}\n`);
  }
}

for (const [name, script] of Object.entries(SCRIPTS)) {
  const result = runGate(script, join(here, '..', '..'));
  if (result.violations.length === 0) {
    process.stdout.write(`✓ selftest:真实树 ${name} 0 违规\n`);
  } else {
    failures += 1;
    process.stdout.write(`✗ selftest:真实树 ${name} 有 ${result.violations.length} 条违规\n`);
    for (const v of result.violations) process.stdout.write(`  ${v.file}:${v.line} [${v.rule}] ${v.detail}\n`);
  }
}

const rustCases = [
  {
    name: 'Rust 行注释内的地址不计入',
    source: '// https://comment.example/path\nfn a() {}',
    shouldMatch: false,
  },
  {
    name: 'Rust 嵌套块注释内的地址不计入',
    source: '/* outer /* inner https://comment.example/x */ still */\nfn a() {}',
    shouldMatch: false,
  },
  {
    name: 'Rust 字符串内的地址仍然计入',
    source: 'fn a() { let u = "https://string.example/x"; }',
    shouldMatch: true,
  },
  {
    name: 'Rust 字符字面量不会吞掉后续代码',
    source: String.raw`fn a() { let slash = '/'; let quote = '\''; let u = "https://after.example/x"; }`,
    shouldMatch: true,
  },
  {
    name: 'Rust 生命周期不会开启字符串模式',
    source: `fn a<'a>(v: &'a str) -> &'a str { v }\nfn b() { let u = "https://lifetime.example/x"; }`,
    shouldMatch: true,
  },
  {
    name: 'Rust 原始字符串内的地址仍然计入',
    source: 'fn a() { let u = r#"https://raw.example/x"#; }',
    shouldMatch: true,
  },
];

for (const testCase of rustCases) {
  const stripped = stripRustComments(testCase.source);
  const matched = /https?:\/\/[^\s"'`<>)\]}]+/.test(stripped);
  if (matched === testCase.shouldMatch) {
    process.stdout.write(`✓ selftest:rust ${testCase.name}\n`);
  } else {
    failures += 1;
    process.stdout.write(
      `✗ selftest:rust ${testCase.name}：期望${testCase.shouldMatch ? '保留' : '剥离'}地址\n`,
    );
  }
}

{
  const tmp = mkdtempSync(join(tmpdir(), 'ember-gate-size-'));
  const shellDir = join(tmp, 'src', 'shell');
  mkdirSync(shellDir, { recursive: true });
  writeFileSync(join(shellDir, 'big.ts'), 'const a = 1;\n'.repeat(SIZE_LIMIT + 1));
  writeFileSync(join(shellDir, 'small.ts'), 'const b = 1;\n');

  const over = checkSize(tmp, { whitelist: [] });
  const hit = over.length === 1 && over[0].rule === 'size' && over[0].file === 'src/shell/big.ts';
  if (hit) {
    process.stdout.write(`✓ selftest:size 超限命中 ${SIZE_LIMIT + 1} 行文件\n`);
  } else {
    failures += 1;
    process.stdout.write(`✗ selftest:size 超限未按预期命中：${JSON.stringify(over)}\n`);
  }

  const passed = checkSize(tmp, {
    whitelist: [{ file: 'src/shell/big.ts', reason: '自测豁免' }],
  });
  if (passed.length === 0) {
    process.stdout.write('✓ selftest:size 白名单条目放行\n');
  } else {
    failures += 1;
    process.stdout.write(`✗ selftest:size 白名单未放行：${JSON.stringify(passed)}\n`);
  }

  const stale = checkSize(tmp, {
    whitelist: [
      { file: 'src/shell/big.ts', reason: '自测豁免' },
      { file: 'src/shell/small.ts', reason: '已拆分但忘记删除' },
    ],
  });
  const staleHit = stale.length === 1 && stale[0].rule === 'size-stale';
  if (staleHit) {
    process.stdout.write('✓ selftest:size 过期豁免被报出\n');
  } else {
    failures += 1;
    process.stdout.write(`✗ selftest:size 过期豁免未按预期报出：${JSON.stringify(stale)}\n`);
  }

  const expectRule = (label, root, rule) => {
    const result = checkSize(root, { whitelist: [] });
    if (result.length === 1 && result[0].rule === rule) {
      process.stdout.write(`✓ selftest:size ${label}\n`);
    } else {
      failures += 1;
      process.stdout.write(`✗ selftest:size ${label}：${JSON.stringify(result)}\n`);
    }
  };

  // 根路径不存在 / src/shell 不是目录：必须失败，不能以 0 违规放行
  expectRule('根路径不存在被拒', join(tmp, 'missing-root'), 'size-root');
  mkdirSync(join(tmp, 'not-dir', 'src'), { recursive: true });
  writeFileSync(join(tmp, 'not-dir', 'src', 'shell'), '');
  expectRule('src/shell 是文件被拒', join(tmp, 'not-dir'), 'size-root');

  // 空目录：0 个源码文件必须报出，避免目录被移走后假通过
  mkdirSync(join(tmp, 'empty', 'src', 'shell'), { recursive: true });
  expectRule('空 shell 目录被拒', join(tmp, 'empty'), 'size-empty');

  // 禁止扩展名与隐藏目录都不能绕过行数检查
  mkdirSync(join(tmp, 'js', 'src', 'shell'), { recursive: true });
  writeFileSync(join(tmp, 'js', 'src', 'shell', 'big.js'), 'const a = 1;\n');
  expectRule('shell 下 .js 被拒', join(tmp, 'js'), 'size-ext');
  mkdirSync(join(tmp, 'hidden', 'src', 'shell', '.tmp'), { recursive: true });
  writeFileSync(join(tmp, 'hidden', 'src', 'shell', '.tmp', 'big.ts'), 'const a = 1;\n'.repeat(SIZE_LIMIT + 1));
  expectRule('隐藏目录内超限仍命中', join(tmp, 'hidden'), 'size');

  // 不可读目录：读取异常必须报出，不能当成空树；root 环境无法制造 EACCES，跳过
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    process.stdout.write('✓ selftest:size 不可读目录（root 环境跳过）\n');
  } else {
    mkdirSync(join(tmp, 'locked', 'src', 'shell', 'locked'), { recursive: true });
    writeFileSync(join(tmp, 'locked', 'src', 'shell', 'locked', 'deep.ts'), 'const a = 1;\n');
    chmodSync(join(tmp, 'locked', 'src', 'shell', 'locked'), 0o000);
    try {
      expectRule('不可读目录被拒', join(tmp, 'locked'), 'size-read');
    } finally {
      chmodSync(join(tmp, 'locked', 'src', 'shell', 'locked'), 0o755);
    }
  }

  rmSync(tmp, { recursive: true, force: true });
}

const realSize = checkSize(join(here, '..', '..'));
if (realSize.length === 0) {
  process.stdout.write(`✓ selftest:真实树 size 0 违规（上限 ${SIZE_LIMIT} 行）\n`);
} else {
  failures += 1;
  process.stdout.write(`✗ selftest:真实树 size 有 ${realSize.length} 条违规\n`);
  for (const v of realSize) process.stdout.write(`  ${v.file}:${v.line} [${v.rule}] ${v.detail}\n`);
}

process.exit(failures === 0 ? 0 : 1);
