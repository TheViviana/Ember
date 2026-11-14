import type { ContentHash, VaultPath } from '#doc-model';
import { parseCanvasDocument } from '#canvas-engine';
import { hashBytes, isUtf8, parseDocText, utcNow } from './doc-text.ts';
import { EmberError, toErrorText } from './errors.ts';
import type { DocServiceInternal } from './doc-service.ts';
import type { PathTools } from './paths.ts';
import type { VaultPort, VaultScanEntry } from './ports.ts';
import type { HealthIssue, HealthReport, Logger } from './types.ts';

export interface HealthService {
  /** 只读扫描；全程不写盘 */
  scan(): Promise<HealthReport>;
  /** 校验 hash 与目标不存在后改名，再 docs.refresh()；不改文件内容 */
  renameMarkdown(path: VaultPath, expectedHash: ContentHash): Promise<VaultPath>;
}

export interface HealthServiceOptions {
  readonly port: VaultPort;
  readonly paths: PathTools;
  readonly docs: DocServiceInternal;
  readonly log: Logger;
  readonly now?: () => Date;
}

const decoder = new TextDecoder('utf-8', { fatal: false });
/** 与 Rust `MAX_VAULT_READ_BYTES` 一致：超过即不读取 */
const READ_LIMIT = 32 * 1024 * 1024;
const CANVAS_SLOTS = 5;
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^)\s]+))(?:\s+["'][^"']*["'])?\s*\)/g;
const WIKI_EMBED = /!\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;

const isWorkbench = (path: VaultPath | string): boolean => String(path).startsWith('.workbench/');
const isMarkdownDoc = (path: VaultPath | string): boolean =>
  String(path).toLowerCase().endsWith('.md');

