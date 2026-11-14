import assert from 'node:assert/strict';
import test from 'node:test';
import { createUlid } from '#doc-model';
import { createDocService } from '../../src/kernel/doc-service.ts';
import { EmberError } from '../../src/kernel/errors.ts';
import { createEventBus } from '../../src/kernel/events.ts';
import { createHealthService } from '../../src/kernel/health-service.ts';
import { createPathTools } from '../../src/kernel/paths.ts';
import type { HealthIssue, HealthIssueKind, Logger } from '../../src/kernel/types.ts';
import { createMemoryVault, type MemoryVaultOptions } from './fakes.ts';

const silentLog: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const ID = createUlid(1_700_000_000_000);
const NOW = (): Date => new Date('2026-11-13T00:00:00Z');

const docText = (body: string, frontmatter = `id: ${ID}`): string =>
  `---\n${frontmatter}\n---\n\n${body}\n`;

const setup = (options: MemoryVaultOptions = {}) => {
  const vault = createMemoryVault(options);
  const paths = createPathTools();
  const events = createEventBus();
  const docs = createDocService({ port: vault.port, paths, events, log: silentLog, now: NOW });
  const health = createHealthService({ port: vault.port, paths, docs, log: silentLog, now: NOW });
  return { vault, docs, health };
};

const issuesOf = (issues: readonly HealthIssue[], kind: HealthIssueKind): HealthIssue[] =>
  issues.filter((item) => item.kind === kind);

const one = (issues: readonly HealthIssue[], kind: HealthIssueKind): HealthIssue => {
  const matched = issuesOf(issues, kind);
  const first = matched[0];
  assert.ok(first !== undefined, `应存在 ${kind} 问题`);
  return first;
};

const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof EmberError, `应抛 EmberError，实际：${String(error)}`);
    return error.code;
  }
  assert.fail('应当抛出错误');
};

void test('坏 YAML 可被发现且不可修复', async () => {
  const { health } = setup({
    files: { 'notes/bad.md': '---\ntags: [unclosed\n---\n\n正文\n' },
  });

  const report = await health.scan();
  const issue = one(report.issues, 'broken_frontmatter');

  assert.equal(issue.path, 'notes/bad.md');
  assert.equal(issue.fix, null);
  assert.ok(issue.hash !== null);
  assert.equal(issuesOf(report.issues, 'missing_id').length, 0);
});

void test('缺失 id 可通过 adoption 纳入库管理，正文不变', async () => {
  const { vault, docs, health } = setup({
    files: { 'notes/inbox.md': '# 收集\n\n待整理正文\n' },
  });

  const report = await health.scan();
  const issue = one(report.issues, 'missing_id');
  assert.equal(issue.fix, 'adopt');
  assert.equal(issue.hash === null, false);

  const snapshot = await health.adopt(issue.path, issue.hash ?? assert.fail('缺少 hash'));
  assert.match(snapshot.text, /^---\n/);
  assert.ok(snapshot.text.includes('# 收集\n\n待整理正文'));

  const listed = await docs.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.path, 'notes/inbox.md');

  const after = await health.scan();
  assert.equal(issuesOf(after.issues, 'missing_id').length, 0);
  assert.ok(vault.dump()['notes/inbox.md']?.includes('待整理正文'));
});

void test('非法 id 只报告，不写盘', async () => {
  const { vault, health } = setup({ files: { 'notes/bad-id.md': docText('正文', 'id: nope') } });
  const before = vault.dump();

  const report = await health.scan();
  const issue = one(report.issues, 'invalid_id');

  assert.equal(issue.fix, null);
  assert.deepEqual(vault.dump(), before);
});

void test('重复 id 会标出全部路径', async () => {
  const { health } = setup({
    files: {
      'notes/a.md': docText('A'),
      'notes/b.md': docText('B'),
    },
  });

  const report = await health.scan();
  const duplicates = issuesOf(report.issues, 'duplicate_id');

  assert.equal(duplicates.length, 2);
  for (const issue of duplicates) {
    assert.equal(issue.fix, null);
    assert.ok(issue.detail.includes('notes/a.md'));
    assert.ok(issue.detail.includes('notes/b.md'));
  }
});

void test('非 UTF-8 只报告，不产生 id 问题', async () => {
  const { health } = setup({
    rawFiles: { 'notes/broken.md': Uint8Array.from([0xff, 0xfe, 0x00]) },
  });

  const report = await health.scan();
  const issue = one(report.issues, 'non_utf8');

  assert.equal(issue.fix, null);
  assert.equal(issuesOf(report.issues, 'missing_id').length, 0);
  assert.equal(issuesOf(report.issues, 'broken_frontmatter').length, 0);
});

void test('超限文件不读取：只报告 oversize', async () => {
  const path = 'notes/huge.md';
  const { vault, health } = setup({
    files: { [path]: '# huge' },
    sizes: { [path]: 33 * 1024 * 1024 },
  });

  const report = await health.scan();
  const issue = one(report.issues, 'oversize');

  assert.equal(issue.fix, null);
  assert.equal(issue.hash, null);
  assert.ok(!vault.reads.includes(path));
});

