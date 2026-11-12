import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { DocId } from '#doc-model';
import { toErrorText } from '../kernel/errors.ts';
import type { CapabilityState, CommandDescriptor, SettingsPatch } from '../kernel/types.ts';
import { runCloseFlow } from './close-flow.ts';
import { useKernel, useKernelShutdown, useWindowPort } from './kernel-provider.tsx';
import { AiPanel } from './ai/AiPanel.tsx';
import { CanvasSurface } from './canvas/CanvasSurface.tsx';
import { CommandPalette } from './commands/CommandPalette.tsx';
import { useShellCommands } from './commands/shell-commands.ts';
import { ImportDialog } from './import/ImportDialog.tsx';
import { useImportCommands } from './import/import-commands.ts';
import { setCursor } from './editor/cursor-store.ts';
import { flushFloatEditors } from './editor/float-flush.ts';
import { useFloatStore } from './editor/float-store.ts';
import { useFocusStore } from './editor/focus-store.ts';
import { flushMachineUiWrites, useMachineStore } from '../data/stores/machine-store.ts';
import { SidebarDock } from './components/SidebarDock.tsx';
import { StatusBar } from './components/StatusBar.tsx';
import { Topbar } from './components/Topbar.tsx';
import { ToolRail } from './tools/ToolRail.tsx';
import { SettingsPanel } from './settings/SettingsPanel.tsx';
import { WindowChrome } from './window/WindowChrome.tsx';
import styles from './App.module.css';

/**
 * 主页外壳：顶栏 / 资源管理器 / 无限画布 / 状态栏。
 * 所有展示值都来自内核真实状态，不使用占位数据。
 */
