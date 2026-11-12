import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  type SetStateAction,
} from 'react';
import type { CanvasMutation, CanvasNode, CanvasPoint, CanvasScene, Viewport } from '#canvas-engine';
import { createUlid } from '#doc-model';
import type { CanvasId, DocId } from '#doc-model';
import type { DocMeta } from '../../kernel/types.ts';
import { useKernel } from '../kernel-provider.tsx';
import type { AnchorDoc } from './anchor-menu.ts';
import { readClipboard, writeClipboard } from './clipboard.ts';
import {
  centeredNodeRect,
  planAnchorEdge,
  planCommand,
  planEdgeLabel,
  planTextUpdate,
  type CommandPlan,
  type MenuTarget,
} from './commands.ts';
import { DEFAULT_NODE_SIZE, screenToWorld, type AnchorSide } from './geometry.ts';
import { buildCanvasMenu, type CanvasMenuItem } from './menu-model.ts';
import {
  edgeIdAt,
  isTypingTarget,
  nodeIdAt,
  resolveContextEdge,
  resolveContextNode,
} from './surface-hit.ts';

/** 一步新建文章：先在光标处问标题，再落盘建节点 */
export interface ArticlePromptState {
  readonly x: number;
  readonly y: number;
  /** 世界坐标（节点左上角） */
  readonly point: CanvasPoint;
  readonly value: string;
  /** 从引线拖到空白新建时，落盘后自动补一条边 */
  readonly anchor: { readonly from: string; readonly side: AnchorSide } | null;
}

/** 引线在空白处松手 / 空白右键「从库添加」：复用同一套目录下钻菜单 */
export interface AnchorMenuState {
  /** 引线起点；从空白右键进入时为 null（只落节点，不补边） */
  readonly from: string | null;
  readonly side: AnchorSide | null;
  /** 世界坐标（引线末端 / 右键点，新节点中心对齐这里） */
  readonly point: CanvasPoint;
  /** 画布内屏幕坐标（菜单定位） */
  readonly x: number;
  readonly y: number;
  readonly purpose: 'anchor' | 'insert';
}

export interface MenuState {
  readonly target: MenuTarget;
  readonly x: number;
  readonly y: number;
  readonly items: readonly CanvasMenuItem[];
}

interface EdgeLabelState {
  readonly edgeId: string;
  readonly x: number;
  readonly y: number;
  readonly value: string;
}

export interface CanvasCommandOptions {
  readonly surfaceRef: RefObject<HTMLDivElement | null>;
  readonly scene: CanvasScene | null;
  readonly sceneRef: RefObject<CanvasScene | null>;
  readonly canvasId: CanvasId | null;
  readonly viewportRef: RefObject<Viewport>;
  readonly selected: ReadonlySet<string>;
  readonly setSelected: Dispatch<SetStateAction<ReadonlySet<string>>>;
  readonly setSelectedEdgeId: Dispatch<SetStateAction<string | null>>;
  readonly setEditingId: Dispatch<SetStateAction<string | null>>;
  readonly docIndex: ReadonlyMap<string, DocMeta>;
  readonly commitViewport: (next: Viewport) => void;
  readonly showError: (message: string) => void;
  readonly reportError: (cause: unknown) => void;
  readonly onOpenFloat: (docId: DocId, focus: 'title' | null) => void;
  readonly menu: MenuState | null;
  readonly setMenu: Dispatch<SetStateAction<MenuState | null>>;
  readonly anchorMenu: AnchorMenuState | null;
  readonly setAnchorMenu: Dispatch<SetStateAction<AnchorMenuState | null>>;
  readonly mountedRef: RefObject<boolean>;
}

