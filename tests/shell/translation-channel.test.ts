import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeProviderMismatch,
  markPublicConfirmed,
  requiresPublicConfirmation,
  resetPublicConfirmation,
  translationChannelChanged,
  translationChannelChoice,
} from '../../src/shell/ai/translation-channel.ts';

void test('三选一由通道与当前提供方共同推导', () => {
  assert.equal(translationChannelChoice('model', 'ollama'), 'local');
  assert.equal(translationChannelChoice('model', 'openai-compatible'), 'api');
  assert.equal(translationChannelChoice('public', 'ollama'), 'public');
  assert.equal(translationChannelChoice('public', 'openai-compatible'), 'public');
});

void test('通道与提供方不符只提示，不改提供方', () => {
  assert.equal(describeProviderMismatch('local', 'ollama'), null);
  assert.equal(describeProviderMismatch('api', 'openai-compatible'), null);
  assert.equal(describeProviderMismatch('public', 'ollama'), null);
  assert.match(
    describeProviderMismatch('local', 'openai-compatible') ?? '',
    /当前 AI 提供方是OpenAI 兼容（API 模型），请先到上方切换/,
  );
  assert.match(
    describeProviderMismatch('api', 'ollama') ?? '',
    /当前 AI 提供方是Ollama（本地模型），请先到上方切换/,
  );
});

void test('公共接口确认弹层只在首次切换时出现', () => {
  resetPublicConfirmation();
  assert.equal(requiresPublicConfirmation('model'), false);
  assert.equal(requiresPublicConfirmation('public'), true);
  markPublicConfirmed();
  assert.equal(requiresPublicConfirmation('public'), false);
  resetPublicConfirmation();
});

void test('只有通道值变化才需要中止进行中的翻译', () => {
  assert.equal(translationChannelChanged('model', 'model'), false);
  assert.equal(translationChannelChanged('public', 'public'), false);
  assert.equal(translationChannelChanged('model', 'public'), true);
  assert.equal(translationChannelChanged('public', 'model'), true);
});
