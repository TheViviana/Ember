import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { CanvasId, DocId } from '#doc-model';
import { isPermissionDenied, toErrorText } from '../kernel/errors.ts';
import type { CommandDescriptor, SettingsPatch } from '../kernel/types.ts';
import { runCloseFlow } from './close-flow.ts';
import { useKernel, useKernelShutdown, useWindowPort } from './kernel-provider.tsx';
import { AiPanel } from './ai/AiPanel.tsx';
import { CanvasSurface } from './canvas/CanvasSurface.tsx';
import { requestCanvasView } from './canvas/canvas-view-signal.ts';
import { useCanvasLibrary } from './canvas/use-canvas-library.ts';
import { CommandPalette } from './commands/CommandPalette.tsx';
import {
  CAPTURE_COMMAND,
  usePanelCommands,
  useShellCommands,
} from './commands/shell-commands.ts';
import { ImportDialog } from './import/ImportDialog.tsx';
import { useImportCommands } from './import/import-commands.ts';
import { setCursor } from './editor/cursor-store.ts';
import { requestFloatJump } from './editor/float-jump.ts';
import { flushFloatEditors } from './editor/float-flush.ts';
import { useFloatStore } from './editor/float-store.ts';
import { useFocusStore } from './editor/focus-store.ts';
import { flushMachineUiWrites, useMachineStore } from '../data/stores/machine-store.ts';
import { DocumentListPanel } from './documents/DocumentListPanel.tsx';
import { ConflictPanel } from './documents/ConflictPanel.tsx';
import { HealthPanel } from './documents/HealthPanel.tsx';
import { InboxPanel } from './collect/InboxPanel.tsx';
import { layout } from './theme/tokens.ts';
import { AttachmentPanel } from './attachments/AttachmentPanel.tsx';
import { SplashOverlay } from './components/SplashOverlay.tsx';
import { StatusBar } from './components/StatusBar.tsx';
import { Topbar } from './components/Topbar.tsx';
import { GlobalReplacePanel } from './replace/GlobalReplacePanel.tsx';
import { exportDocPdf } from './export/print-export.ts';
import { ToolRail } from './tools/ToolRail.tsx';
import { SettingsPanel } from './settings/SettingsPanel.tsx';
import { WindowChrome } from './window/WindowChrome.tsx';
import styles from './App.module.css';

/**
 * 主页外壳：顶栏 / 无限画布 / 状态栏。
 * 画布导航来自画布库（总览 + 多画布 + Portal 面包屑），
 * 文档列表、AI 对话都是可召出的浮层，无常驻侧栏。
 */