export const App = (): ReactElement => {
  const kernel = useKernel();
  const windowPort = useWindowPort();
  const shutdown = useKernelShutdown();
  const queryClient = useQueryClient();
  // 侧栏高亮 / 浮窗层级共用同一份激活状态；关闭最前窗时 store 会回退到下一扇
  const activeDocId = useFloatStore((state) => state.activeId);
  const focusActive = useFocusStore((state) => state.active);
  const aiOpen = useMachineStore((state) => state.panels.ai.open);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [commands, setCommands] = useState<readonly CommandDescriptor[]>(() =>
    kernel.commands.list(),
  );
  const [capabilities, setCapabilities] = useState<readonly CapabilityState[]>(() =>
    kernel.capabilities.list(),
  );
  // 运行期库锁被接管后由内核广播 vault:mode，状态栏需要跟着切换
  const [readonlyMode, setReadonlyMode] = useState(kernel.env.readonlyMode);
  // 关窗落盘失败：阻止本次关闭并在状态栏提示；同一会话内第二次关闭直接放行
  const [closeFailures, setCloseFailures] = useState<readonly string[] | null>(null);
  const closeBlockedRef = useRef(false);
  const closeFailuresRef = useRef<readonly string[] | null>(null);

  useShellCommands();
  useImportCommands();

  const documents = useQuery({ queryKey: ['docs', 'list'], queryFn: () => kernel.docs.list() });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => kernel.settings.read() });

  // 外部新增/删除/改动文档时刷新列表（冲突副本也经此进入侧栏）
  useEffect(() => {
    const subscription = kernel.events.on('doc:changed', () => {
      void queryClient.invalidateQueries({ queryKey: ['docs', 'list'] });
      void queryClient.invalidateQueries({ queryKey: ['docs', 'texts'] });
    });
    return () => {
      subscription.dispose();
    };
  }, [kernel, queryClient]);

  // 本进程 patch 落盘后同步面板展示；外部直接改 settings.json 暂无监听（下次 patch 会重读磁盘保留改动）
  useEffect(() => {
    const subscription = kernel.events.on('settings:changed', ({ settings: next }) => {
      queryClient.setQueryData(['settings'], next);
    });
    return () => {
      subscription.dispose();
    };
  }, [kernel, queryClient]);

  // 能力开关不经过 React 状态，订阅状态事件后重新取一次
  useEffect(() => {
    setCapabilities(kernel.capabilities.list());
    const subscription = kernel.events.on('capability:state', () => {
      setCapabilities(kernel.capabilities.list());
    });
    return () => {
      subscription.dispose();
    };
  }, [kernel]);

  // 库锁运行期失守：内核广播 vault:mode，界面切到只读
  useEffect(() => {
    setReadonlyMode(kernel.env.readonlyMode);
    const subscription = kernel.events.on('vault:mode', ({ readonly }) => {
      setReadonlyMode(readonly);
    });
    return () => {
      subscription.dispose();
    };
  }, [kernel]);

  // 关闭/隐藏前把排队中的 ui.json 与编辑器待写内容冲掉：退出瞬间的最后一次变更不落盘就丢了
  useEffect(() => {
    const flushPendingWrites = (): void => {
      // 页面隐藏属尽力而为：失败由编辑器自身的状态栏提示，这里只负责不产生 unhandled rejection
      void flushMachineUiWrites().catch(() => undefined);
      void flushFloatEditors().catch(() => undefined);
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flushPendingWrites();
    };
    window.addEventListener('pagehide', flushPendingWrites);
    document.addEventListener('visibilitychange', onVisibility);
    // Tauri 关窗不会卸载 React 树，必须拦住关闭、落盘后再放行
    let disposed = false;
    let unlistenClose: (() => void) | null = null;
    void windowPort
      .onCloseRequested(async () => {
        // 第二次关闭：用户已看到「保存失败、再次关闭将丢弃改动」的提示，放行以免窗口关不掉
        if (closeBlockedRef.current) {
          kernel.log.error('关窗落盘仍失败：按用户二次关闭直接放行，未保存内容可能丢失', {
            failures: closeFailuresRef.current,
          });
          return true;
        }
        const outcome = await runCloseFlow({
          flushers: [
            flushMachineUiWrites,
            flushFloatEditors,
            () => kernel.settings.flush(),
            () => kernel.docs.flush(),
            () => kernel.canvas.flush(),
          ],
          shutdown,
          log: kernel.log,
        });
        if (outcome.kind === 'close') return true;
        // 落盘失败：拦住窗口并提示；不进入 shutdown，避免半拆解后还能继续编辑
        closeBlockedRef.current = true;
        closeFailuresRef.current = outcome.failures;
        setCloseFailures(outcome.failures);
        kernel.log.error('关窗落盘失败，已阻止关闭', { failures: outcome.failures });
        return false;
      })
      .then((unlisten) => {
        if (disposed) unlisten();
        else unlistenClose = unlisten;
      });
    return () => {
      disposed = true;
      unlistenClose?.();
      window.removeEventListener('pagehide', flushPendingWrites);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [kernel, shutdown, windowPort]);

  // 命令注册/注销不经过 React 状态，订阅总线后同步侧栏与命令面板
  useEffect(() => {
    setCommands(kernel.commands.list());
    const subscription = kernel.commands.watch((next) => {
      setCommands(next);
    });
    return () => {
      subscription.dispose();
    };
  }, [kernel]);

  // ⌘K / Ctrl+K 开关命令面板；⌘⇧F 在「当前浮窗」上进/出专注模式
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'k' && !event.shiftKey) {
        event.preventDefault();
        setPaletteOpen((current) => !current);
        return;
      }
      if (key !== 'f' || !event.shiftKey) return;
      event.preventDefault();
      const focus = useFocusStore.getState();
      if (focus.active) {
        focus.exit();
        return;
      }
      // 没有可专注的浮窗时快捷键不做事，也不新开窗口
      const current = useFloatStore.getState().activeId;
      if (current !== null) focus.enter(current);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  /**
   * 打开文档浮窗：统一交给浮窗 store —— 未开则新开，已开则聚焦置顶，
   * 满 5 篇则拒绝并出提示条（不自动挤掉任何窗口）。
   */
  const openFloat = useCallback((docId: DocId, focus: 'title' | null): void => {
    useFloatStore.getState().open(docId, focus);
  }, []);

  const patchSettings = async (patch: SettingsPatch): Promise<void> => {
    await kernel.settings.patch(patch);
  };

  const toggleCapability = async (id: CapabilityState['id'], enabled: boolean): Promise<void> => {
    await kernel.capabilities.setEnabled(id, enabled);
    await kernel.settings.patch({ capabilities: { [String(id)]: { enabled } } });
  };

  const activeCapabilities = capabilities.filter((state) => state.active).length;
  const documentsError = documents.isError ? toErrorText(documents.error) : null;

  return (
    <div className={`${styles.root} ${focusActive ? styles.focusMode : ''}`}>
      <Topbar
        kernelVersion={kernel.env.kernelVersion}
        readonlyMode={readonlyMode}
        aiOpen={aiOpen}
        onToggleAi={() => {
          useMachineStore.getState().setAiPanel({ open: !aiOpen });
        }}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <div className={styles.body}>
        <main className={styles.main}>
          <CanvasSurface onOpenFloat={openFloat} onCursor={setCursor} />
        </main>

        {aiOpen ? (
          <AiPanel
            onClose={() => {
              useMachineStore.getState().setAiPanel({ open: false });
            }}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        ) : null}

        <ToolRail />

        <SidebarDock
          mode={(settings.data ?? { ui: { sidebar: 'auto' } }).ui.sidebar}
          capabilities={capabilities}
          commands={commands}
          documents={documents.data ?? []}
          documentsLoading={documents.isPending}
          documentsError={documentsError}
          activeDocId={activeDocId}
          onSelectDoc={(id) => {
            openFloat(id, null);
          }}
        />
      </div>

      <StatusBar
        readonlyMode={readonlyMode}
        kernelVersion={kernel.env.kernelVersion}
        documentCount={documents.data?.length ?? 0}
        activeCapabilities={activeCapabilities}
        capabilityCount={capabilities.length}
        commandCount={commands.length}
        notice={closeFailures === null ? null : '保存失败，已阻止关闭；再次关闭将丢弃改动'}
      />

      {settingsOpen ? (
        <SettingsPanel
          settings={settings.data ?? null}
          capabilities={capabilities}
          kernelVersion={kernel.env.kernelVersion}
          onClose={() => setSettingsOpen(false)}
          onPatch={patchSettings}
          onToggleCapability={toggleCapability}
        />
      ) : null}

      {paletteOpen ? (
        <CommandPalette
          commands={commands}
          activeDocId={activeDocId}
          onClose={() => {
            setPaletteOpen(false);
          }}
        />
      ) : null}

      <ImportDialog />

      <WindowChrome />
    </div>
  );
};
