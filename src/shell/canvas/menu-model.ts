import type { CanvasScene } from '#canvas-engine';
import type { CanvasClipboard } from './clipboard.ts';
import { NODE_COLORS, type MenuTarget } from './commands.ts';

export interface CanvasMenuItem {
  readonly id: string;
  readonly label: string;
  readonly shortcut?: string;
  readonly checked?: boolean;
  readonly danger?: boolean;
  readonly separatorBefore?: boolean;
  readonly children?: readonly CanvasMenuItem[];
}

export interface CanvasMenuInput {
  readonly target: MenuTarget;
  readonly scene: CanvasScene;
  readonly clipboard: CanvasClipboard | null;
}

const nodeById = (scene: CanvasScene, id: string) =>
  scene.nodes.find((node) => node.id === id) ?? null;

const colorOf = (meta: Readonly<Record<string, unknown>>): string | null =>
  typeof meta.color === 'string' ? meta.color : null;

const colorItems = (colors: readonly (string | null)[]): readonly CanvasMenuItem[] => {
  const unique = new Set(colors.map((color) => color ?? 'default'));
  const checked = (value: string): boolean => unique.size === 1 && unique.has(value);
  return [
    { id: 'color:default', label: '默认', checked: checked('default') },
    ...NODE_COLORS.map((color) => ({
      id: `color:${color}`,
      label: { primary: '主色', secondary: '次色', success: '成功', warning: '警告', danger: '危险' }[color],
      checked: checked(color),
    })),
  ];
};

export const emptyMenu = (
  scene: CanvasScene,
  clipboard: CanvasClipboard | null,
): readonly CanvasMenuItem[] => {
  const items: CanvasMenuItem[] = [
    { id: 'node.create-article', label: '新建文章…' },
    { id: 'node.create-note', label: '新建自由文本节点' },
    { id: 'node.add-doc', label: '从库添加已有文章…' },
    { id: 'node.create-group', label: '新建分组' },
  ];
  if (clipboard !== null && clipboard.nodes.length > 0) {
    items.push({ id: 'node.paste', label: '粘贴', shortcut: '⌘V', separatorBefore: true });
  }
  items.push(
    { id: 'view.select-all', label: '全选', shortcut: '⌘A', separatorBefore: clipboard === null },
    { id: 'view.fit', label: '适应内容', separatorBefore: true },
    { id: 'view.reset', label: '重置视口（100%）' },
    { id: 'view.toggle-snap', label: '网格吸附', checked: scene.grid.snap },
  );
  return items;
};

const nodeMenu = (scene: CanvasScene, id: string): readonly CanvasMenuItem[] => {
  const node = nodeById(scene, id);
  if (node === null) return emptyMenu(scene, null);

  if (node.kind === 'group') {
    return [
      { id: 'node.edit', label: '重命名分组' },
      { id: 'color', label: '颜色', separatorBefore: true, children: colorItems([colorOf(node.meta)]) },
      { id: 'node.ungroup', label: '解组（保留成员）', separatorBefore: true },
      { id: 'node.delete', label: '删除分组（保留成员）', danger: true },
    ];
  }

  const items: CanvasMenuItem[] = [];

  if (node.kind === 'doc') {
    // 主页只留画布：文档的正文、标题、标签、简介一律在浮窗里改
    if (node.docId !== null) {
      items.push({ id: 'node.open-float', label: '打开浮窗', shortcut: '双击', separatorBefore: false });
      items.push({ id: 'node.edit-meta', label: '编辑元数据' });
    }
  } else {
    items.push({ id: 'node.edit', label: '编辑内容', shortcut: '双击' });
  }

  items.push({ id: 'node.duplicate', label: '创建副本', shortcut: '⌘D' });
  items.push({ id: 'node.copy', label: '复制', shortcut: '⌘C' });
  items.push(
    { id: 'node.z.top', label: '置顶', separatorBefore: true },
    { id: 'node.z.up', label: '上移一层' },
    { id: 'node.z.down', label: '下移一层' },
    { id: 'node.z.bottom', label: '置底' },
    {
      id: 'color',
      label: '颜色',
      separatorBefore: true,
      children: colorItems([colorOf(node.meta)]),
    },
  );
  if (node.groupId !== null) {
    items.push({ id: 'node.remove-from-group', label: '从分组移除', separatorBefore: true });
  }
  items.push({ id: 'node.delete', label: '删除', danger: true, separatorBefore: node.groupId === null });
  return items;
};

const selectionMenu = (scene: CanvasScene, ids: readonly string[]): readonly CanvasMenuItem[] => {
  const nodes = scene.nodes.filter((node) => ids.includes(node.id));
  if (nodes.length === 0) return emptyMenu(scene, null);

  const items: CanvasMenuItem[] = [];
  const candidates = nodes.filter((node) => node.kind !== 'group');
  const connectable =
    candidates.length === 2 &&
    !scene.edges.some((edge) => {
      const [first, second] = candidates;
      if (first === undefined || second === undefined) return false;
      return (
        (edge.from === first.id && edge.to === second.id) ||
        (edge.from === second.id && edge.to === first.id)
      );
    });

  if (connectable) items.push({ id: 'edge.connect', label: '连接所选节点' });
  if (candidates.length >= 2) {
    items.push({ id: 'node.group-selection', label: '创建分组', separatorBefore: connectable });
  }
  // 组不支持复制/副本：菜单不放出执行后会被拒绝的条目
  if (nodes.every((node) => node.kind !== 'group')) {
    items.push({ id: 'node.duplicate', label: '创建副本' });
  }
  items.push(
    { id: 'node.copy', label: '复制', shortcut: '⌘C' },
    { id: 'node.z.top', label: '置顶', separatorBefore: true },
    { id: 'node.z.bottom', label: '置底' },
    {
      id: 'color',
      label: '颜色',
      separatorBefore: true,
      children: colorItems(nodes.map((node) => colorOf(node.meta))),
    },
    { id: 'node.delete', label: '删除', danger: true, separatorBefore: true },
  );
  return items;
};

const edgeMenu = (scene: CanvasScene, id: string): readonly CanvasMenuItem[] => {
  const edge = scene.edges.find((item) => item.id === id);
  if (edge === undefined) return emptyMenu(scene, null);

  const reversedExists = scene.edges.some(
    (item) => item.from === edge.to && item.to === edge.from,
  );

  const items: CanvasMenuItem[] = [
    { id: 'edge.edit-label', label: '编辑标签…' },
    { id: 'edge.arrow', label: '箭头', children: [
      { id: 'edge.arrow.none', label: '无箭头', checked: edge.arrow === 'none' },
      { id: 'edge.arrow.end', label: '单向箭头', checked: edge.arrow === 'end' },
      { id: 'edge.arrow.both', label: '双向箭头', checked: edge.arrow === 'both' },
    ] },
  ];
  if (!reversedExists) items.push({ id: 'edge.reverse', label: '反转方向' });
  items.push({ id: 'edge.delete', label: '删除连线', danger: true, separatorBefore: true });
  return items;
};

export const buildCanvasMenu = (input: CanvasMenuInput): readonly CanvasMenuItem[] => {
  const { target } = input;
  switch (target.kind) {
    case 'node':
      return nodeMenu(input.scene, target.id);
    case 'selection':
      return selectionMenu(input.scene, target.ids);
    case 'edge':
      return edgeMenu(input.scene, target.id);
    case 'empty':
    default:
      return emptyMenu(input.scene, input.clipboard);
  }
};
