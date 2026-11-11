import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateReadingMinutes } from '../../src/shell/editor/reading-time.ts';

void test('空正文、纯空白、纯标点返回 null', () => {
  assert.equal(estimateReadingMinutes(''), null);
  assert.equal(estimateReadingMinutes('   \n\t  '), null);
  assert.equal(estimateReadingMinutes('，。！？ —— ……'), null);
});

void test('有内容但不足一分钟时按最少 1 分钟计', () => {
  assert.equal(estimateReadingMinutes('你'), 1);
  assert.equal(estimateReadingMinutes('hello'), 1);
  assert.equal(estimateReadingMinutes('中文 test'), 1);
});

void test('CJK 按 300 字/分钟并向上取整', () => {
  assert.equal(estimateReadingMinutes('汉'.repeat(300)), 1);
  assert.equal(estimateReadingMinutes('汉'.repeat(301)), 2);
});

void test('非 CJK 按空白分词、200 词/分钟并向上取整', () => {
  assert.equal(estimateReadingMinutes('word '.repeat(200).trim()), 1);
  assert.equal(estimateReadingMinutes('word '.repeat(201).trim()), 2);
});

void test('中英混排分别累计后取整', () => {
  assert.equal(estimateReadingMinutes(`${'汉'.repeat(300)} ${'word '.repeat(200).trim()}`), 2);
  // 1 + 201/200 = 2.005 → 3
  assert.equal(estimateReadingMinutes(`${'汉'.repeat(300)} ${'word '.repeat(201).trim()}`), 3);
});

void test('中文标点不单独计词', () => {
  assert.equal(estimateReadingMinutes('你好，世界。'), 1);
  assert.equal(estimateReadingMinutes('汉'.repeat(300) + '，。！？'), 1);
});
