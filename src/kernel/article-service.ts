import type { CanvasNode, CanvasPoint, CanvasScene } from '#canvas-engine';
import type { CanvasId, VaultPath } from '#doc-model';
import { safeFileName, unsafeVaultPath } from '#doc-model';
import type { CanvasHost } from './canvas-host.ts';
import type { DocService } from './doc-service.ts';
import { EmberError, isEmberError, toErrorText } from './errors.ts';
import type { DocSnapshot } from './types.ts';

/** 新文章统一落在 notes/ 下（vault-format 的用户文档目录） */
const ARTICLE_DIR = 'notes';
const UNTITLED = '未命名文章';
const MAX_NAME_ATTEMPTS = 50;
const NAME_MAX = 80;

export interface CreateArticleInput {
  readonly docs: DocService;
  readonly canvas: CanvasHost;
  readonly canvasId: CanvasId;
  readonly title: string;
  /** 节点左上角（世界坐标，调用方已吸附网格） */
  readonly point: CanvasPoint;
  readonly nodeId: string;
  readonly size: { readonly w: number; readonly h: number };
  readonly z: number;
}

export interface CreateArticleResult {
  readonly snapshot: DocSnapshot;
  readonly scene: CanvasScene;
}

const candidatePath = (name: string, attempt: number): VaultPath =>
  unsafeVaultPath(`${ARTICLE_DIR}/${attempt === 1 ? name : `${name}-${attempt}`}.md`);

/**
 * 一步新建文章：落盘 .md → 建文档节点。
 * 画布写失败时把刚建的文件移入 .workbench/trash/（复用 docs.remove），失败则报出磁盘路径。
 */
export const createArticleOnCanvas = async (
  input: CreateArticleInput,
): Promise<CreateArticleResult> => {
  const name = safeFileName(input.title, { fallback: UNTITLED, maxLength: NAME_MAX });

  let snapshot: DocSnapshot | null = null;
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS && snapshot === null; attempt += 1) {
    try {
      snapshot = await input.docs.create({
        path: candidatePath(name, attempt),
        text: '',
        title: name,
        intent: 'user',
      });
    } catch (error) {
      if (isEmberError(error) && error.code === 'path_exists') continue;
      throw error;
    }
  }
  if (snapshot === null) {
    throw new EmberError('path_exists', `无法为「${name}」找到可用文件名`);
  }

  const created = snapshot;
  const node: CanvasNode = {
    id: input.nodeId,
    kind: 'doc',
    docId: created.meta.id,
    text: null,
    rect: { x: input.point.x, y: input.point.y, w: input.size.w, h: input.size.h },
    z: input.z,
    groupId: null,
    meta: {},
  };

  try {
    const scene = await input.canvas.apply(input.canvasId, [{ type: 'addNode', node }]);
    return { snapshot: created, scene };
  } catch (canvasError) {
    const path = String(created.meta.path);
    try {
      await input.docs.remove(created.meta.id, { base: created.meta.rev, intent: 'user' });
    } catch (rollbackError) {
      throw new EmberError(
        'io_failed',
        `画布写入失败且回滚失败。文章仍在磁盘：${path}；目标回收目录：.workbench/trash/（回滚原因：${toErrorText(rollbackError)}；画布原因：${toErrorText(canvasError)}）`,
        { path, rolledBack: false },
      );
    }
    throw new EmberError(
      'io_failed',
      `画布写入失败，已回滚并移入 .workbench/trash/：${path}（原因：${toErrorText(canvasError)}）`,
      { path, rolledBack: true },
    );
  }
};
