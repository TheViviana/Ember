import { create } from 'zustand';
import type { MachineUiPort } from '../../kernel/ports.ts';

/**
 * 机器级状态（浮窗尺寸与位置）。
 * 落盘位置是 `~/Library/Application Support/Ember/machines/<machineId>/ui.json`，
 * 由 Rust 命令 `machine_ui_read` / `machine_ui_write` 读写；库内 `.workbench/` 不承载机器状态。
 */

export interface FloatSize {
  readonly width: number;
  readonly height: number;
}

/** 浮窗左上角在画布容器内的位置；与尺寸一起按 docId 记忆 */
export interface FloatPosition {
  readonly left: number;
  readonly top: number;
}

/** 今日回顾当天抽中的文档 id；day 为本地日期 YYYY-MM-DD */
export interface RecallCache {
  readonly day: string;
  readonly ids: readonly string[];
}

export type PomodoroPhase = 'focus' | 'break';
/** 白噪音类型：off = 关闭；音频全部由 WebAudio 本地合成，不携带音频资产 */
export type PomodoroNoise = 'off' | 'white' | 'pink';

/** 番茄钟设置与当前段一起存机器本地：endTs 为闭式计时终点，null = 未运行 */
export interface PomodoroState {
  readonly focusMinutes: number;
  readonly breakMinutes: number;
  /** 段索引：从 1 开始，每次进入下一段（专注↔休息）加 1 */
  readonly segment: number;
  readonly phase: PomodoroPhase;
  readonly endTs: number | null;
  /** 专注段背景白噪音类型；休息段不播放 */
  readonly noise: PomodoroNoise;
  /** 白噪音音量 0–1 */
  readonly noiseVolume: number;
}

export const DEFAULT_POMODORO: PomodoroState = {
  focusMinutes: 25,
  breakMinutes: 5,
  segment: 1,
  phase: 'focus',
  endTs: null,
  noise: 'off',
  noiseVolume: 0.3,
};

export const POMODORO_NOISE_TYPES: readonly PomodoroNoise[] = ['off', 'white', 'pink'];

export const POMODORO_FOCUS_MIN = 1;
export const POMODORO_FOCUS_MAX = 180;
export const POMODORO_BREAK_MIN = 1;
export const POMODORO_BREAK_MAX = 60;

/** AI 提供方；取值与 Rust 侧 ProviderKind 的序列化名一致 */
export type AiProviderId = 'ollama' | 'openai-compatible';

/**
 * AI 配置：只存定位与模型，API Key 走系统钥匙串，绝不写进 ui.json。
 * temperature / maxOutputTokens 使用 Rust 侧默认值，不在此持久化。
 */
export interface AiSettings {
  readonly provider: AiProviderId;
  readonly baseUrl: string;
  readonly model: string;
}

export const DEFAULT_AI: AiSettings = {
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: '',
};

/**
 * AI 助手浮窗：不占文章浮窗槽位。
 * 位置是左上角相对主内容区（顶栏与状态栏之间）的像素坐标，尺寸与位置一起按机器记忆。
 */
