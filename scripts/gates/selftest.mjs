import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripRustComments } from './offline.mjs';

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

process.exit(failures === 0 ? 0 : 1);
