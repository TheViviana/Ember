import { Channel, invoke } from '@tauri-apps/api/core';
import { createUlid } from '#doc-model';
import type { AiSettings } from '../stores/machine-store.ts';

/**
 * AI 设置的数据层客户端：配置本身存机器本地 ui.json，
 * 这里的命令只负责密钥落点（钥匙串 / 内存降级）与连接测试。
 */

const payload = (settings: AiSettings): Record<string, string> => ({
  provider: settings.provider,
  baseUrl: settings.baseUrl,
  model: settings.model,
});

export type AiKeyOrigin = 'keychain' | 'memory';

/** 保存密钥；返回实际落点，memory 表示钥匙串不可用、仅本次运行有效。 */
export const saveAiKey = async (settings: AiSettings, key: string): Promise<AiKeyOrigin> => {
  const origin = await invoke<string>('ai_key_save', { config: payload(settings), key });
  return origin === 'memory' ? 'memory' : 'keychain';
};

/** 只问是否存在，任何情况下都不回传明文。 */
export const aiKeySaved = async (settings: AiSettings): Promise<boolean> =>
  invoke<boolean>('ai_key_status', { config: payload(settings) });

export const deleteAiKey = async (settings: AiSettings): Promise<void> => {
  await invoke('ai_key_delete', { config: payload(settings) });
};

export interface AiTestResult {
  readonly elapsedMs: number;
}

/** 连接测试：Rust 侧发一条最小请求并读完流，超时上限比正式对话短。 */
export const testAiConnection = async (settings: AiSettings): Promise<AiTestResult> =>
  invoke<AiTestResult>('ai_test_connection', { config: payload(settings) });

/** 本机 Ollama 已下载的模型名：Rust 侧只请求 provider 基址上的固定端点 api/tags。 */
export const listAiModels = async (settings: AiSettings): Promise<readonly string[]> => {
  const names = await invoke<readonly string[]>('ai_list_models', {
    config: payload(settings),
  });
  return names;
};

/** IPC 错误码：用于把「连不上 / 连上但模型不可用」分成不同提示。 */
export const aiErrorCode = (cause: unknown): string | null => {
  if (typeof cause === 'object' && cause !== null) {
    const code = (cause as Readonly<Record<string, unknown>>)['code'];
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return null;
};

/** IPC 拒绝时可能是 `{ code, message }` 而不是 Error；统一取安全文案。 */
export const describeAiError = (cause: unknown): string => {
  if (typeof cause === 'object' && cause !== null) {
    const message = (cause as Readonly<Record<string, unknown>>)['message'];
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return cause instanceof Error ? cause.message : String(cause);
};

export interface ChatTurnInput {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

interface AiStreamEvent {
  readonly type: 'delta' | 'done' | 'error';
  readonly text?: string;
  readonly code?: string;
  readonly message?: string;
}

export interface ChatHandlers {
  onDelta(text: string): void;
  onDone(): void;
  onError(message: string): void;
}

export interface ChatSession {
  readonly requestId: string;
  readonly done: Promise<void>;
  cancel(): Promise<void>;
}

/** IPC 拒绝 → 回调路由：用户主动取消（ai_chat_cancel）按正常结束收尾——
 * 保留半截内容、不弹错误条；其余拒绝走 onError。 */
export const routeChatRejection = (cause: unknown, handlers: ChatHandlers): void => {
  if (aiErrorCode(cause) === 'ai_cancelled') {
    handlers.onDone();
    return;
  }
  handlers.onError(describeAiError(cause));
};

/**
 * 流式对话：Rust 侧逐段推送到 Channel。
 * 只有用户点发送才会调用，未配置 provider 时命令会在建连接前失败（零外联）。
 */
export const startChat = (
  settings: AiSettings,
  messages: readonly ChatTurnInput[],
  handlers: ChatHandlers,
): ChatSession => {
  const requestId = createUlid();
  const channel = new Channel<AiStreamEvent>();
  let settled = false;
  const settle = (action: () => void): void => {
    if (settled) return;
    settled = true;
    action();
  };
  channel.onmessage = (event) => {
    if (event.type === 'delta') {
      if (event.text !== undefined) handlers.onDelta(event.text);
      return;
    }
    if (event.type === 'done') {
      settle(() => {
        handlers.onDone();
      });
      return;
    }
    settle(() => {
      handlers.onError(event.message ?? 'AI 请求失败');
    });
  };
  const done = invoke('ai_chat_stream', {
    config: payload(settings),
    messages,
    requestId,
    onEvent: channel,
  })
    .then(() => {
      settle(() => {
        handlers.onDone();
      });
    })
    .catch((cause: unknown) => {
      settle(() => {
        routeChatRejection(cause, handlers);
      });
    });
  return {
    requestId,
    done,
    cancel: async () => {
      await invoke('ai_chat_cancel', { requestId });
    },
  };
};

export interface PublicTranslation {
  /** 译文；失败分块保留原文后拼接在对应位置 */
  readonly text: string;
  /** 该段内失败并保留原文的分块数 */
  readonly failed: number;
}

/**
 * 公共免费接口翻译单段：正文只在 Rust 侧发往固定端点，前端不直接发外网。
 * requestId 与对话共用取消表，切通道时可立即中止分块之间的请求。
 */
export const translatePublicBlock = (
  text: string,
  requestId: string,
): Promise<PublicTranslation> =>
  invoke<PublicTranslation>('ai_translate_public', { text, requestId });

export const cancelPublicTranslate = async (requestId: string): Promise<void> => {
  await invoke('ai_chat_cancel', { requestId });
};