export interface AiPanelState {
  readonly open: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const AI_PANEL_MIN_WIDTH = 320;
export const AI_PANEL_MAX_WIDTH = 720;
export const AI_PANEL_MIN_HEIGHT = 320;
/** 面板与可用区域边缘的间距，与画布右下 HUD 的 --space-lg 保持一致 */
export const AI_PANEL_MARGIN = 16;
/**
 * 底部让位：ToolRail 底部 12 + 轨道高 32 + 间隙 8 = 52。
 * HUD 顶部约为 16 + 22 = 38，因此 52 同时避开 HUD 与左下角横排。
 */
export const AI_PANEL_BOTTOM_RESERVE = 52;

/** 主内容区（顶栏之下、状态栏之上）的可用尺寸 */
export interface PanelArea {
  readonly width: number;
  readonly height: number;
}

export interface AiPanelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 未测量到窗口时的参考区域：1280×820 窗口减去顶栏 52 与状态栏 28 */
export const DEFAULT_PANEL_AREA: PanelArea = { width: 1280, height: 740 };

/**
 * 把矩形夹进可用区域：尺寸先夹到合法区间，位置再夹到四边之内。
 * 默认位置、拖动、缩放、窗口变小后的重排共用这一处，避免三套公式各算各的。
 */
export const clampAiPanelRect = (rect: AiPanelRect, area: PanelArea): AiPanelRect => {
  const areaWidth = Math.max(1, Math.round(area.width));
  const areaHeight = Math.max(1, Math.round(area.height));
  const availableWidth = Math.max(1, areaWidth - AI_PANEL_MARGIN * 2);
  const availableHeight = Math.max(1, areaHeight - AI_PANEL_MARGIN - AI_PANEL_BOTTOM_RESERVE);
  // 窗口比最小尺寸还小时允许继续收缩，优先保证不压住底部 HUD / 横排
  const minWidth = Math.min(AI_PANEL_MIN_WIDTH, availableWidth);
  const maxWidth = Math.max(minWidth, Math.min(AI_PANEL_MAX_WIDTH, availableWidth));
  const width = Math.min(maxWidth, Math.max(minWidth, Math.round(rect.width)));
  const minHeight = Math.min(AI_PANEL_MIN_HEIGHT, availableHeight);
  const height = Math.min(availableHeight, Math.max(minHeight, Math.round(rect.height)));
  const maxX = Math.max(AI_PANEL_MARGIN, areaWidth - width - AI_PANEL_MARGIN);
  const x = Math.min(maxX, Math.max(AI_PANEL_MARGIN, Math.round(rect.x)));
  const maxY = Math.max(AI_PANEL_MARGIN, areaHeight - height - AI_PANEL_BOTTOM_RESERVE);
  const y = Math.min(maxY, Math.max(AI_PANEL_MARGIN, Math.round(rect.y)));
  return { x, y, width, height };
};

export const AI_PANEL_DEFAULT_WIDTH = 360;
export const AI_PANEL_DEFAULT_HEIGHT = 480;

/** 默认锚点：右下角，位于 HUD 与左下角横排上方 */
export const defaultAiPanelRect = (area: PanelArea = DEFAULT_PANEL_AREA): AiPanelRect =>
  clampAiPanelRect(
    {
      x: area.width - AI_PANEL_DEFAULT_WIDTH - AI_PANEL_MARGIN,
      y: area.height - AI_PANEL_DEFAULT_HEIGHT - AI_PANEL_BOTTOM_RESERVE,
      width: AI_PANEL_DEFAULT_WIDTH,
      height: AI_PANEL_DEFAULT_HEIGHT,
    },
    area,
  );

export const DEFAULT_AI_PANEL: AiPanelState = { open: false, ...defaultAiPanelRect() };

/**
 * 左侧资源管理器宽度：按机器记忆（不同屏幕宽度下顺手宽度不同，不该进库）。
 * 默认值与 tokens.css 的 --sidebar-width 保持一致；最小 200 保证文件路径还能读，
 * 最大 420 保证窗口 960 时画布仍有 500 以上。
 */
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 420;
export const DEFAULT_SIDEBAR_WIDTH = 250;

/**
 * schemaVersion 保持 1：recall / pomodoro 是新增的可选字段，
 * 老文件缺字段时按默认值补齐即可；升到 2 会让既有 v1 文件整体作废（浮窗尺寸/位置丢失）。
 */
const FLOAT_SIZE_SCHEMA_VERSION = 1;

export interface MachineUiDocument {
  readonly schemaVersion: 1;
  readonly floatSizes: Readonly<Record<string, FloatSize>>;
  readonly floatPositions: Readonly<Record<string, FloatPosition>>;
  readonly recall: RecallCache | null;
  readonly pomodoro: PomodoroState;
  readonly ai: AiSettings;
  readonly panels: { readonly ai: AiPanelState };
  /** 左侧资源管理器宽度（机器本地） */
  readonly sidebarWidth: number;
}

export interface MachineState {
  /** docId → 浮窗尺寸；同一篇文章跨重启恢复，不同文章互不影响 */
  readonly floatSizes: Readonly<Record<string, FloatSize>>;
  /** docId → 浮窗位置；拖动松手时写入 */
  readonly floatPositions: Readonly<Record<string, FloatPosition>>;
  /** 当天回顾的三篇；null = 还没抽过 */
  readonly recall: RecallCache | null;
  readonly pomodoro: PomodoroState;
  /** AI 提供方配置；密钥不在此 */
  readonly ai: AiSettings;
  readonly panels: { readonly ai: AiPanelState };
  /** 左侧资源管理器宽度；拖拽松手或双击复位时写入 */
  readonly sidebarWidth: number;
  rememberFloatSize(docId: string, size: FloatSize): void;
  rememberFloatPosition(docId: string, position: FloatPosition): void;
  rememberRecall(recall: RecallCache): void;
  setPomodoro(next: PomodoroState): void;
  setAi(patch: Partial<AiSettings>): void;
  setSidebarWidth(width: number): void;
  setAiPanel(patch: Partial<AiPanelState>): void;
}

const clampInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
};

