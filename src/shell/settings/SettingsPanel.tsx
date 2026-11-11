import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react';
import type { CapabilityId } from '#doc-model';
import { useMachineStore, type AiProviderId, type FloatPosition } from '../../data/stores/machine-store.ts';
import {
  aiErrorCode,
  aiKeySaved,
  describeAiError,
  listAiModels,
  saveAiKey,
  testAiConnection,
} from '../../data/tauri/ai.ts';
import type { CapabilityState, CanvasGrid, SettingsPatch, VaultSettings } from '../../kernel/types.ts';
import { isEscTop, useEscLayer } from '../esc-arbiter.ts';
import { moveFloatFrame, type FloatFrame } from '../editor/float-layout.ts';
import styles from './SettingsPanel.module.css';

export interface SettingsPanelProps {
  readonly settings: VaultSettings | null;
  readonly capabilities: readonly CapabilityState[];
  readonly kernelVersion: string;
  readonly onClose: () => void;
  readonly onPatch: (patch: SettingsPatch) => Promise<void>;
  readonly onToggleCapability: (id: CapabilityId, enabled: boolean) => Promise<void>;
}

const GRID_SIZES: readonly CanvasGrid['size'][] = [8, 16, 32];

/** 类目划分与现有区块一一对应，不存在没有内容的空页 */
const SETTINGS_SECTIONS = [
  { id: 'appearance', label: '外观' },
  { id: 'sidebar', label: '侧栏' },
  { id: 'canvas', label: '画布' },
  { id: 'capabilities', label: '能力' },
  { id: 'ai', label: 'AI 助手' },
  { id: 'about', label: '关于' },
] as const;

type SectionId = (typeof SETTINGS_SECTIONS)[number]['id'];

/** 复用机器本地 ui.json 的 floatPositions 记录，键不与文档 id（ULID）冲突 */
const SETTINGS_FLOAT_KEY = 'settings';
const PANEL_WIDTH = 560;
const PANEL_HEIGHT = 600;
const PANEL_MARGIN = 24;
const MOVE_THRESHOLD_PX = 3;

/** 模型可用性结论：正常 / 加载或响应超时 / 连不上 / 连上但模型不可用，都落成一句中文 */
interface ModelProbe {
  readonly tone: 'pending' | 'ok' | 'warn' | 'error';
  readonly text: string;
}

const offlineHint = (baseUrl: string): string =>
  `连不上 ${baseUrl}，请确认 Ollama 已启动（终端执行 ollama serve）后重试。`;

const describeProbeFailure = (
  cause: unknown,
  model: string,
  baseUrl: string,
  waitedSeconds: number,
): ModelProbe => {
  const code = aiErrorCode(cause);
  if (code === 'ai_model_unavailable') {
    return {
      tone: 'error',
      text: `已连上 ${baseUrl}，但模型「${model}」不能用于对话（未下载、名称不对或不支持 chat）。`,
    };
  }
  if (code === 'ai_timeout') {
    // 与"连不上"分开：请求已发出，只是模型在加载或迟迟不产出
    return {
      tone: 'warn',
      text: `已连上 ${baseUrl}，但「${model}」在 ${waitedSeconds} 秒内没有返回内容：模型可能仍在加载，请稍后重试。`,
    };
  }
  if (code === 'ai_network') {
    return { tone: 'error', text: offlineHint(baseUrl) };
  }
  return { tone: 'error', text: `验证失败：${describeAiError(cause)}` };
};

const describeModelListFailure = (cause: unknown, baseUrl: string): string => {
  const code = aiErrorCode(cause);
  if (code === 'ai_timeout') {
    return `已连上 ${baseUrl}，但读取模型列表超时：Ollama 响应较慢，请稍后刷新。`;
  }
  if (code === 'ai_network') return offlineHint(baseUrl);
  if (code === 'ai_invalid_response') {
    return `${baseUrl} 不是可用的 Ollama 服务：api/tags 返回异常。`;
  }
  if (code === 'ai_invalid_endpoint') {
    return `服务地址格式不对：${describeAiError(cause)}`;
  }
  return `读取模型列表失败：${describeAiError(cause)}`;
};