export const createHealthService = (options: HealthServiceOptions): HealthService => {
  const { port, paths, docs, log } = options;
  const now = options.now ?? ((): Date => new Date());

  const issue = (
    kind: HealthIssue['kind'],
    path: VaultPath,
    detail: string,
    extra: Partial<Pick<HealthIssue, 'target' | 'hash' | 'fix'>> = {},
  ): HealthIssue => ({
    kind,
    path,
    target: extra.target ?? null,
    detail,
    hash: extra.hash ?? null,
    fix: extra.fix ?? null,
  });

  /** 受限读取：超限返回 undefined（不读），文件消失返回 null */
  const readLimited = async (
    path: VaultPath,
    size: number,
  ): Promise<Uint8Array | null | undefined> => {
    if (size > READ_LIMIT) return undefined;
    return port.read(path);
  };

  const checkCanvasJson = async (
    entry: VaultScanEntry,
    kind: 'broken_canvas' | 'broken_history',
    label: string,
    issues: HealthIssue[],
  ): Promise<void> => {
    const path = entry.path;
    if (entry.size > READ_LIMIT) {
      issues.push(issue(kind, path, `${label} 超过 32 MiB，未读取`));
      return;
    }
    const bytes = await port.read(path);
    if (bytes === null) return;
    if (!isUtf8(bytes)) {
      issues.push(issue(kind, path, `${label} 不是合法 UTF-8`));
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(decoder.decode(bytes));
    } catch (error) {
      issues.push(issue(kind, path, `${label} JSON 解析失败：${String(error)}`));
      return;
    }
    const parsed = parseCanvasDocument(raw);
    if (parsed.document === null) {
      issues.push(
        issue(kind, path, `${label} 结构不合法：${parsed.issues.map((item) => item.code).join(', ')}`),
      );
    }
  };

  const checkWorkbench = async (entry: VaultScanEntry, issues: HealthIssue[]): Promise<void> => {
    const path = String(entry.path);
    if (/^\.workbench\/canvas\/[^/]+\.json$/.test(path)) {
      await checkCanvasJson(entry, 'broken_canvas', `画布 ${path}`, issues);
      return;
    }
    const historyMatch = /^\.workbench\/history\/([^/]+)\.(\d+)\.json$/.exec(path);
    if (historyMatch !== null) {
      const slot = Number(historyMatch[2]);
      if (slot < 1 || slot > CANVAS_SLOTS) {
        issues.push(issue('broken_history', entry.path, `画布历史槽位超出 1..${CANVAS_SLOTS}`));
        return;
      }
      await checkCanvasJson(entry, 'broken_history', `画布历史 ${path}`, issues);
    }
    // 文档历史已迁到库外（`vaults/<key>/history/`）；库内 `.workbench/history/documents`
    // 只剩旧版本遗留的桶（D6：原样保留），不再参与健康检查。
  };

  /** 只接受库内 `media/` 相对路径；外链与越界路径不检查 */
  const mediaPathOf = (raw: string): VaultPath | null => {
    let value = raw.trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) return null;
    value = value.replace(/^\.\//, '').replace(/^\/+/, '');
    if (!value.startsWith('media/')) return null;
    if (value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
      return null;
    }
    try {
      return paths.normalize(value);
    } catch (error) {
      log.error('健康检查：媒体路径归一化失败，跳过该引用', { path: raw, error: toErrorText(error) });
      return null;
    }
  };

  const checkAssets = async (path: VaultPath, body: string, issues: HealthIssue[]): Promise<void> => {
    const targets = new Set<string>();
    for (const match of body.matchAll(MARKDOWN_IMAGE)) {
      const raw = match[1] ?? match[2] ?? '';
      const media = mediaPathOf(raw);
      if (media !== null) targets.add(String(media));
    }
    for (const match of body.matchAll(WIKI_EMBED)) {
      const media = mediaPathOf(match[1] ?? '');
      if (media !== null) targets.add(String(media));
    }
    for (const target of targets) {
      const media = paths.normalize(target);
      if ((await port.stat(media)) === null) {
        issues.push(
          issue('broken_asset', path, `图片资源不存在：${target}`, { target: media }),
        );
      }
    }
  };

  const scan = async (): Promise<HealthReport> => {
    const inventory = await port.scan();
    const issues: HealthIssue[] = [];
    const inventoryPaths = new Set(inventory.map((entry) => String(entry.path)));
    let documents = 0;

    for (const entry of inventory) {
      if (entry.kind === 'symlink') {
        issues.push(
          issue('symlink', entry.path, '符号链接不跟随，未读取目标内容'),
        );
        continue;
      }
      if (isWorkbench(entry.path)) {
        await checkWorkbench(entry, issues);
        continue;
      }
      const extension = paths.ext(entry.path).toLowerCase();
      if (extension === '.markdown') {
        const target = paths.normalize(String(entry.path).replace(/\.markdown$/i, '.md'));
        const occupied = inventoryPaths.has(String(target));
        const bytes = await readLimited(entry.path, entry.size);
        const hash = bytes === undefined || bytes === null ? null : await hashBytes(bytes);
        issues.push(
          issue(
            'markdown_extension',
            entry.path,
            occupied
              ? `扩展名为 .markdown，目标 ${String(target)} 已存在，未改名`
              : '扩展名为 .markdown，不会被文档索引收录',
            { hash, fix: hash !== null && !occupied ? 'rename-markdown' : null },
          ),
        );
        continue;
      }
      if (!isMarkdownDoc(entry.path)) continue;

      documents += 1;
      if (entry.size > READ_LIMIT) {
        issues.push(issue('oversize', entry.path, '文件超过 32 MiB，已跳过读取'));
        continue;
      }
      const bytes = await port.read(entry.path);
      if (bytes === null) continue;
      const hash = await hashBytes(bytes);
      if (!isUtf8(bytes)) {
        issues.push(issue('non_utf8', entry.path, '文件不是合法 UTF-8', { hash }));
        continue;
      }
      const parsed = parseDocText(decoder.decode(bytes));
      if (parsed.frontmatterBroken) {
        issues.push(
          issue('broken_frontmatter', entry.path, 'frontmatter YAML 无法解析，只报告不修复', { hash }),
        );
        continue;
      }
      await checkAssets(entry.path, parsed.body, issues);
    }

    return {
      scannedAt: utcNow(now()),
      documents,
      issues,
    };
  };

  return {
    scan,

    renameMarkdown: async (path, expectedHash) => {
      if (port.readonlyMode) {
        throw new EmberError('vault_locked', '库为只读，改名操作被拒绝', {
          reason: port.readonlyReason,
        });
      }
      if (paths.ext(path).toLowerCase() !== '.markdown') {
        throw new EmberError('invalid_payload', `只有 .markdown 文件可以改名：${String(path)}`);
      }
      const bytes = await port.read(path);
      if (bytes === null) throw new EmberError('doc_not_found', `文件已消失：${String(path)}`);
      const diskHash = await hashBytes(bytes);
      if (diskHash !== expectedHash) {
        throw new EmberError('stale_revision', '文件在扫描后已变化，请重新检查', {
          path: String(path),
        });
      }
      const target = paths.normalize(String(path).replace(/\.markdown$/i, '.md'));
      if ((await port.stat(target)) !== null) {
        throw new EmberError('path_exists', `目标已存在，不覆盖：${String(target)}`);
      }
      await port.rename(path, target);
      await docs.refresh();
      return target;
    },
  };
};