export const parseRecall = (value: unknown): RecallCache | null => {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const day = record.day;
  const ids = record.ids;
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  if (!Array.isArray(ids)) return null;
  const unique: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0 || unique.includes(id)) continue;
    unique.push(id);
  }
  return { day, ids: unique };
};

export const parsePomodoro = (value: unknown): PomodoroState => {
  if (typeof value !== 'object' || value === null) return DEFAULT_POMODORO;
  const record = value as Readonly<Record<string, unknown>>;
  const phase: PomodoroPhase = record.phase === 'break' ? 'break' : 'focus';
  const segment = clampInt(record.segment, DEFAULT_POMODORO.segment, 1, Number.MAX_SAFE_INTEGER);
  const endTsRaw = record.endTs;
  const endTs =
    typeof endTsRaw === 'number' && Number.isFinite(endTsRaw) && endTsRaw > 0 ? Math.round(endTsRaw) : null;
  return {
    focusMinutes: clampInt(
      record.focusMinutes,
      DEFAULT_POMODORO.focusMinutes,
      POMODORO_FOCUS_MIN,
      POMODORO_FOCUS_MAX,
    ),
    breakMinutes: clampInt(
      record.breakMinutes,
      DEFAULT_POMODORO.breakMinutes,
      POMODORO_BREAK_MIN,
      POMODORO_BREAK_MAX,
    ),
    segment,
    phase,
    endTs,
    noise: record.noise === 'white' || record.noise === 'pink' ? record.noise : 'off',
    noiseVolume:
      typeof record.noiseVolume === 'number' && Number.isFinite(record.noiseVolume)
        ? Math.round(Math.min(1, Math.max(0, record.noiseVolume)) * 100) / 100
        : DEFAULT_POMODORO.noiseVolume,
  };
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null;

/** parse 阶段只拦明显离谱的坐标，真正的窗口边界在渲染时按可用区域夹取 */
const MIN_COORD = -Number.MAX_SAFE_INTEGER;
const MAX_COORD = Number.MAX_SAFE_INTEGER;

export const parseAi = (value: unknown): AiSettings => {
  if (!isRecord(value)) return DEFAULT_AI;
  const provider: AiProviderId = value.provider === 'openai-compatible' ? 'openai-compatible' : 'ollama';
  const baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl.trim() : DEFAULT_AI.baseUrl;
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  return { provider, baseUrl, model };
};

/**
 * 缺 x / y / width / height 时按默认右下锚点补齐，再整体夹进当前可用区域。
 * 老文件只有 { open, width } 也能正常读入。
 */
export const parseAiPanel = (value: unknown, area: PanelArea = DEFAULT_PANEL_AREA): AiPanelState => {
  if (!isRecord(value)) return { open: false, ...defaultAiPanelRect(area) };
  // 缺位置时按该尺寸的右下角推默认值，老文件只存宽度也能贴右边
  const width = clampInt(value.width, AI_PANEL_DEFAULT_WIDTH, 1, Number.MAX_SAFE_INTEGER);
  const height = clampInt(value.height, AI_PANEL_DEFAULT_HEIGHT, 1, Number.MAX_SAFE_INTEGER);
  return {
    open: value.open === true,
    ...clampAiPanelRect(
      {
        x: clampInt(value.x, area.width - width - AI_PANEL_MARGIN, MIN_COORD, MAX_COORD),
        y: clampInt(value.y, area.height - height - AI_PANEL_BOTTOM_RESERVE, MIN_COORD, MAX_COORD),
        width,
        height,
      },
      area,
    ),
  };
};

/**
 * 未识别字段原样保留：另一路写入的键（以及未来版本的新键）不因本模块整体重写而丢失。
 * 只在读取成功时刷新；读取失败保持原值，避免把磁盘上的未知字段覆盖成空。
 */
let preservedKeys: Readonly<Record<string, unknown>> = {};

let port: MachineUiPort | null = null;
/** true = 磁盘内容已经读进内存，此后的写入才代表「较新的用户意图」 */
let hydrated = false;
/** 水合进行中的共享 Promise：并发调用只读一次盘 */
let hydrating: Promise<void> | null = null;
/** 磁盘是未来版本的 ui.json：本会话禁止回写，避免旧版本应用把新字段抹掉 */
let futureDocument = false;
let writeChain: Promise<void> = Promise.resolve();
/** 最近一次写盘失败；flush 时上报一次后清空，写链本身保持 resolved 以便继续排后续写入 */
let lastWriteFailure: Error | null = null;

/** 由 data 层装配处注入；未注入时尺寸仅保存在内存，不影响使用。 */
export const attachMachineUiPort = (next: MachineUiPort): void => {
  port = next;
};

export const parseMachineUi = (
  text: string,
  area: PanelArea = DEFAULT_PANEL_AREA,
): MachineUiDocument | null => {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Readonly<Record<string, unknown>>;
    if (record.schemaVersion !== FLOAT_SIZE_SCHEMA_VERSION) return null;
    const rawSizes = record.floatSizes;
    const rawPositions = record.floatPositions;
    const floatSizes: Record<string, FloatSize> = {};
    if (typeof rawSizes === 'object' && rawSizes !== null) {
      for (const [key, value] of Object.entries(rawSizes)) {
        if (typeof value !== 'object' || value === null) continue;
        const size = value as Readonly<Record<string, unknown>>;
        const width = size.width;
        const height = size.height;
        if (typeof width !== 'number' || typeof height !== 'number') continue;
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) continue;
        floatSizes[key] = { width: Math.round(width), height: Math.round(height) };
      }
    }
    const floatPositions: Record<string, FloatPosition> = {};
    if (typeof rawPositions === 'object' && rawPositions !== null) {
      for (const [key, value] of Object.entries(rawPositions)) {
        if (typeof value !== 'object' || value === null) continue;
        const position = value as Readonly<Record<string, unknown>>;
        const left = position.left;
        const top = position.top;
        if (typeof left !== 'number' || typeof top !== 'number') continue;
        if (!Number.isFinite(left) || !Number.isFinite(top)) continue;
        floatPositions[key] = { left: Math.round(left), top: Math.round(top) };
      }
    }
    const panels = isRecord(record.panels) ? record.panels : {};
    return {
      schemaVersion: FLOAT_SIZE_SCHEMA_VERSION,
      floatSizes,
      floatPositions,
      recall: parseRecall(record.recall),
      pomodoro: parsePomodoro(record.pomodoro),
      ai: parseAi(record.ai),
      panels: { ai: parseAiPanel(panels.ai, area) },
      sidebarWidth: clampInt(
        record.sidebarWidth,
        DEFAULT_SIDEBAR_WIDTH,
        SIDEBAR_MIN_WIDTH,
        SIDEBAR_MAX_WIDTH,
      ),
    };
  } catch {
    return null;
  }
};

