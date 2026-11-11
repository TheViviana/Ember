import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type { DocId } from '#doc-model';
import { toErrorText } from '../kernel/errors.ts';
import type { CapabilityState, CommandDescriptor, SettingsPatch } from '../kernel/types.ts';
import { useKernel } from './kernel-provider.tsx';
import { AiPanel } from './ai/AiPanel.tsx';
import { CanvasSurface } from './canvas/CanvasSurface.tsx';
import { CommandPalette } from './commands/CommandPalette.tsx';
import { useShellCommands } from './commands/shell-commands.ts';
import { ImportDialog } from './import/ImportDialog.tsx';
import { useImportCommands } from './import/import-commands.ts';
import { setCursor } from './editor/cursor-store.ts';
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

  // 设置变更（本窗口 patch 或外部文件变化）时同步面板展示
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

  // 关闭/隐藏前把排队中的 ui.json 写入冲掉：退出瞬间的最后一次变更不落盘就丢了
  useEffect(() => {
    const flushPendingWrites = (): void => {
      void flushMachineUiWrites();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flushPendingWrites();
    };
    window.addEventListener('pagehide', flushPendingWrites);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flushPendingWrites);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

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
        readonlyMode={kernel.env.readonlyMode}
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
        readonlyMode={kernel.env.readonlyMode}
        kernelVersion={kernel.env.kernelVersion}
        documentCount={documents.data?.length ?? 0}
        activeCapabilities={activeCapabilities}
        capabilityCount={capabilities.length}
        commandCount={commands.length}
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
