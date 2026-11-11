import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeFrontmatter,
  toSerializable,
} from '../../packages/doc-model/src/frontmatter.ts';
import { createUlid } from '../../packages/doc-model/src/ulid.ts';

void test('未知键进入 extra 并原样往返', () => {
  const custom = { nested: [1, 2, { deep: true }] };
  const { frontmatter, issues } = normalizeFrontmatter({
    id: createUlid(),
    title: '方案',
    custom,
  });
  assert.equal(issues.length, 0);
  assert.deepEqual(frontmatter.extra, { custom });
  assert.deepEqual(toSerializable(frontmatter)['custom'], custom);
});

void test('非法 id 产生诊断且不进入模型', () => {
  const { frontmatter, issues } = normalizeFrontmatter({ id: 'not-ulid' });
  assert.equal(frontmatter.id, null);
  assert.equal(issues[0]?.code, 'id_invalid');
});

void test('标签去 # 前缀并归一化', () => {
  const { frontmatter } = normalizeFrontmatter({ tags: ['#研发', ' 架构 ', ''] });
  assert.deepEqual(frontmatter.tags, ['研发', '架构']);
});

void test('tags 非字符串数组整键降级', () => {
  const { frontmatter, issues } = normalizeFrontmatter({ tags: ['ok', 3] });
  assert.deepEqual(frontmatter.tags, []);
  assert.equal(issues.some((issue) => issue.code === 'tags_invalid'), true);
});

void test('非法保留键的原始值进入 extra 原样保留（不静默丢弃）', () => {
  const { frontmatter, issues } = normalizeFrontmatter({
    id: createUlid(),
    tags: '项目笔记',
    created: '2024/01/02',
    title: 123,
  });
  // 归一化字段不参与语义
  assert.deepEqual(frontmatter.tags, []);
  assert.equal(frontmatter.created, null);
  assert.equal(frontmatter.title, null);
  assert.equal(issues.length, 3);
  // 原始值逐字保留，kernel 重写整份 frontmatter 时不会从磁盘上消失
  assert.deepEqual(frontmatter.extra, { tags: '项目笔记', created: '2024/01/02', title: 123 });
  const serializable = toSerializable(frontmatter);
  assert.equal(serializable['tags'], '项目笔记');
  assert.equal(serializable['created'], '2024/01/02');
  assert.equal(serializable['title'], 123);
});

void test('非法值的归一化往返稳定', () => {
  const first = normalizeFrontmatter({ tags: '项目笔记', created: '2024/01/02' });
  const second = normalizeFrontmatter(toSerializable(first.frontmatter));
  assert.deepEqual(second.issues.map((issue) => issue.key), ['tags', 'created']);
  assert.deepEqual(second.frontmatter.extra, first.frontmatter.extra);
  assert.deepEqual(second.frontmatter.tags, []);
  assert.equal(second.frontmatter.created, null);
});

void test('ember 非对象整键降级并保留原值', () => {
  const { frontmatter, issues } = normalizeFrontmatter({ ember: [1, 2] });
  assert.deepEqual(frontmatter.ember, {});
  assert.equal(issues[0]?.code, 'ember_invalid');
  assert.deepEqual(frontmatter.extra, { ember: [1, 2] });
});

void test('时间戳必须是带时区的 ISO-8601', () => {
  const good = normalizeFrontmatter({ created: '2026-11-11T10:00:00Z' });
  assert.equal(good.issues.length, 0);
  assert.equal(good.frontmatter.created, '2026-11-11T10:00:00Z');

  const bad = normalizeFrontmatter({ updated: '2026-11-11 10:00' });
  assert.equal(bad.frontmatter.updated, null);
  assert.equal(bad.issues[0]?.code, 'updated_invalid');
});

void test('序列化键顺序固定', () => {
  const { frontmatter } = normalizeFrontmatter({
    updated: '2026-11-11T10:00:00Z',
    zeta: 1,
    title: 'T',
    id: createUlid(),
    alpha: 2,
    created: '2026-11-11T09:00:00Z',
    tags: ['t'],
    aliases: ['a'],
  });
  assert.deepEqual(Object.keys(toSerializable(frontmatter)), [
    'id',
    'title',
    'tags',
    'aliases',
    'created',
    'updated',
    'alpha',
    'zeta',
  ]);
});