export const serializeMachineUi = (
  sizes: Readonly<Record<string, FloatSize>>,
  positions: Readonly<Record<string, FloatPosition>> = {},
  recall: RecallCache | null = null,
  pomodoro: PomodoroState = DEFAULT_POMODORO,
  ai: AiSettings = DEFAULT_AI,
  aiPanel: AiPanelState = DEFAULT_AI_PANEL,
  sidebarWidth: number = DEFAULT_SIDEBAR_WIDTH,
): string => {
  // 已知字段覆盖写，未知字段（含 panels 下的其他面板）原样带回，避免两边同时写时互相抹掉
  const knownPanels = isRecord(preservedKeys.panels) ? preservedKeys.panels : {};
  const knownAi = isRecord(preservedKeys.ai) ? preservedKeys.ai : {};
  return JSON.stringify(
    {
      ...preservedKeys,
      schemaVersion: FLOAT_SIZE_SCHEMA_VERSION,
      floatSizes: sizes,
      floatPositions: positions,
      recall,
      pomodoro,
      ai: { ...knownAi, provider: ai.provider, baseUrl: ai.baseUrl, model: ai.model },
      panels: {
        ...knownPanels,
        ai: {
          open: aiPanel.open,
          x: aiPanel.x,
          y: aiPanel.y,
          width: aiPanel.width,
          height: aiPanel.height,
        },
      },
      sidebarWidth: clampInt(sidebarWidth, DEFAULT_SIDEBAR_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH),
    },
    null,
    2,
  );
};

