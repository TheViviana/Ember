import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCsp } from './csp.mjs';
import { scanBans } from './bans.mjs';
import { findCycles } from './cycles.mjs';
import { checkLayers } from './layers.mjs';
import { LAYER_RULES, MODULE_EXEMPTIONS, MODULE_LAYOUT } from './lib.mjs';
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

const tempRoots = [];
const makeTempRoot = (prefix = 'ember-gate-tree-') => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
};

/** 合规树：6 个必需目录、101 个模块（≥100）、263 条相对 import（≥200）、41 个 .rs（共 142 文件） */
const buildCompliantTree = (dir) => {
  const modules = [];
  const write = (rel, text) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
    if (rel.endsWith('.ts') || rel.endsWith('.tsx')) modules.push(rel);
  };
  const groups = [
    ['src/shell', 79],
    ['src/kernel', 6],
    ['src/data', 4],
    ['src/capabilities/core', 2],
    ['src/capabilities/example-hello', 1],
    ['packages/doc-model/src', 6],
    ['packages/canvas-engine/src', 2],
  ];
  for (const [dirPath, count] of groups) {
    for (let i = 0; i < count; i += 1) {
      let source = '';
      for (const back of [1, 2, 3]) {
        if (i - back >= 0) source += `import { v${i - back} } from './m${i - back}';\n`;
      }
      write(`${dirPath}/m${i}.ts`, `${source}export const v${i} = ${i};\n`);
    }
  }
  write('src/capabilities/index.ts', 'export const assembly = true;\n');
  for (let i = 0; i < 41; i += 1) write(`src-tauri/stub${i}.rs`, '\n');
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'gate-fixture', type: 'module', imports: {} }, null, 2),
  );
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { baseUrl: '.', paths: {} } }, null, 2),
  );
  return modules;
};

/** 写别名配置：imports 为权威，paths 由同一份映射生成，保证不触发 gate-alias-drift */
const writeAliasConfig = (dir, imports) => {
  const paths = Object.fromEntries(Object.entries(imports).map(([key, value]) => [key, [value]]));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'gate-fixture', imports }, null, 2));
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { baseUrl: '.', paths } }, null, 2),
  );
};

/** 写多候选 paths：用于验证 drift 只比较“首个存在的候选” */
const writePathsConfig = (dir, imports, paths) => {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'gate-fixture', imports }, null, 2));
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { baseUrl: '.', paths } }, null, 2),
  );
};

