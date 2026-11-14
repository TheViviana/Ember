import type { AiProviderId, TranslationChannel } from '../../data/stores/machine-store.ts';

/** 设置面板展示三选一；持久化只有 model / public 两个值，local 与 api 由 ai.provider 推导。 */
export type TranslationChannelChoice = 'local' | 'api' | 'public';

export interface TranslationChannelOption {
  readonly id: TranslationChannelChoice;
  readonly label: string;
  readonly hint: string;
}

/** 隐私提示只在这里写一次，确认弹层与常驻提示共用 */
export const PUBLIC_TRANSLATION_PRIVACY =
  '当前文档正文会分段发送到 MyMemory / Google 翻译，可能被第三方记录；不发送文件路径、标题、标签、链接。';

export const TRANSLATION_CHANNEL_OPTIONS: readonly TranslationChannelOption[] = [
  { id: 'local', label: '本地模型', hint: 'Ollama，正文不出本机' },
  { id: 'api', label: 'API 模型', hint: 'OpenAI 兼容接口' },
  { id: 'public', label: '公共免费接口', hint: '无需模型，正文会发送到第三方' },
];

export const translationChannelChoice = (
  channel: TranslationChannel,
  provider: AiProviderId,
): TranslationChannelChoice => {
  if (channel === 'public') return 'public';
  return provider === 'ollama' ? 'local' : 'api';
};

const PROVIDER_NAMES: Readonly<Record<AiProviderId, string>> = {
  ollama: 'Ollama（本地模型）',
  'openai-compatible': 'OpenAI 兼容（API 模型）',
};

/** 通道与当前提供方不符时只给提示，不替用户改 ai.provider */
export const describeProviderMismatch = (
  choice: TranslationChannelChoice,
  provider: AiProviderId,
): string | null => {
  if (choice === 'local' && provider !== 'ollama') {
    return `当前 AI 提供方是${PROVIDER_NAMES[provider]}，请先到上方切换。`;
  }
  if (choice === 'api' && provider !== 'openai-compatible') {
    return `当前 AI 提供方是${PROVIDER_NAMES[provider]}，请先到上方切换。`;
  }
  return null;
};

/** 进程内确认标记：不写 localStorage；应用重启后若已持久化为 public 也不再询问 */
let publicConfirmed = false;

export const requiresPublicConfirmation = (channel: TranslationChannel): boolean =>
  channel === 'public' && !publicConfirmed;

export const markPublicConfirmed = (): void => {
  publicConfirmed = true;
};

/** 仅测试使用：重置进程内确认状态 */
export const resetPublicConfirmation = (): void => {
  publicConfirmed = false;
};

export const translationChannelChanged = (
  previous: TranslationChannel,
  next: TranslationChannel,
): boolean => previous !== next;