/** 读取原文里的顶层键（含未知键）；解析失败返回空表，保留上一份已知字段 */
const readPreservedKeys = (text: string): Readonly<Record<string, unknown>> => {
  try {
    const raw: unknown = JSON.parse(text);
    return isRecord(raw) ? raw : {};
  } catch {
    return {};
  }
};

const queueWrite = (): void => {
  if (port === null) return;
  // 水合完成前的写入会用「默认态 + 空 preservedKeys」整份覆盖 ui.json，
  // 抹掉上一会话的全部机器配置——宁丢几毫秒内的改动，不丢磁盘。
  if (!hydrated) return;
  // 未来版本的 ui.json 本会话只读，避免 schemaVersion 被旧版应用降级覆写。
  if (futureDocument) return;
  const target = port;
  const state = useMachineStore.getState();
  const json = serializeMachineUi(
    state.floatSizes,
    state.floatPositions,
    state.recall,
    state.pomodoro,
    state.ai,
    state.panels.ai,
    state.sidebarWidth,
  );
  writeChain = writeChain.then(async () => {
    try {
      await target.write(json);
      lastWriteFailure = null;
    } catch (error) {
      // 链内吞错保序：一次失败不应让后续写入被跳过；失败由 flush 上报
      lastWriteFailure = error instanceof Error ? error : new Error(String(error));
      console.warn(
        '机器本地 ui.json 写入失败，浮窗尺寸暂存内存：',
        error instanceof Error ? error.message : String(error),
      );
    }
  });
};

/** 等待排队中的写入落盘（测试与关闭前使用）；有失败时上报一次后清空。 */
export const flushMachineUiWrites = async (): Promise<void> => {
  await writeChain;
  if (lastWriteFailure === null) return;
  const failure = lastWriteFailure;
  lastWriteFailure = null;
  throw failure;
};

/** 主内容区高度 = 窗口高度 - 顶栏 52 - 状态栏 28（与 tokens.css 一致） */
const measurePanelArea = (): PanelArea => {
  if (typeof window === 'undefined') return DEFAULT_PANEL_AREA;
  return {
    width: Math.max(1, window.innerWidth),
    height: Math.max(1, window.innerHeight - 80),
  };
};