for (const [name, script] of Object.entries(SCRIPTS)) {
  const fixtureRoot = join(here, 'fixtures', name);
  const expected = JSON.parse(readFileSync(join(fixtureRoot, 'expected.json'), 'utf8'));
  // fixture 只包含验证规则所需的最小文件；复制到临时合规树上补齐结构与规模，
  // 这样“无多报”比较不会被 gate-* 充分性违规干扰。
  const sandbox = makeTempRoot(`ember-gate-fixture-${name}-`);
  cpSync(fixtureRoot, sandbox, {
    recursive: true,
    filter: (src) => !src.endsWith('expected.json'),
  });
  buildCompliantTree(sandbox);
  const actual = runGate(script, sandbox);
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

// CSP 门禁：临时目录构造最小 index.html + tauri.conf.json，逐条验证“放宽必须失败”
{
  const cspRoot = mkdtempSync(join(tmpdir(), 'ember-gate-csp-'));
  mkdirSync(join(cspRoot, 'src-tauri'), { recursive: true });
  const styleText = 'html, body { background: #0a0a0a; }';
  const styleHash = `'sha256-${createHash('sha256').update(styleText).digest('base64')}'`;
  const index = `<!doctype html><html><head><style>${styleText}</style></head><body></body></html>`;
  const baseCsp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    `style-src-elem 'self' ${styleHash}`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self' ipc: http://ipc.localhost",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-src 'none'",
  ].join('; ');
  const baseDevCsp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self' ws://localhost:5173 http://localhost:5173 ipc: http://ipc.localhost",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join('; ');

  const runCsp = ({ csp = baseCsp, devCsp = baseDevCsp, html = index } = {}) => {
    writeFileSync(
      join(cspRoot, 'src-tauri', 'tauri.conf.json'),
      JSON.stringify({ app: { security: { csp, devCsp } } }),
    );
    writeFileSync(join(cspRoot, 'index.html'), html);
    return checkCsp(cspRoot);
  };

  const expectCspRule = (label, options, rule) => {
    const violations = runCsp(options);
    if (violations.some((v) => v.rule === rule)) {
      process.stdout.write(`✓ selftest:csp ${label}\n`);
    } else {
      failures += 1;
      process.stdout.write(
        `✗ selftest:csp ${label}：期望命中 ${rule}，实际 ${JSON.stringify(violations)}\n`,
      );
    }
  };

  const expectCspPass = (label, options) => {
    const violations = runCsp(options);
    if (violations.length === 0) {
      process.stdout.write(`✓ selftest:csp ${label}\n`);
    } else {
      failures += 1;
      process.stdout.write(`✗ selftest:csp ${label}：期望 0 违规，实际 ${JSON.stringify(violations)}\n`);
    }
  };

  expectCspPass('真实基线通过', {});
  expectCspRule(
    'script-src 出现 unsafe-eval 必须失败',
    { csp: baseCsp.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'") },
    'csp-forbidden-token',
  );
  expectCspRule(
    'script-src 出现 unsafe-inline 必须失败',
    { csp: baseCsp.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'") },
    'csp-forbidden-token',
  );
  expectCspRule(
    'script-src 新增外域必须失败',
    { csp: baseCsp.replace("script-src 'self'", "script-src 'self' https://evil.example") },
    'csp-directive',
  );
  expectCspRule(
    'connect-src 新增外域必须失败',
    {
      csp: baseCsp.replace(
        "connect-src 'self' ipc: http://ipc.localhost",
        "connect-src 'self' ipc: http://ipc.localhost https://evil.example",
      ),
    },
    'csp-directive',
  );
  expectCspRule(
    '新增未登记指令必须失败',
    { csp: `${baseCsp}; worker-src 'self'` },
    'csp-unknown-directive',
  );
  expectCspRule(
    '删掉 base-uri 必须失败',
    { csp: baseCsp.replace("; base-uri 'self'", '') },
    'csp-missing-directive',
  );
  expectCspRule(
    '重复 script-src 必须失败',
    { csp: `${baseCsp}; script-src 'unsafe-eval'` },
    'csp-duplicate-directive',
  );
  expectCspRule(
    '空值指令必须失败',
    { csp: baseCsp.replace("script-src 'self'", 'script-src') },
    'csp-empty-directive',
  );
  expectCspRule(
    'style-src-attr 去掉 unsafe-inline 必须失败',
    { csp: baseCsp.replace("style-src-attr 'unsafe-inline'", "style-src-attr 'self'") },
    'csp-attr-katex',
  );
  expectCspRule(
    '内联样式改动但未同步哈希必须失败',
    { html: index.replace(styleText, 'html, body { background: #111; }') },
    'csp-elem-hash',
  );
  expectCspRule(
    'devCsp 收紧到生产值必须失败',
    { devCsp: baseDevCsp.replace("script-src 'self' 'unsafe-inline' 'unsafe-eval'", "script-src 'self'") },
    'csp-directive',
  );
  expectCspRule(
    'devCsp connect-src 新增外域必须失败',
    {
      devCsp: baseDevCsp.replace(
        'ws://localhost:5173 http://localhost:5173',
        'ws://localhost:5173 http://localhost:5173 https://evil.example',
      ),
    },
    'csp-directive',
  );
  expectCspRule(
    '生产 style-src 出现 unsafe-inline 必须失败',
    { csp: baseCsp.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'") },
    'csp-directive',
  );

  const nextStyle = 'html, body { background: #121212; }';
  const nextHash = `'sha256-${createHash('sha256').update(nextStyle).digest('base64')}'`;
  expectCspPass('改内联样式并同步哈希仍通过', {
    csp: baseCsp.replace(`style-src-elem 'self' ${styleHash}`, `style-src-elem 'self' ${nextHash}`),
    html: index.replace(styleText, nextStyle),
  });
  expectCspPass('调整顺序与末尾分号仍通过', {
    csp: `${baseCsp.split('; ').reverse().join('; ')};`,
  });

  rmSync(cspRoot, { recursive: true, force: true });
}

// 扫描充分性门禁：合成合规树 + 四类破坏，验证“0 违规不等于通过”
{
  const makeRoot = () => makeTempRoot();
  const buildTree = buildCompliantTree;

  const runGates = (root) => ({
    cycles: findCycles(root),
    layers: checkLayers(root),
    bans: scanBans(root),
  });

  /** 逐 gate 断言命中指定规则；默认要求 cycles/layers/bans 三个都命中 */
  const expectRule = (label, root, rule, gateNames = ['cycles', 'layers', 'bans']) => {
    const results = runGates(root);
    const missed = gateNames.filter(
      (name) => !results[name].some((violation) => violation.rule === rule),
    );
    if (missed.length === 0) {
      process.stdout.write(`✓ selftest:gate ${label}（${gateNames.join('/')} 命中 ${rule}）\n`);
    } else {
      failures += 1;
      process.stdout.write(
        `✗ selftest:gate ${label}：${missed.join('/')} 未命中 ${rule}，实际 ${JSON.stringify(results)}\n`,
      );
    }
  };

  const expectPass = (label, root) => {
    const results = runGates(root);
    const total = Object.values(results).reduce((sum, violations) => sum + violations.length, 0);
    if (total === 0) {
      process.stdout.write(`✓ selftest:gate ${label}\n`);
    } else {
      failures += 1;
      process.stdout.write(`✗ selftest:gate ${label}：期望 0 违规，实际 ${JSON.stringify(results)}\n`);
    }
  };

  expectRule('root 不存在必须失败', join(makeRoot(), 'does-not-exist'), 'gate-root');

  const fileRoot = makeRoot();
  writeFileSync(join(fileRoot, 'plain.txt'), 'x');
  expectRule('root 是文件必须失败', join(fileRoot, 'plain.txt'), 'gate-root');

  expectRule('空目录必须失败', makeRoot(), 'gate-missing-dir');

  const missingKernel = makeRoot();
  buildTree(missingKernel);
  rmSync(join(missingKernel, 'src', 'kernel'), { recursive: true, force: true });
  expectRule('必需目录被删除必须失败', missingKernel, 'gate-missing-dir');

  const cleared = makeRoot();
  buildTree(cleared);
  rmSync(join(cleared, 'src'), { recursive: true, force: true });
  expectRule('src 被清空必须失败', cleared, 'gate-floor');

  const pruned = makeRoot();
  const prunedModules = buildTree(pruned);
  for (const rel of prunedModules.slice(20)) rmSync(join(pruned, rel));
  expectRule('模块数低于下限必须失败', pruned, 'gate-floor');

  const noShell = makeRoot();
  buildTree(noShell);
  rmSync(join(noShell, 'src', 'shell'), { recursive: true, force: true });
  expectRule('shell 层被清空必须失败', noShell, 'gate-empty', ['layers']);

  const noEdges = makeRoot();
  for (const rel of buildTree(noEdges)) {
    if (rel.endsWith('.ts')) writeFileSync(join(noEdges, rel), 'export const v = 0;\n');
  }
  expectRule('import 全被删除必须失败', noEdges, 'gate-empty', ['cycles', 'layers']);

  const isRoot = process.getuid?.() === 0;
  if (isRoot) {
    process.stdout.write('✓ selftest:gate 不可读目录/文件用例已跳过（以 root 运行）\n');
  } else {
    const unreadableDir = makeRoot();
    buildTree(unreadableDir);
    const lockedDir = join(unreadableDir, 'packages', 'doc-model');
    chmodSync(lockedDir, 0o000);
    expectRule('必需目录不可读必须失败', unreadableDir, 'gate-read');
    chmodSync(lockedDir, 0o755);

    const unreadableFile = makeRoot();
    buildTree(unreadableFile);
    const lockedFile = join(unreadableFile, 'src', 'kernel', 'm0.ts');
    chmodSync(lockedFile, 0o000);
    expectRule('模块文件不可读必须失败', unreadableFile, 'gate-read');
    chmodSync(lockedFile, 0o644);
  }

  expectPass('真实仓库通过', join(here, '..', '..'));

  const legal = makeRoot();
  buildTree(legal);
  expectPass('合成合规树通过', legal);

  const extended = makeRoot();
  buildTree(extended);
  mkdirSync(join(extended, 'packages', 'new-pkg', 'src'), { recursive: true });
  writeFileSync(join(extended, 'packages', 'new-pkg', 'src', 'a.ts'), 'export const a = 1;\n');
  expectRule('新增未登记 packages 子包必须失败', extended, 'gate-unclassified');

  // —— 别名解析与 fail-closed 分层 ——
  const aliasCycle = makeRoot();
  buildTree(aliasCycle);
  writeAliasConfig(aliasCycle, { '#dm': './packages/doc-model/src/index.ts' });
  writeFileSync(
    join(aliasCycle, 'src', 'shell', 'a.ts'),
    "import { dm } from '#dm';\nexport const a = dm;\n",
  );
  writeFileSync(
    join(aliasCycle, 'packages', 'doc-model', 'src', 'index.ts'),
    "import { a } from '../../../src/shell/a.ts';\nexport const dm = a;\n",
  );
  expectRule('别名表达的环必须被报出', aliasCycle, 'cycle', ['cycles']);

  const relativeCycle = makeRoot();
  buildTree(relativeCycle);
  writeFileSync(
    join(relativeCycle, 'src', 'shell', 'a.ts'),
    "import { dm } from '../../packages/doc-model/src/index.ts';\nexport const a = dm;\n",
  );
  writeFileSync(
    join(relativeCycle, 'packages', 'doc-model', 'src', 'index.ts'),
    "import { a } from '../../../src/shell/a.ts';\nexport const dm = a;\n",
  );
  expectRule('同一环改成相对写法仍被报出', relativeCycle, 'cycle', ['cycles']);

  const typeOnlyAlias = makeRoot();
  buildTree(typeOnlyAlias);
  writeAliasConfig(typeOnlyAlias, { '#dm': './packages/doc-model/src/index.ts' });
  writeFileSync(
    join(typeOnlyAlias, 'src', 'shell', 'a.ts'),
    "import { dm } from '#dm';\nexport const a = dm;\n",
  );
  writeFileSync(
    join(typeOnlyAlias, 'packages', 'doc-model', 'src', 'index.ts'),
    "import type { a } from '../../../src/shell/a.ts';\nexport const dm = a;\n",
  );
  const typeCycles = findCycles(typeOnlyAlias);
  if (typeCycles.length === 0) {
    process.stdout.write('✓ selftest:gate 纯类型别名回边不计入环\n');
  } else {
    failures += 1;
    process.stdout.write(`✗ selftest:gate 纯类型别名回边不计入环：${JSON.stringify(typeCycles)}\n`);
  }

  const aliasCrossLayer = makeRoot();
  buildTree(aliasCrossLayer);
  writeAliasConfig(aliasCrossLayer, { '#sh': './src/shell/m0.ts' });
  writeFileSync(
    join(aliasCrossLayer, 'src', 'kernel', 'm0.ts'),
    "import { v0 as shellV0 } from '#sh';\nexport const k0 = shellV0;\n",
  );
  expectRule('kernel 经别名引用 shell 必须被拦下', aliasCrossLayer, 'forbidden-internal', ['layers']);

  const pkgReverse = makeRoot();
  buildTree(pkgReverse);
  writeAliasConfig(pkgReverse, { '#sh': './src/shell/m0.ts' });
  writeFileSync(
    join(pkgReverse, 'packages', 'doc-model', 'src', 'index.ts'),
    "import { v0 } from '#sh';\nexport const dm = v0;\n",
  );
  expectRule('包层反向依赖 shell 必须失败', pkgReverse, 'forbidden-internal', ['layers']);

  const unknownDir = makeRoot();
  buildTree(unknownDir);
  mkdirSync(join(unknownDir, 'src', 'styles'), { recursive: true });
  writeFileSync(join(unknownDir, 'src', 'styles', 'x.ts'), 'export const x = 1;\n');
  expectRule('新增未登记 src 目录必须失败', unknownDir, 'gate-unclassified');

  const badAlias = makeRoot();
  buildTree(badAlias);
  writeFileSync(
    join(badAlias, 'src', 'shell', 'bad.ts'),
    "import { x } from '#nope';\nexport const b = x;\n",
  );
  expectRule('未知别名必须失败', badAlias, 'gate-alias-unresolved', ['cycles', 'layers']);

  const drift = makeRoot();
  buildTree(drift);
  writeAliasConfig(drift, { '#dm': './packages/doc-model/src/index.ts' });
  writeFileSync(
    join(drift, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { baseUrl: '.', paths: {} } }, null, 2),
  );
  expectRule('imports 与 tsconfig paths 不一致必须失败', drift, 'gate-alias-drift', [
    'cycles',
    'layers',
  ]);

  const legalAlias = makeRoot();
  buildTree(legalAlias);
  writeAliasConfig(legalAlias, { '#dm': './packages/doc-model/src/index.ts' });
  writeFileSync(join(legalAlias, 'packages', 'doc-model', 'src', 'index.ts'), 'export const v0 = 0;\n');
  for (const rel of ['src/shell/m1.ts', 'src/kernel/m1.ts', 'src/data/m1.ts', 'src/capabilities/core/m1.ts']) {
    writeFileSync(join(legalAlias, rel), "import { v0 } from '#dm';\nexport const x = v0;\n");
  }
  expectPass('合法别名方向通过', legalAlias);

  const wildcardAlias = makeRoot();
  buildTree(wildcardAlias);
  writeAliasConfig(wildcardAlias, { '#dm/*': './packages/doc-model/src/*.ts' });
  writeFileSync(
    join(wildcardAlias, 'src', 'shell', 'm1.ts'),
    "import { v0 } from '#dm/m1';\nexport const x = v0;\n",
  );
  expectPass('通配别名可解析且方向合法通过', wildcardAlias);

  // —— 配置损坏必须单独报错，不再退化成 drift/unresolved ——
  const brokenPkg = makeRoot();
  buildTree(brokenPkg);
  writeFileSync(join(brokenPkg, 'package.json'), '{"imports": {');
  expectRule('package.json 损坏必须失败', brokenPkg, 'gate-alias-config', ['cycles', 'layers']);

  const noTsconfig = makeRoot();
  buildTree(noTsconfig);
  rmSync(join(noTsconfig, 'tsconfig.json'));
  expectRule('tsconfig.json 缺失必须失败', noTsconfig, 'gate-alias-config', ['cycles', 'layers']);

  const noPkg = makeRoot();
  buildTree(noPkg);
  rmSync(join(noPkg, 'package.json'));
  expectRule('package.json 缺失必须失败', noPkg, 'gate-alias-config', ['cycles', 'layers']);

  // —— drift 只比较“首个存在的候选” ——
  const driftSecond = makeRoot();
  buildTree(driftSecond);
  writePathsConfig(
    driftSecond,
    { '#dm': './packages/doc-model/src/index.ts' },
    { '#dm': ['./packages/doc-model/src/missing.ts', './packages/doc-model/src/index.ts'] },
  );
  writeFileSync(join(driftSecond, 'packages', 'doc-model', 'src', 'index.ts'), 'export const v0 = 0;\n');
  expectPass('首候选不存在、次候选一致不报 drift', driftSecond);

  const driftExisting = makeRoot();
  buildTree(driftExisting);
  writePathsConfig(
    driftExisting,
    { '#dm': './packages/doc-model/src/index.ts' },
    { '#dm': ['./packages/doc-model/src/other.ts', './packages/doc-model/src/index.ts'] },
  );
  writeFileSync(join(driftExisting, 'packages', 'doc-model', 'src', 'index.ts'), 'export const v0 = 0;\n');
  writeFileSync(join(driftExisting, 'packages', 'doc-model', 'src', 'other.ts'), 'export const other = 1;\n');
  expectRule('首候选存在且不同仍然 drift', driftExisting, 'gate-alias-drift', ['cycles', 'layers']);

  const driftExtra = makeRoot();
  buildTree(driftExtra);
  writePathsConfig(
    driftExtra,
    { '#dm': './packages/doc-model/src/index.ts' },
    { '#dm': ['./packages/doc-model/src/index.ts', './packages/doc-model/src/other.ts'] },
  );
  writeFileSync(join(driftExtra, 'packages', 'doc-model', 'src', 'index.ts'), 'export const v0 = 0;\n');
  writeFileSync(join(driftExtra, 'packages', 'doc-model', 'src', 'other.ts'), 'export const other = 1;\n');
  expectPass('首候选正确时不因多余候选报 drift', driftExtra);
}

{
  const badExemptions = MODULE_EXEMPTIONS.filter(
    (entry) =>
      !entry.file.endsWith('.d.ts') ||
      typeof entry.reason !== 'string' ||
      entry.reason.trim().length === 0,
  );
  const missingRules = MODULE_LAYOUT.filter((entry) => LAYER_RULES[entry.layer] === undefined);
  if (badExemptions.length === 0 && missingRules.length === 0) {
    process.stdout.write('✓ selftest:gate 登记表仅豁免 .d.ts 且层规则齐全\n');
  } else {
    failures += 1;
    process.stdout.write(
      `✗ selftest:gate 登记表校验失败：豁免 ${JSON.stringify(badExemptions)}，缺规则 ${JSON.stringify(missingRules)}\n`,
    );
  }
}

for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });

process.exit(failures === 0 ? 0 : 1);