export const App = (): ReactElement => {
  const kernel = useKernel();
  const windowPort = useWindowPort();
  const shutdown = useKernelShutdown();
  const queryClient = useQueryClient();
  // 浮窗层级共用同一份激活状态；关闭最前窗时 store 会回退到下一扇
  const activeDocId = useFloatStore((state) => state.activeId);
  const focusActive = useFocusStore((state) => state.active);
  const [aiOpen, setAiOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [docListOpen, setDocListOpen] = useState(false);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [healthOpen, setHealthOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // 开启动画：火焰阶段结束后主界面入场，淡出完成卸载启动画面
  const [splashActive, setSplashActive] = useState(true);
  const [splashRevealed, setSplashRevealed] = useState(false);
  const [commands, setCommands] = useState<readonly CommandDescriptor[]>(() =>
    kernel.commands.list(),
  );
  // 独占创建 + pid 存活模型下只读只在启动时确定（被另一实例占用），运行期不变
  const readonlyMode = kernel.env.readonlyMode;
  const readonlyReason = kernel.env.readonlyReason;
  // 关窗落盘失败：阻止本次关闭并在状态栏提示；同一会话内第二次关闭直接放行
  const [closeFailures, setCloseFailures] = useState<readonly string[] | null>(null);
  const closeBlockedRef = useRef(false);
  const closeFailuresRef = useRef<readonly string[] | null>(null);

  const library = useCanvasLibrary();

  useShellCommands();
  useImportCommands();

  const documents = useQuery({ queryKey: ['docs', 'list'], queryFn: () => kernel.docs.list() });

  /** 当前最前浮窗文档的库内路径：状态栏展示 + 点击复制 */
  const activeDocPath = useMemo(() => {
    if (activeDocId === null) return null;
    const meta = documents.data?.find((item) => String(item.id) === String(activeDocId));
    return meta === undefined ? null : String(meta.path);
  }, [activeDocId, documents.data]);
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => kernel.settings.read() });

  // 外部新增/删除/改动文档时刷新列表（冲突副本也经此进入文档列表）
  useEffect(() => {
    const changed = kernel.events.on('doc:changed', () => {
      void queryClient.invalidateQueries({ queryKey: ['docs', 'list'] });
    });
    // 运行时新落盘的冲突副本不经过 doc:changed；单独监听以更新徽标与分组
    const conflicted = kernel.events.on('doc:conflict', () => {
      void queryClient.invalidateQueries({ queryKey: ['docs', 'list'] });
    });
    return () => {
      changed.dispose();
      conflicted.dispose();
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

  // 浮窗上限跟随设置（默认 5 可配置）
  useEffect(() => {
    const limit = settings.data?.ui.floatLimit;
    if (typeof limit === 'number') useFloatStore.getState().setLimit(limit);
  }, [settings.data]);

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

  // 命令注册/注销不经过 React 状态，订阅总线后同步命令面板
  useEffect(() => {
    setCommands(kernel.commands.list());
    const subscription = kernel.commands.watch((next) => {
      setCommands(next);
    });
    return () => {
      subscription.dispose();
    };
  }, [kernel]);

  const panelHandlers = useMemo(
    () => ({
      openDocuments: () => {
        setDocListOpen((value) => !value);
      },
      openConflicts: () => {
        setConflictOpen((value) => !value);
      },
      openHealth: () => {
        setSettingsOpen(false);
        setHealthOpen(true);
      },
      openInbox: () => {
        setSettingsOpen(false);
        setInboxOpen(true);
      },
      openAttachments: () => {
        setAttachmentsOpen((value) => !value);
      },
      openAi: () => {
        setAiOpen(true);
      },
      showOverview: () => {
        library.showOverview();
      },
      createCanvas: () => {
        void library.createCanvas('新画布');
      },
    }),
    [library],
  );
  usePanelCommands(panelHandlers);

  // ⌘K 开关统一搜索；⌘⇧F 专注模式；⌘⇧I 快速收集箱；⌘⇧N 快捷捕获（落在当前镜头中心）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'k' && !event.shiftKey) {
        event.preventDefault();
        setPaletteOpen((current) => !current);
        return;
      }
      if (key === 'i' && event.shiftKey) {
        event.preventDefault();
        setSettingsOpen(false);
        setInboxOpen(true);
        return;
      }
      if (key === 'n' && event.shiftKey) {
        event.preventDefault();
        void kernel.commands.execute(CAPTURE_COMMAND).then((result) => {
          if (!result.ok) kernel.log.warn('快捷捕获失败', { error: result.error });
        });
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
  }, [kernel]);

  /**
   * 打开文档浮窗：统一交给浮窗 store —— 未开则新开，已开则聚焦置顶，
   * 满上限则拒绝并出提示条，挤掉哪一扇由用户显式决定。
   */
  const openFloat = useCallback((docId: DocId, focus: 'title' | null): void => {
    useFloatStore.getState().open(docId, focus);
  }, []);

  // 并排查看：先写入两扇浮窗的左右半区几何，再打开；新挂载的窗口会读取这些值
  const openConflictSideBySide = useCallback(
    (originalId: DocId, copyId: DocId): void => {
      const margin = 16;
      const top = layout.topbarHeight + 12;
      const availableWidth = window.innerWidth - margin * 3;
      const width = Math.min(layout.floatWidth, Math.max(layout.floatMinWidth, Math.floor(availableWidth / 2)));
      const height = Math.min(
        layout.floatHeight,
        Math.max(layout.floatMinHeight, window.innerHeight - top - layout.statusbarHeight - margin),
      );
      const machine = useMachineStore.getState();
      machine.rememberFloatSize(String(originalId), { width, height });
      machine.rememberFloatSize(String(copyId), { width, height });
      machine.rememberFloatPosition(String(originalId), { left: margin, top });
      machine.rememberFloatPosition(String(copyId), { left: margin * 2 + width, top });
      openFloat(originalId, null);
      openFloat(copyId, null);
      setConflictOpen(false);
    },
    [openFloat],
  );

  const conflictCount = useMemo(
    () => (documents.data ?? []).filter((meta) => meta.conflictOf !== null).length,
    [documents.data],
  );

  const patchSettings = useCallback(
    async (patch: SettingsPatch): Promise<void> => {
      await kernel.settings.patch(patch);
    },
    [kernel],
  );

  const documentsError = documents.isError
    ? isPermissionDenied(documents.error)
      ? '无法读取库：macOS 未授予 Ember 访问「文稿」的权限。请到「系统设置 → 隐私与安全性 → 文件与文件夹」中允许，然后重新打开文档列表。'
      : toErrorText(documents.error)
    : null;
  const toolEntries = {
    pomodoro: settings.data?.ui.toolPomodoro === true,
    gallery: settings.data?.ui.toolGallery === true,
  };
  // 今日回顾层（原左下工具入口）：与画布视图菜单共用同一份机器本地开关
  const currentCanvasId = library.currentId;
  const recentEditsOpen = useMachineStore(
    (state) => state.canvasFlags[String(currentCanvasId)]?.recentEdits === true,
  );
  const toggleRecentEdits = useCallback((): void => {
    const key = String(currentCanvasId);
    if (key === 'null') return;
    const flags = useMachineStore.getState().canvasFlags;
    useMachineStore.getState().setCanvasFlag(key, { recentEdits: !(flags[key]?.recentEdits === true) });
    void flushMachineUiWrites().catch(() => undefined);
  }, [currentCanvasId]);

  return (
    <>
      <div className={`${styles.root} ${splashRevealed ? styles.revealed : styles.booting} ${focusActive ? styles.focusMode : ''}`}>
      <Topbar
        kernelVersion={kernel.env.kernelVersion}
        readonlyMode={readonlyMode}
        readonlyReason={readonlyReason}
        library={library}
        onOpenDocuments={() => {
          setDocListOpen((value) => !value);
        }}
        onOpenSearch={() => {
          setPaletteOpen((value) => !value);
        }}
        aiOpen={aiOpen}
        onToggleAi={() => {
          setAiOpen((value) => !value);
        }}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenReplace={() => setReplaceOpen(true)}
        onExportPdf={() => {
          if (activeDocId === null) return;
          const title = documents.data?.find((item) => String(item.id) === String(activeDocId))?.title ?? '';
          void exportDocPdf(kernel, activeDocId, title).catch((cause: unknown) => {
            void kernel.log.error('导出 PDF 失败', { cause: String(cause) });
          });
        }}
        exportDisabled={activeDocId === null}
        conflictCount={conflictCount}
        onOpenConflicts={() => {
          setConflictOpen((value) => !value);
        }}
      />

      <div className={styles.body}>
        <main className={styles.main}>
          {library.error === null ? null : (
            <p role="alert" className={styles.libraryError}>{library.error}</p>
          )}
          {library.currentId === null ? null : (
            <CanvasSurface
              canvasId={library.currentId}
              onOpenFloat={openFloat}
              onCursor={setCursor}
              onEnterPortal={(target) => library.enterPortal(target)}
              canvasIndex={library.canvasIndex}
            />
          )}
        </main>

        {aiOpen ? (
          <AiPanel
            onClose={() => {
              setAiOpen(false);
            }}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        ) : null}

        {docListOpen ? (
          <DocumentListPanel
            documents={documents.data ?? []}
            loading={documents.isPending}
            error={documentsError}
            activeDocId={activeDocId === null ? null : String(activeDocId)}
            onSelectDoc={(id) => {
              openFloat(id as DocId, null);
            }}
            onOpenCanvasLocation={(canvasId, nodeId) => {
              library.openCanvas(canvasId as CanvasId);
              requestCanvasView({ highlightNodeId: nodeId });
              setDocListOpen(false);
            }}
            onClose={() => {
              setDocListOpen(false);
            }}
          />
        ) : null}

        {conflictOpen ? (
          <ConflictPanel
            documents={documents.data ?? []}
            onOpenSideBySide={openConflictSideBySide}
            onClose={() => {
              setConflictOpen(false);
            }}
          />
        ) : null}

        {healthOpen ? (
          <HealthPanel
            onClose={() => {
              setHealthOpen(false);
            }}
          />
        ) : null}

        {inboxOpen ? (
          <InboxPanel
            onClose={() => {
              setInboxOpen(false);
            }}
          />
        ) : null}

        <ToolRail
          entries={toolEntries}
          attachmentsOpen={attachmentsOpen}
          onOpenAttachments={() => {
            setAttachmentsOpen((value) => !value);
          }}
          recentEditsOpen={recentEditsOpen}
          onToggleRecentEdits={toggleRecentEdits}
        />

        {attachmentsOpen ? (
          <AttachmentPanel library={library} onClose={() => setAttachmentsOpen(false)} />
        ) : null}
      </div>

      <StatusBar
        readonlyMode={readonlyMode}
        readonlyReason={readonlyReason}
        kernelVersion={kernel.env.kernelVersion}
        documentCount={documents.data?.length ?? 0}
        commandCount={commands.length}
        notice={closeFailures === null ? null : '保存失败，已阻止关闭；再次关闭将丢弃改动'}
        docPath={activeDocPath}
      />

      {replaceOpen ? (
        <GlobalReplacePanel
          onClose={() => {
            setReplaceOpen(false);
          }}
        />
      ) : null}

      {settingsOpen ? (
        <SettingsPanel
          settings={settings.data ?? null}
          kernelVersion={kernel.env.kernelVersion}
          onClose={() => setSettingsOpen(false)}
          onPatch={patchSettings}
          onOpenHealth={() => {
            // 健康检查是独立浮窗：设置面板保持打开，可同时看到两个窗口
            setHealthOpen(true);
          }}
        />
      ) : null}

      {paletteOpen ? (
        <CommandPalette
          commands={commands}
          activeDocId={activeDocId === null ? null : String(activeDocId)}
          library={library}
          onOpenDoc={(docId, line) => {
            if (line !== null) requestFloatJump(docId, line);
            openFloat(docId, null);
          }}
          onClose={() => {
            setPaletteOpen(false);
          }}
        />
      ) : null}

      <ImportDialog />

      <WindowChrome />
    </div>

      {/* 启动画面放在 .root 之外：booting 期根节点 opacity:0，
          若作为其子节点，启动画面会连同外壳一起被藏掉，永远播不出来 */}
      {splashActive ? (
        <SplashOverlay
          onReveal={() => setSplashRevealed(true)}
          onDone={() => setSplashActive(false)}
        />
      ) : null}
    </>
  );
};