/** 启动时读取一次；失败只降级为内存态，不阻塞内核启动。 */
export const hydrateMachineUi = (): Promise<void> => {
  if (port === null || hydrated) return Promise.resolve();
  hydrating ??= (async (): Promise<void> => {
    const target = port;
    if (target === null) return;
    const area = measurePanelArea();
    try {
    const text = await target.read();
    if (text === null) {
      // 首次启动还没有 ui.json：面板停在与当前窗口匹配的右下默认位
      useMachineStore.setState({ panels: { ai: { open: false, ...defaultAiPanelRect(area) } } });
      return;
    }
    const parsed = parseMachineUi(text, area);
    if (parsed !== null) {
      preservedKeys = readPreservedKeys(text);
      useMachineStore.setState({
        floatSizes: parsed.floatSizes,
        floatPositions: parsed.floatPositions,
        recall: parsed.recall,
        pomodoro: parsed.pomodoro,
        ai: parsed.ai,
        panels: parsed.panels,
        sidebarWidth: parsed.sidebarWidth,
      });
      return;
    }
    // 解析失败：可能是未来版本的 ui.json。识别出更高 schemaVersion 就整会话禁写，
    // 避免旧版本应用用默认态把新字段整份抹掉。
    try {
      const raw: unknown = JSON.parse(text);
      if (
        typeof raw === 'object' &&
        raw !== null &&
        typeof (raw as Readonly<Record<string, unknown>>).schemaVersion === 'number' &&
        ((raw as Readonly<Record<string, unknown>>).schemaVersion as number) >
          FLOAT_SIZE_SCHEMA_VERSION
      ) {
        futureDocument = true;
        console.warn('ui.json 来自更新版本的应用，本次会话只读不回写');
      }
    } catch {
      // 连 JSON 都不是：保持原有行为（内存默认态，后续写入覆盖损坏文件）
    }
    } catch (error) {
      console.warn(
        '机器本地 ui.json 读取失败，浮窗尺寸使用默认值：',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      // 无论成败，磁盘状态都已定案（读出或判为不可读），此后允许写入。
      hydrated = true;
    }
  })();
  return hydrating;
};

export const useMachineStore = create<MachineState>((set) => ({
  floatSizes: {},
  floatPositions: {},
  recall: null,
  pomodoro: DEFAULT_POMODORO,
  ai: DEFAULT_AI,
  panels: { ai: DEFAULT_AI_PANEL },
  sidebarWidth: DEFAULT_SIDEBAR_WIDTH,

  rememberFloatSize: (docId, size) => {
    const next: FloatSize = {
      width: Math.max(1, Math.round(size.width)),
      height: Math.max(1, Math.round(size.height)),
    };
    set((state) => ({ floatSizes: { ...state.floatSizes, [docId]: next } }));
    queueWrite();
  },
  rememberFloatPosition: (docId, position) => {
    const next: FloatPosition = { left: Math.round(position.left), top: Math.round(position.top) };
    set((state) => ({ floatPositions: { ...state.floatPositions, [docId]: next } }));
    queueWrite();
  },
  rememberRecall: (recall) => {
    set({ recall });
    queueWrite();
  },
  setPomodoro: (next) => {
    set({ pomodoro: parsePomodoro(next) });
    queueWrite();
  },
  setAi: (patch) => {
    set((state) => ({ ai: parseAi({ ...state.ai, ...patch }) }));
    queueWrite();
  },
  setAiPanel: (patch) => {
    // 只夹取数值范围，不按参考区域重排位置：真实窗口尺寸由组件在渲染时夹取
    set((state) => {
      const current = state.panels.ai;
      const next = { ...current, ...patch };
      return {
        panels: {
          ai: {
            open: next.open === true,
            x: clampInt(next.x, current.x, 0, Number.MAX_SAFE_INTEGER),
            y: clampInt(next.y, current.y, 0, Number.MAX_SAFE_INTEGER),
            width: clampInt(next.width, current.width, AI_PANEL_MIN_WIDTH, AI_PANEL_MAX_WIDTH),
            height: clampInt(next.height, current.height, AI_PANEL_MIN_HEIGHT, Number.MAX_SAFE_INTEGER),
          },
        },
      };
    });
    queueWrite();
  },
  setSidebarWidth: (width) => {
    set({
      sidebarWidth: clampInt(width, DEFAULT_SIDEBAR_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH),
    });
    queueWrite();
  },
}));