/** 画布命令与右键菜单：菜单状态、命令计划落地、新建文章 / 节点、快捷键 */
export const useCanvasCommands = (options: CanvasCommandOptions) => {
  const {
    surfaceRef,
    scene,
    sceneRef,
    canvasId,
    viewportRef,
    selected,
    setSelected,
    setSelectedEdgeId,
    setEditingId,
    docIndex,
    commitViewport,
    showError,
    reportError,
    onOpenFloat,
    menu,
    setMenu,
    anchorMenu,
    setAnchorMenu,
    mountedRef,
  } = options;
  const kernel = useKernel();
  const [labelPrompt, setLabelPrompt] = useState<EdgeLabelState | null>(null);
  const [articlePrompt, setArticlePrompt] = useState<ArticlePromptState | null>(null);

  const commitText = useCallback(
    (id: string, text: string): void => {
      setEditingId(null);
      const node = sceneRef.current?.nodes.find((item) => item.id === id);
      const planned = planTextUpdate(node, text);
      if (planned === null || canvasId === null) return;
      void kernel.canvas
        .apply(canvasId, [{ type: 'updateNode', id, patch: { text: planned.text } }])
        .catch(reportError);
    },
    [canvasId, kernel, reportError, sceneRef, setEditingId],
  );

  /** 引线终点新建节点：节点与边在同一批 mutation 里落盘；空白右键入口只落节点 */
  const createNodeFromAnchor = useCallback(
    (state: AnchorMenuState, node: CanvasNode, startEdit: boolean = false): void => {
      if (canvasId === null) return;
      const mutations: CanvasMutation[] = [{ type: 'addNode', node }];
      if (state.from !== null && state.side !== null) {
        mutations.push({
          type: 'addEdge',
          edge: planAnchorEdge(state.from, state.side, node.id, `e_${createUlid()}`),
        });
      }
      void kernel.canvas
        .apply(canvasId, mutations)
        .then(() => {
          setSelected(new Set([node.id]));
          setSelectedEdgeId(null);
          // 落盘进入场景后再进编辑态：过早 setEditingId 时，极快输入+失焦
          // 会让 commitText 找不到节点而静默丢弃首段文字
          if (startEdit && mountedRef.current) setEditingId(node.id);
        })
        .catch(reportError);
    },
    [canvasId, kernel, mountedRef, reportError, setEditingId, setSelected, setSelectedEdgeId],
  );

  const createAnchorNote = useCallback((): void => {
    const state = anchorMenu;
    setAnchorMenu(null);
    // 「从库添加」入口没有引线起点，不提供新建节点
    if (state === null || scene === null || state.from === null || state.side === null) return;
    const node: CanvasNode = {
      id: `n_${createUlid()}`,
      kind: 'note',
      docId: null,
      text: '',
      rect: centeredNodeRect(state.point),
      z: scene.nodes.reduce((max, item) => Math.max(max, item.z), 0) + 1,
      groupId: null,
      meta: {},
    };
    createNodeFromAnchor(state, node, true);
  }, [anchorMenu, createNodeFromAnchor, scene, setAnchorMenu]);

  const pickAnchorDoc = useCallback(
    (doc: AnchorDoc): void => {
      const state = anchorMenu;
      setAnchorMenu(null);
      if (state === null || scene === null) return;
      const meta = docIndex.get(doc.id);
      if (meta === undefined) {
        showError('文档已不在库内');
        return;
      }
      const node: CanvasNode = {
        id: `n_${createUlid()}`,
        kind: 'doc',
        docId: meta.id,
        text: null,
        rect: centeredNodeRect(state.point),
        z: scene.nodes.reduce((max, item) => Math.max(max, item.z), 0) + 1,
        groupId: null,
        meta: {},
      };
      createNodeFromAnchor(state, node);
    },
    [anchorMenu, createNodeFromAnchor, docIndex, scene, setAnchorMenu, showError],
  );

  const startAnchorArticle = useCallback((): void => {
    const state = anchorMenu;
    if (state === null || state.from === null || state.side === null) return;
    setAnchorMenu(null);
    const rect = centeredNodeRect(state.point);
    setArticlePrompt({
      x: state.x,
      y: state.y,
      point: { x: rect.x, y: rect.y },
      value: '未命名文章',
      anchor: { from: state.from, side: state.side },
    });
  }, [anchorMenu, setAnchorMenu]);

  /** 命令计划落地：mutate 走内核，其余分支只改 UI 状态 */
  const applyPlan = useCallback(
    (plan: CommandPlan, point: CanvasPoint): void => {
      if (plan.kind === 'copy') {
        writeClipboard(plan.payload);
        return;
      }
      if (plan.kind === 'select') {
        setSelected(new Set(plan.ids));
        setSelectedEdgeId(null);
        return;
      }
      if (plan.kind === 'viewport') {
        commitViewport(plan.viewport);
        return;
      }
      if (plan.kind === 'prompt-edge-label') {
        setLabelPrompt({ edgeId: plan.edgeId, x: point.x, y: point.y, value: plan.value });
        return;
      }
      if (plan.kind === 'create-article') {
        setMenu(null);
        setArticlePrompt({ x: point.x, y: point.y, point: plan.point, value: '未命名文章', anchor: null });
        return;
      }
      if (plan.kind === 'pick-doc') {
        setMenu(null);
        setAnchorMenu({
          from: null,
          side: null,
          point: plan.point,
          x: point.x,
          y: point.y,
          purpose: 'insert',
        });
        return;
      }
      if (plan.kind === 'open-float') {
        setMenu(null);
        onOpenFloat(plan.docId, plan.focus);
        return;
      }

      const applyExtras = (): void => {
        if (plan.select !== undefined) setSelected(new Set(plan.select));
        if (plan.selectEdge !== undefined) setSelectedEdgeId(plan.selectEdge);
        if (plan.editNode !== undefined) setEditingId(plan.editNode);
      };

      if (plan.mutations.length === 0 || canvasId === null) {
        applyExtras();
        return;
      }
      void kernel.canvas
        .apply(canvasId, plan.mutations)
        .then(applyExtras)
        .catch(reportError);
    },
    [
      canvasId,
      commitViewport,
      kernel,
      onOpenFloat,
      reportError,
      setAnchorMenu,
      setEditingId,
      setMenu,
      setSelected,
      setSelectedEdgeId,
    ],
  );

  /** 菜单与快捷键共用入口：命令不可用时给出可见反馈，绝不留静默空操作 */
  const executeCommand = useCallback(
    (command: string, target: MenuTarget): void => {
      if (scene === null) return;
      const element = surfaceRef.current;
      const plan = planCommand({
        command,
        target,
        scene,
        selection: [...selected],
        clipboard: readClipboard(),
        newId: (prefix) => `${prefix}_${createUlid()}`,
        viewportSize: { w: element?.clientWidth ?? 0, h: element?.clientHeight ?? 0 },
      });
      if (plan === null) {
        showError('该命令在当前状态下不可用');
        return;
      }
      applyPlan(plan, target.point);
    },
    [applyPlan, scene, selected, showError, surfaceRef],
  );

  const closeMenu = useCallback(() => {
    setMenu(null);
  }, [setMenu]);

  const closeAnchorMenu = useCallback(() => {
    setAnchorMenu(null);
  }, [setAnchorMenu]);

  const onMenuSelect = useCallback(
    (command: string): void => {
      const current = menu;
      setMenu(null);
      if (current === null) return;
      executeCommand(command, current.target);
    },
    [executeCommand, menu, setMenu],
  );

  const submitEdgeLabel = useCallback(
    (value: string): void => {
      const prompt = labelPrompt;
      setLabelPrompt(null);
      if (prompt === null || scene === null || canvasId === null) return;
      const mutation = planEdgeLabel(scene, prompt.edgeId, value);
      if (mutation === null) {
        showError('连线已不存在');
        return;
      }
      void kernel.canvas.apply(canvasId, [mutation]).catch(reportError);
    },
    [canvasId, kernel, labelPrompt, reportError, scene, showError],
  );

  const cancelEdgeLabel = useCallback(() => {
    setLabelPrompt(null);
  }, []);

  /** 一步新建文章：标题确认后落盘 + 建节点；失败由 article-service 负责回滚 */
  const submitArticle = useCallback(
    (value: string): void => {
      const prompt = articlePrompt;
      setArticlePrompt(null);
      if (prompt === null || canvasId === null || scene === null) return;
      const nodeId = `n_${createUlid()}`;
      const z = scene.nodes.reduce((max, node) => Math.max(max, node.z), 0) + 1;
      kernel.articles
        .createOnCanvas({
          canvasId,
          title: value,
          point: prompt.point,
          nodeId,
          size: { w: DEFAULT_NODE_SIZE.w, h: DEFAULT_NODE_SIZE.h },
          z,
        })
        .then((result) => {
          setSelected(new Set([nodeId]));
          setSelectedEdgeId(null);
          onOpenFloat(result.snapshot.meta.id, 'title');
          const anchor = prompt.anchor;
          if (anchor !== null && scene.nodes.some((node) => node.id === anchor.from)) {
            const edge = planAnchorEdge(anchor.from, anchor.side, nodeId, `e_${createUlid()}`);
            return kernel.canvas.apply(canvasId, [{ type: 'addEdge', edge }]);
          }
          return null;
        })
        .catch(reportError);
    },
    [articlePrompt, canvasId, kernel, onOpenFloat, reportError, scene, setSelected, setSelectedEdgeId],
  );

  const cancelArticlePrompt = useCallback(() => {
    setArticlePrompt(null);
  }, []);

  const openDoc = useCallback(
    (nodeId: string): void => {
      const node = sceneRef.current?.nodes.find((item) => item.id === nodeId);
      if (node === undefined || node.docId === null) {
        showError('该节点没有可打开的文档');
        return;
      }
      onOpenFloat(node.docId, null);
    },
    [onOpenFloat, sceneRef, showError],
  );

  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>): void => {
    // 浮窗 / 菜单 / 输入框内的右键走各自的原生行为，不弹画布菜单
    if (event.target instanceof Element && event.target.closest('[data-canvas-overlay]') !== null) return;
    event.preventDefault();
    setAnchorMenu(null);
    const element = surfaceRef.current;
    if (scene === null || element === null) return;
    const bounds = element.getBoundingClientRect();
    const point = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };

    const openMenu = (target: MenuTarget): void => {
      setMenu({
        target,
        x: point.x,
        y: point.y,
        items: buildCanvasMenu({ target, scene, clipboard: readClipboard() }),
      });
    };

    const world = screenToWorld(point, viewportRef.current);
    const domId = nodeIdAt(event.target);
    const node = resolveContextNode(scene, domId, world);
    if (node !== null) {
      const inMultiSelection = selected.has(node.id) && selected.size > 1;
      if (!selected.has(node.id)) setSelected(new Set([node.id]));
      setSelectedEdgeId(null);
      openMenu(
        inMultiSelection
          ? { kind: 'selection', ids: [...selected], point }
          : { kind: 'node', id: node.id, point },
      );
      return;
    }

    const edgeId = resolveContextEdge(scene, edgeIdAt(event.target), world, viewportRef.current.zoom);
    if (edgeId !== null) {
      setSelectedEdgeId(edgeId);
      setSelected(new Set());
      openMenu({ kind: 'edge', id: edgeId, point });
      return;
    }

    openMenu({ kind: 'empty', point });
  };

  // 菜单上标注的快捷键必须真的生效，否则等同于点了没反应
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || isTypingTarget(event.target)) return;
      // 有原生文本选区（AI 面板回答、阅读态正文等可选文字）时让位给系统复制/全选，
      // 只在画布节点选择生效时接管
      if ((window.getSelection()?.isCollapsed ?? true) === false) return;
      const point = { x: 0, y: 0 };
      const key = event.key.toLowerCase();
      if (key === 'a') {
        event.preventDefault();
        executeCommand('view.select-all', { kind: 'empty', point });
        return;
      }
      if (key === 'c' && selected.size > 0) {
        event.preventDefault();
        executeCommand('node.copy', { kind: 'selection', ids: [...selected], point });
        return;
      }
      if (key === 'd' && selected.size > 0) {
        event.preventDefault();
        executeCommand('node.duplicate', { kind: 'selection', ids: [...selected], point });
        return;
      }
      if (key === 'v' && readClipboard() !== null) {
        // 剪贴板为空时不弹错误：静默让位，与系统行为一致
        event.preventDefault();
        executeCommand('node.paste', { kind: 'empty', point });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [executeCommand, selected]);

  return {
    commitText,
    openDoc,
    menu,
    closeMenu,
    onMenuSelect,
    labelPrompt,
    submitEdgeLabel,
    cancelEdgeLabel,
    articlePrompt,
    submitArticle,
    cancelArticlePrompt,
    anchorMenu,
    closeAnchorMenu,
    createAnchorNote,
    pickAnchorDoc,
    startAnchorArticle,
    onContextMenu,
  };
};