interface MoveDrag {
  readonly start: FloatFrame;
  readonly container: { readonly width: number; readonly height: number };
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  engaged: boolean;
}

/** 设置浮窗：默认居中，拖动后位置写机器本地 ui.json，下次打开按记忆恢复。 */
export const SettingsPanel = ({
  settings,
  capabilities,
  kernelVersion,
  onClose,
  onPatch,
  onToggleCapability,
}: SettingsPanelProps): ReactElement => {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 只切内容，不碰 frame：窗口位置与尺寸在切换类目时保持不变
  const [activeSection, setActiveSection] = useState<SectionId>('appearance');

  const ai = useMachineStore((state) => state.ai);
  const [aiProvider, setAiProvider] = useState<AiProviderId>(ai.provider);
  const [aiBaseUrl, setAiBaseUrl] = useState(ai.baseUrl);
  const [aiModel, setAiModel] = useState(ai.model);
  const [aiKeyInput, setAiKeyInput] = useState('');
  const [aiKeyPresent, setAiKeyPresent] = useState<boolean | null>(null);
  const [aiStatus, setAiStatus] = useState<string | null>(null);
  // 模型列表与可用性验证都是会话内状态：不写 ui.json，也不用 localStorage
  const [models, setModels] = useState<readonly string[] | null>(null);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [modelsNote, setModelsNote] = useState<string | null>(null);
  const [modelProbe, setModelProbe] = useState<ModelProbe | null>(null);
  const aiFormRef = useRef({ provider: aiProvider, baseUrl: aiBaseUrl });
  const modelsTicketRef = useRef(0);
  const probeTicketRef = useRef(0);

  const panelRef = useRef<HTMLElement | null>(null);
  const frameRef = useRef<FloatFrame | null>(null);
  const [frame, setFrame] = useState<FloatFrame | null>(null);
  const dragRef = useRef<MoveDrag | null>(null);
  const movedRef = useRef(false);
  const [moving, setMoving] = useState(false);
  const savedPosition = useMachineStore((state) => state.floatPositions[SETTINGS_FLOAT_KEY]);
  const initializedPositionRef = useRef<FloatPosition | undefined>(undefined);

  useLayoutEffect(() => {
    const container = panelRef.current?.parentElement;
    if (container === null || container === undefined) return;
    if (frameRef.current !== null && (movedRef.current || savedPosition === initializedPositionRef.current)) {
      return;
    }
    const area = { width: container.clientWidth, height: container.clientHeight };
    if (area.width <= 0 || area.height <= 0) return;
    const width = Math.min(PANEL_WIDTH, Math.max(280, area.width - PANEL_MARGIN * 2));
    const height = Math.min(PANEL_HEIGHT, Math.max(320, area.height - PANEL_MARGIN * 2));
    const base: FloatFrame = {
      left: Math.round((area.width - width) / 2),
      top: Math.round((area.height - height) / 2),
      width,
      height,
    };
    initializedPositionRef.current = savedPosition;
    const next =
      savedPosition === undefined
        ? base
        : moveFloatFrame({ ...base, left: savedPosition.left, top: savedPosition.top }, 0, 0, area);
    frameRef.current = next;
    setFrame(next);
  }, [savedPosition]);

  // 机器状态可能在面板打开后异步水合完成：同步到表单；用户输入只改本地 state，不会被回灌覆盖
  useEffect(() => {
    setAiProvider(ai.provider);
    setAiBaseUrl(ai.baseUrl);
    setAiModel(ai.model);
  }, [ai.provider, ai.baseUrl, ai.model]);

  // 回调里读最新表单值，避免把地址输入框的每次按键都变成一次请求
  useEffect(() => {
    aiFormRef.current = { provider: aiProvider, baseUrl: aiBaseUrl };
  }, [aiProvider, aiBaseUrl]);

  const refreshModels = useCallback(async (): Promise<void> => {
    const { provider, baseUrl } = aiFormRef.current;
    if (provider !== 'ollama') return;
    const target = baseUrl.trim();
    const ticket = modelsTicketRef.current + 1;
    modelsTicketRef.current = ticket;
    setModelsBusy(true);
    setModelsNote(null);
    try {
      const names = await listAiModels({ provider, baseUrl: target, model: '' });
      if (modelsTicketRef.current !== ticket) return;
      // 列表刷新成功即作废上一次（含进行中）的验证结论，避免旧绿字被当成当前状态
      probeTicketRef.current += 1;
      setModelProbe(null);
      setModels(names);
      if (names.length === 0) {
        setModelsNote('Ollama 已连上，但本机还没有已下载的模型。先在终端执行 ollama pull <模型名>，再点刷新。');
      }
    } catch (cause) {
      if (modelsTicketRef.current !== ticket) return;
      // 列表都取不到时，上一次的可用性结论已经过期，一并清掉避免两条重复提示
      probeTicketRef.current += 1;
      setModels([]);
      setModelProbe(null);
      setModelsNote(describeModelListFailure(cause, target));
    } finally {
      if (modelsTicketRef.current === ticket) setModelsBusy(false);
    }
  }, []);

  /** 只做一次最小真实请求：能出字才算可用，不把 HTTP 200 当结论 */
  const probeModel = useCallback(async (model: string): Promise<void> => {
    const { provider, baseUrl } = aiFormRef.current;
    const target = baseUrl.trim();
    const ticket = probeTicketRef.current + 1;
    probeTicketRef.current = ticket;
    setModelProbe({
      tone: 'pending',
      text: `正在验证「${model}」能否正常出字（首次加载模型可能需要较久）…`,
    });
    const startedAt = Date.now();
    try {
      const result = await testAiConnection({ provider, baseUrl: target, model });
      if (probeTicketRef.current !== ticket) return;
      setModelProbe({
        tone: 'ok',
        text: `已连上 ${target}，「${model}」可正常出字（耗时 ${result.elapsedMs} ms）。`,
      });
    } catch (cause) {
      if (probeTicketRef.current !== ticket) return;
      const waited = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      setModelProbe(describeProbeFailure(cause, model, target, waited));
    }
  }, []);

  // 进入 AI 区块或切到 Ollama 时自动拉取列表；云端提供方不拉
  useEffect(() => {
    if (activeSection !== 'ai') return;
    if (aiProvider !== 'ollama') {
      setModels(null);
      setModelsNote(null);
      setModelProbe(null);
      return;
    }
    void refreshModels();
  }, [activeSection, aiProvider, refreshModels]);

  // 只问密钥是否存在；换 provider / 地址后重新计算
  useEffect(() => {
    let active = true;
    setAiKeyPresent(null);
    void aiKeySaved(ai)
      .then((saved) => {
        if (active) setAiKeyPresent(saved);
      })
      .catch(() => {
        if (active) setAiKeyPresent(null);
      });
    return () => {
      active = false;
    };
  }, [ai]);

  useEscLayer('settings', true);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      // 统一仲裁：更晚打开的浮层（如命令面板）持有 Esc，本层让位
      if (!isEscTop('settings')) return;
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const beginMove = (event: ReactPointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return;
    if (
      event.target instanceof Element &&
      event.target.closest('button, input, a, label, [data-settings-close]') !== null
    ) {
      return;
    }
    const start = frameRef.current;
    const container = panelRef.current?.parentElement;
    if (start === null || container === null || container === undefined) return;
    dragRef.current = {
      start,
      container: { width: container.clientWidth, height: container.clientHeight },
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      engaged: false,
    };
  };

  const moveMove = (event: ReactPointerEvent<HTMLElement>): void => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.x;
    const deltaY = event.clientY - drag.y;
    if (!drag.engaged) {
      if (Math.abs(deltaX) < MOVE_THRESHOLD_PX && Math.abs(deltaY) < MOVE_THRESHOLD_PX) return;
      drag.engaged = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      setMoving(true);
    }
    event.preventDefault();
    const next = moveFloatFrame(drag.start, deltaX, deltaY, drag.container);
    frameRef.current = next;
    setFrame(next);
  };

  const endMove = (event: ReactPointerEvent<HTMLElement>): void => {
    const drag = dragRef.current;
    if (drag === null) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!drag.engaged) return;
    setMoving(false);
    movedRef.current = true;
    const current = frameRef.current;
    if (current !== null) {
      // 只在松手时记忆位置，拖动期间不写机器状态
      useMachineStore
        .getState()
        .rememberFloatPosition(SETTINGS_FLOAT_KEY, { left: current.left, top: current.top });
    }
  };

  const run = async (key: string, action: () => Promise<void>): Promise<void> => {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(describeAiError(cause));
    } finally {
      setBusy(null);
    }
  };

  const saveAiConfig = async (): Promise<void> => {
    useMachineStore.getState().setAi({ provider: aiProvider, baseUrl: aiBaseUrl, model: aiModel });
    setAiStatus(null);
    if (aiProvider === 'ollama') void refreshModels();
    const secret = aiKeyInput.trim();
    if (secret === '') {
      setAiStatus('配置已保存');
      return;
    }
    const origin = await saveAiKey({ provider: aiProvider, baseUrl: aiBaseUrl, model: aiModel }, secret);
    setAiKeyInput('');
    setAiKeyPresent(true);
    setAiStatus(
      origin === 'keychain'
        ? '已保存：密钥在系统钥匙串'
        : '已保存：钥匙串不可用，密钥只在本次运行的内存中有效',
    );
  };

  /** 选中即启用：写入配置后立刻验证一次，给出「已连上并能出字 / 不可用 / 连不上」 */
  const chooseModel = (name: string): void => {
    if (name === '') return;
    setAiModel(name);
    useMachineStore.getState().setAi({ provider: aiProvider, baseUrl: aiBaseUrl.trim(), model: name });
    void probeModel(name);
  };

  const testAi = async (): Promise<void> => {
    setAiStatus(null);
    await probeModel(aiModel.trim());
  };

  const sidebar = settings?.ui.sidebar ?? 'auto';
  const grid = settings?.ui.canvasGrid ?? { size: 8, snap: true };

  return (
    <div className={styles.scrim} role="presentation" onClick={onClose}>
      <section
        ref={panelRef}
        className={`${styles.panel} ${moving ? styles.moving : ''}`}
        data-ready={frame === null ? 'false' : 'true'}
        style={
          frame === null
            ? undefined
            : { left: frame.left, top: frame.top, width: frame.width, height: frame.height }
        }
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <header
          className={styles.header}
          onPointerDown={beginMove}
          onPointerMove={moveMove}
          onPointerUp={endMove}
          onPointerCancel={endMove}
          onLostPointerCapture={endMove}
        >
          <div>
            <p className={styles.eyebrow}>设置</p>
            <h2 className={styles.title}>偏好与能力</h2>
          </div>
          <button
            type="button"
            className={styles.close}
            data-settings-close
            title="关闭设置（Esc）"
            onClick={onClose}
            aria-label="关闭设置"
          >
            ×
          </button>
        </header>

        <div className={styles.body}>
          <nav className={styles.nav} aria-label="设置类目">
            {SETTINGS_SECTIONS.map((section) => (
              <button
                key={section.id}
                type="button"
                className={`${styles.navItem} ${activeSection === section.id ? styles.navItemActive : ''}`}
                aria-current={activeSection === section.id ? 'page' : undefined}
                onClick={() => {
                  setActiveSection(section.id);
                }}
              >
                {section.label}
              </button>
            ))}
          </nav>

          <div className={styles.content}>
            {settings === null ? <p className={styles.note}>正在读取库设置…</p> : null}
            {error === null ? null : <p className={styles.error}>{error}</p>}

            {activeSection === 'appearance' ? (
              <section className={styles.section}>
                <h3 className={styles.sectionTitle}>外观</h3>
                <p className={styles.note}>
                  当前主题：纯黑。窗口无系统外框，画布为纯黑底 + 细网格。
                </p>
              </section>
            ) : null}

          {activeSection === 'sidebar' ? (
            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>侧栏</h3>
              <p className={styles.note}>自动隐藏：鼠标移到屏幕左缘滑出，移开收起。</p>
              <div className={styles.options}>
                <button
                  type="button"
                  className={`${styles.option} ${sidebar === 'auto' ? styles.optionActive : ''}`}
                  disabled={busy !== null || sidebar === 'auto'}
                  onClick={() => {
                    void run('sidebar', () => onPatch({ ui: { sidebar: 'auto' } }));
                  }}
                >
                  <span className={styles.optionTitle}>自动隐藏</span>
                  <span className={styles.optionHint}>左缘热区滑出</span>
                </button>
                <button
                  type="button"
                  className={`${styles.option} ${sidebar === 'off' ? styles.optionActive : ''}`}
                  disabled={busy !== null || sidebar === 'off'}
                  onClick={() => {
                    void run('sidebar', () => onPatch({ ui: { sidebar: 'off' } }));
                  }}
                >
                  <span className={styles.optionTitle}>彻底关闭</span>
                  <span className={styles.optionHint}>不再显示侧栏</span>
                </button>
              </div>
            </section>
          ) : null}

          {activeSection === 'canvas' ? (
            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>画布</h3>
              <p className={styles.note}>网格尺寸</p>
              <div className={styles.options}>
                {GRID_SIZES.map((size) => (
                  <button
                    key={size}
                    type="button"
                    className={`${styles.option} ${grid.size === size ? styles.optionActive : ''}`}
                    disabled={busy !== null || grid.size === size}
                    onClick={() => {
                      void run('grid', () => onPatch({ ui: { canvasGrid: { size } } }));
                    }}
                  >
                    <span className={styles.optionTitle}>{size} px</span>
                  </button>
                ))}
              </div>
              <label className={styles.switchRow}>
                <input
                  type="checkbox"
                  checked={grid.snap}
                  disabled={busy !== null}
                  onChange={(event) => {
                    const snap = event.currentTarget.checked;
                    void run('snap', () => onPatch({ ui: { canvasGrid: { snap } } }));
                  }}
                />
                <span>拖动时吸附到网格</span>
              </label>
            </section>
          ) : null}

          {activeSection === 'capabilities' ? (
            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>能力</h3>
              {capabilities.length === 0 ? <p className={styles.note}>尚未装配任何能力。</p> : null}
              <ul className={styles.list}>
                {capabilities.map((state) => (
                  <li key={String(state.id)} className={styles.capabilityRow}>
                    <div className={styles.capabilityText}>
                      <span className={styles.capabilityName}>{state.displayName}</span>
                      <span className={styles.capabilityDesc}>
                        {state.description ?? '暂无说明'}
                      </span>
                    </div>
                    <label className={styles.switchRow}>
                      <input
                        type="checkbox"
                        checked={state.enabled}
                        disabled={busy !== null}
                        onChange={(event) => {
                          const enabled = event.currentTarget.checked;
                          void run(String(state.id), () => onToggleCapability(state.id, enabled));
                        }}
                      />
                      <span>{state.active ? '运行中' : state.enabled ? '未激活' : '已停用'}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {activeSection === 'ai' ? (
            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>AI 助手</h3>
              <p className={styles.note}>
                配置外部 OpenAI 兼容接口或本机 Ollama。此步只能保存配置与测试连通，对话面板在后续步骤接入。
              </p>
              <div className={styles.options}>
                <button
                  type="button"
                  className={`${styles.option} ${aiProvider === 'ollama' ? styles.optionActive : ''}`}
                  disabled={busy !== null || aiProvider === 'ollama'}
                  onClick={() => {
                    setAiProvider('ollama');
                  }}
                >
                  <span className={styles.optionTitle}>Ollama</span>
                  <span className={styles.optionHint}>本机模型</span>
                </button>
                <button
                  type="button"
                  className={`${styles.option} ${aiProvider === 'openai-compatible' ? styles.optionActive : ''}`}
                  disabled={busy !== null || aiProvider === 'openai-compatible'}
                  onClick={() => {
                    setAiProvider('openai-compatible');
                  }}
                >
                  <span className={styles.optionTitle}>OpenAI 兼容</span>
                  <span className={styles.optionHint}>外部接口</span>
                </button>
              </div>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>服务地址</span>
                <input
                  className={styles.input}
                  value={aiBaseUrl}
                  spellCheck={false}
                  placeholder="本机 Ollama 默认为 127.0.0.1:11434"
                  onChange={(event) => {
                    setAiBaseUrl(event.currentTarget.value);
                  }}
                />
              </label>
              {aiProvider === 'ollama' ? (
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>模型（本机已下载）</span>
                  <div className={styles.modelRow}>
                    <select
                      className={styles.input}
                      aria-label="本机 Ollama 模型"
                      value={models?.includes(aiModel) === true ? aiModel : ''}
                      disabled={busy !== null || modelsBusy || models === null || models.length === 0}
                      onChange={(event) => {
                        chooseModel(event.currentTarget.value);
                      }}
                    >
                      <option value="">
                        {modelsBusy
                          ? '正在读取本机模型…'
                          : models === null
                            ? '尚未读取模型列表'
                            : models.length === 0
                              ? '没有可用模型'
                              : '请选择要启用的模型'}
                      </option>
                      {(models ?? []).map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className={styles.refresh}
                      disabled={busy !== null || modelsBusy || aiBaseUrl.trim() === ''}
                      title="重新读取本机 Ollama 模型列表"
                      onClick={() => {
                        void refreshModels();
                      }}
                    >
                      {modelsBusy ? '读取中…' : '刷新'}
                    </button>
                  </div>
                  {modelsNote === null ? null : <p className={styles.note}>{modelsNote}</p>}
                  {modelProbe === null ? null : (
                    <p className={modelProbe.tone === 'error' ? styles.error : styles.note}>
                      {modelProbe.text}
                    </p>
                  )}
                </div>
              ) : (
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>模型</span>
                  <input
                    className={styles.input}
                    value={aiModel}
                    spellCheck={false}
                    placeholder="例如 gpt-4o-mini"
                    onChange={(event) => {
                      setAiModel(event.currentTarget.value);
                    }}
                  />
                </label>
              )}
              <label className={styles.field}>
                <span className={styles.fieldLabel}>API Key</span>
                <input
                  className={styles.input}
                  type="password"
                  value={aiKeyInput}
                  autoComplete="new-password"
                  spellCheck={false}
                  placeholder={aiKeyPresent === true ? '已保存，输入新值可覆盖' : '未保存'}
                  onChange={(event) => {
                    setAiKeyInput(event.currentTarget.value);
                  }}
                />
              </label>
              <p className={styles.note}>
                {aiKeyPresent === null
                  ? '密钥状态：读取中…'
                  : aiKeyPresent
                    ? '密钥：已保存（不显示明文）'
                    : '密钥：未保存'}
              </p>
              <div className={styles.options}>
                <button
                  type="button"
                  className={`${styles.option} ${styles.action}`}
                  disabled={busy !== null || aiBaseUrl.trim() === ''}
                  onClick={() => {
                    void run('ai-save', saveAiConfig);
                  }}
                >
                  <span className={styles.optionTitle}>{busy === 'ai-save' ? '保存中…' : '保存配置'}</span>
                </button>
                <button
                  type="button"
                  className={`${styles.option} ${styles.action}`}
                  disabled={busy !== null || aiBaseUrl.trim() === '' || aiModel.trim() === ''}
                  onClick={() => {
                    void run('ai-test', testAi);
                  }}
                >
                  <span className={styles.optionTitle}>{busy === 'ai-test' ? '测试中…' : '连接测试'}</span>
                </button>
              </div>
              {aiStatus === null ? null : <p className={styles.note}>{aiStatus}</p>}
            </section>
          ) : null}

          {activeSection === 'about' ? (
            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>关于</h3>
              <dl className={styles.about}>
                <div>
                  <dt>内核版本</dt>
                  <dd>{kernelVersion}</dd>
                </div>
                <div>
                  <dt>库 ID</dt>
                  <dd>{settings?.vault.id ?? '—'}</dd>
                </div>
                <div>
                  <dt>主题</dt>
                  <dd>ember-black</dd>
                </div>
              </dl>
            </section>
          ) : null}
          </div>
        </div>
      </section>
    </div>
  );
};