void test('.markdown 可安全改名为 .md 并进入目录', async () => {
  const { vault, docs, health } = setup({
    files: { 'notes/legacy.markdown': docText('旧文件') },
  });

  const report = await health.scan();
  const issue = one(report.issues, 'markdown_extension');
  assert.equal(issue.fix, 'rename-markdown');
  assert.equal(issue.hash === null, false);

  const target = await health.renameMarkdown(issue.path, issue.hash ?? assert.fail('缺少 hash'));
  assert.equal(target, 'notes/legacy.md');
  assert.ok(vault.dump()['notes/legacy.md'] !== undefined);
  assert.equal(vault.dump()['notes/legacy.markdown'], undefined);

  const listed = await docs.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.path, 'notes/legacy.md');
});

void test('.markdown 目标已存在时不覆盖', async () => {
  const { health } = setup({
    files: {
      'notes/legacy.markdown': docText('旧文件'),
      'notes/legacy.md': docText('已存在'),
    },
  });

  const report = await health.scan();
  const issue = one(report.issues, 'markdown_extension');
  assert.equal(issue.fix, null);
  assert.ok(issue.detail.includes('已存在'));

  const code = await codeOf(() =>
    health.renameMarkdown(issue.path, issue.hash ?? assert.fail('缺少 hash')),
  );
  assert.equal(code, 'path_exists');
});

void test('失效资产引用只报告库内 media/ 路径', async () => {
  const path = 'notes/a.md';
  const { health } = setup({
    files: {
      [path]: docText(
        '![missing](media/missing.png)\n\n![external](https://example.com/a.png)\n\n![ok](media/ok.png)',
      ),
      'media/ok.png': 'png',
    },
  });

  const report = await health.scan();
  const broken = issuesOf(report.issues, 'broken_asset');

  assert.equal(broken.length, 1);
  const issue = broken[0];
  assert.ok(issue !== undefined);
  assert.equal(issue.path, path);
  assert.equal(issue.target, 'media/missing.png');
  assert.equal(issue.fix, null);
});

void test('坏画布与坏历史可被发现', async () => {
  const versionId = createUlid(1_700_000_000_001);
  const index = JSON.stringify({
    schemaVersion: 1,
    docId: ID,
    versions: [
      {
        versionId,
        hash: `sha256:${'0'.repeat(64)}`,
        path: 'notes/a.md',
        at: '2026-11-13T00:00:00Z',
        size: 10,
      },
    ],
  });
  const { health } = setup({
    files: {
      '.workbench/canvas/x.json': '{',
      '.workbench/history/x.9.json': '{}',
      [`.workbench/history/documents/${ID}/index.json`]: index,
    },
  });

  const report = await health.scan();

  assert.equal(issuesOf(report.issues, 'broken_canvas').length, 1);
  const historyIssues = issuesOf(report.issues, 'broken_history');
  assert.equal(historyIssues.length, 2);
  assert.ok(historyIssues.some((issue) => issue.detail.includes('槽位')));
  const missingVersion = historyIssues.find((issue) => issue.target !== null);
  assert.ok(missingVersion !== undefined);
  assert.equal(
    missingVersion.target,
    `.workbench/history/documents/${ID}/${versionId}.md`,
  );
});

void test('符号链接只报告不跟随', async () => {
  const { vault, health } = setup({
    files: { 'notes/a.md': docText('A') },
    symlinks: ['notes/link.md'],
  });

  const report = await health.scan();
  const issue = one(report.issues, 'symlink');

  assert.equal(issue.path, 'notes/link.md');
  assert.equal(issue.fix, null);
  assert.equal(report.documents, 1);
  assert.ok(!vault.reads.includes('notes/link.md'));
});

void test('扫描零写入', async () => {
  const { vault, health } = setup({
    files: {
      'notes/a.md': docText('A'),
      'notes/inbox.md': '# inbox\n',
      'notes/legacy.markdown': docText('legacy'),
      '.workbench/canvas/x.json': '{}',
    },
    symlinks: ['notes/link.md'],
  });
  const before = vault.dump();

  await health.scan();

  assert.deepEqual(vault.dump(), before);
});

void test('修复前文件变化则取消，零写入', async () => {
  const path = 'notes/inbox.md';
  const { vault, health } = setup({ files: { [path]: '# 原始\n' } });

  const report = await health.scan();
  const issue = one(report.issues, 'missing_id');
  const hash = issue.hash ?? assert.fail('缺少 hash');

  vault.writeRaw(path, '# 外部修改\n');
  const code = await codeOf(() => health.adopt(issue.path, hash));

  assert.equal(code, 'stale_revision');
  assert.equal(vault.dump()[path], '# 外部修改\n');
});

void test('只读模式可扫描，修复被拒绝', async () => {
  const { health } = setup({
    readonlyMode: true,
    files: {
      'notes/inbox.md': '# inbox\n',
      'notes/legacy.markdown': docText('legacy'),
    },
  });

  const report = await health.scan();
  const missing = one(report.issues, 'missing_id');
  const legacy = one(report.issues, 'markdown_extension');

  assert.equal(
    await codeOf(() => health.adopt(missing.path, missing.hash ?? assert.fail('缺少 hash'))),
    'vault_locked',
  );
  assert.equal(
    await codeOf(() => health.renameMarkdown(legacy.path, legacy.hash ?? assert.fail('缺少 hash'))),
    'vault_locked',
  );
});

