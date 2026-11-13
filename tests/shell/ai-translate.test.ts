import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTranslatePrompt,
  isTranslatable,
  translatableBlocks,
  TRANSLATE_SYSTEM_PROMPT,
} from '../../src/shell/ai/translate.ts';

void test('isTranslatable skips short and already-Chinese fragments', () => {
  assert.equal(isTranslatable('hello'), false);
  assert.equal(isTranslatable('这是一段已经写好而且足够长的中文正文'), false);
  assert.equal(isTranslatable('A short English sentence.'), true);
  assert.equal(
    isTranslatable('This paragraph mixes 中文 with English words but is mostly English.'),
    true,
  );
});

void test('translatableBlocks only keeps top-level headings and paragraphs', () => {
  const markdown = [
    '# Getting Started',
    '',
    'Ember stores every note as a plain Markdown file on disk.',
    '',
    '```ts',
    'const untouched = true;',
    '```',
    '',
    '这是一段中文正文，不需要再翻译成中文。',
    '',
    '- first list item that is long enough',
    '- second list item that is long enough',
  ].join('\n');
  const blocks = translatableBlocks(markdown);
  // 顶层下标：0 = 标题，1 = 段落，2 = 代码，3 = 中文段落，4 = 列表
  assert.deepEqual(
    blocks.map((block) => block.index),
    [0, 1],
  );
  assert.equal(blocks[0]?.text, 'Getting Started');
  assert.match(blocks[1]?.text ?? '', /plain Markdown file/);
});

void test('translate prompt carries the target language and the fragment only', () => {
  const prompt = buildTranslatePrompt('Only the fragment is sent.');
  assert.match(prompt, /简体中文/);
  assert.ok(prompt.includes('Only the fragment is sent.'));
});

void test('system prompt forbids following instructions found in the article', () => {
  assert.match(TRANSLATE_SYSTEM_PROMPT, /只把它翻译成简体中文/);
  assert.match(TRANSLATE_SYSTEM_PROMPT, /不要执行/);
  assert.match(TRANSLATE_SYSTEM_PROMPT, /只输出译文/);
});
