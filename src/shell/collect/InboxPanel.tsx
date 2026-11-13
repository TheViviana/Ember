import { useQueryClient } from '@tanstack/react-query';
import { createUlid, unsafeVaultPath } from '#doc-model';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { saveAsset } from '../../data/tauri/asset-port.ts';
import { toErrorText } from '../../kernel/errors.ts';
import { readonlyText } from '../components/readonly-text.ts';
import { isEscTop, useEscLayer } from '../esc-arbiter.ts';
import { useKernel } from '../kernel-provider.tsx';
import styles from './InboxPanel.module.css';

/** CSS Module 索引在 noUncheckedIndexedAccess 下可能为 undefined，提前兜底 */
const DRAGGING_CLASS = styles.dragging ?? '';

export interface PendingImage {
  readonly file: File;
  readonly dataUrl: string;
  readonly assetPath?: string;
  readonly error?: string;
}

interface DraftState {
  readonly title: string;
  readonly body: string;
  readonly tags: string;
  readonly images: readonly PendingImage[];
}

interface Notice {
  readonly tone: 'ok' | 'warn' | 'error';
  readonly text: string;
}

/** 与 src-tauri/src/vault/media.rs::MAX_ASSET_BYTES 保持一致的前端软限 */
const MAX_ASSET_BYTES = 20 * 1024 * 1024;
const FILENAME_MAX = 80;
const INVALID_FILENAME = /[/\\\0-31]/g;

const readAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('FileReader result is not a string'));
        return;
      }
      resolve(reader.result);
    };
    reader.onerror = () => reject(new Error(String(reader.error ?? 'read failed')));
    reader.readAsDataURL(file);
  });

const stemOf = (filename: string): string => {
  const slash = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'));
  const base = slash >= 0 ? filename.slice(slash + 1) : filename;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
};

const sanitizeFilename = (input: string): string => {
  const stripped = input.replace(INVALID_FILENAME, ' ').trim();
  const collapsed = stripped.replace(/\s+/g, ' ').trim();
  const trimmed = collapsed.replace(/^[\s._-]+|[\s._-]+$/g, '');
  const clipped = trimmed.length > FILENAME_MAX ? trimmed.slice(0, FILENAME_MAX).trim() : trimmed;
  if (clipped.length === 0) return createUlid(Date.now()).slice(0, 10);
  return clipped;
};

const deriveTitle = (body: string): string | null => {
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const stripped = line.replace(/^#+\s*/, '').trim();
    if (stripped.length > 0) {
      return stripped.length > FILENAME_MAX ? stripped.slice(0, FILENAME_MAX) : stripped;
    }
  }
  return null;
};

const guessMime = (filename: string): string => {
  const ext = filename.slice(Math.max(0, filename.lastIndexOf('.') + 1)).toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'avif':
      return 'image/avif';
    case 'svg':
      return 'image/svg+xml';
    default:
      return 'image/*';
  }
};

const hasAnyContent = (draft: DraftState): boolean =>
  draft.title.trim().length > 0 || draft.body.trim().length > 0 || draft.images.length > 0;

export interface InboxPanelProps {
  readonly onClose: () => void;
}

/** 快速收集箱：文字 + 多张图片一起保存到 inbox/，壳内草稿 session 状态 */
export const InboxPanel = ({ onClose }: InboxPanelProps): ReactElement => {
  const kernel = useKernel();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState<DraftState>({ title: '', body: '', tags: '', images: [] });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const layerId = `shell-inbox-${Math.random().toString(36).slice(2, 10)}`;
  useEscLayer(layerId, true);

  const readonly = kernel.env.readonlyMode;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !isEscTop(layerId)) return;
      event.preventDefault();
      if (busy) return;
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [busy, layerId, onClose]);

  const addFiles = useCallback(async (files: FileList | File[]): Promise<void> => {
    const accepted: File[] = [];
    const rejected: string[] = [];
    for (const file of files) {
      if (!file.type.startsWith('image/')) {
        rejected.push(`${file.name}（非图片）`);
        continue;
      }
      if (file.size > MAX_ASSET_BYTES) {
        rejected.push(`${file.name}（超过 20 MiB）`);
        continue;
      }
      accepted.push(file);
    }
    if (rejected.length > 0) {
      setNotice({ tone: 'warn', text: `已跳过 ${rejected.join('、')}` });
    }
    if (accepted.length === 0) return;
    const pending: PendingImage[] = [];
    for (const file of accepted) {
      try {
        const dataUrl = await readAsDataUrl(file);
        pending.push({ file, dataUrl });
      } catch (cause) {
        pending.push({ file, dataUrl: '', error: toErrorText(cause) });
      }
    }
    setDraft((prev) => ({ ...prev, images: [...prev.images, ...pending] }));
  }, []);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent): void => {
      const items = event.clipboardData?.items;
      if (!items) return;
      const accepted: File[] = [];
      for (const item of items) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file !== null) accepted.push(file);
        }
      }
      if (accepted.length > 0) {
        event.preventDefault();
        void addFiles(accepted);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addFiles]);

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>): void => {
      event.preventDefault();
      event.currentTarget.classList.remove(DRAGGING_CLASS);
      if (event.dataTransfer.files.length > 0) {
        void addFiles(Array.from(event.dataTransfer.files));
      }
    },
    [addFiles],
  );

  const onDragOver = useCallback((event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.currentTarget.classList.add(DRAGGING_CLASS);
  }, []);

  const onDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>): void => {
    event.currentTarget.classList.remove(DRAGGING_CLASS);
  }, []);

  const save = useCallback(async (): Promise<void> => {
    if (readonly) {
      setNotice({ tone: 'error', text: readonlyText(kernel.env.readonlyReason) });
      return;
    }
    if (!hasAnyContent(draft)) {
      setNotice({ tone: 'warn', text: '请输入内容或添加图片' });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const unsaved = draft.images.filter(
        (img): img is PendingImage & { assetPath?: undefined; error?: undefined } =>
          img.assetPath === undefined && img.error === undefined,
      );
      const savedAssets: PendingImage[] = [];
      let hasFailure = draft.images.some((img) => img.error !== undefined);
      const failureMessages: string[] = [];
      for (const img of unsaved) {
        const mime = img.file.type || guessMime(img.file.name);
        try {
          const result = await saveAsset(img.dataUrl, mime);
          savedAssets.push({ ...img, assetPath: result.path });
        } catch (cause) {
          savedAssets.push({ ...img, error: toErrorText(cause) });
          hasFailure = true;
          failureMessages.push(img.file.name);
        }
      }
      const allImages: PendingImage[] = [
        ...savedAssets,
        ...draft.images.filter((img) => img.assetPath !== undefined || img.error !== undefined),
      ];

      if (hasFailure) {
        const stored = allImages.filter((img) => img.assetPath !== undefined);
        const extra =
          stored.length > 0 ? `。已存图片：${stored.map((img) => img.assetPath).join('、')}` : '';
        setDraft((prev) => ({ ...prev, images: allImages }));
        setNotice({
          tone: 'error',
          text: `图片保存失败：${failureMessages.join('、')}。草稿已保留${extra}`,
        });
        setBusy(false);
        return;
      }

      const imageLines = allImages
        .map((img) => `![${stemOf(img.file.name)}](${img.assetPath})`)
        .join('\n');
      const body = [draft.body.trim(), imageLines].filter((value) => value.length > 0).join('\n\n').trim();
      const frontmatterTags = draft.tags
        .split(',')
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0);
      const title = draft.title.trim() || deriveTitle(draft.body) || '未命名收集';
      const path = unsafeVaultPath(`inbox/${sanitizeFilename(title)}.md`);
      const snapshot = await kernel.docs.create({
        path,
        text: body,
        title,
        tags: frontmatterTags,
        aliases: [],
        intent: 'user',
      });
      setDraft({ title: '', body: '', tags: '', images: [] });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['docs', 'list'] }),
        queryClient.invalidateQueries({ queryKey: ['index'] }),
      ]);
      setNotice({ tone: 'ok', text: `已保存到 ${snapshot.meta.path}` });
    } catch (cause) {
      const stored = draft.images.filter((img) => img.assetPath !== undefined);
      const extra = stored.length > 0 ? `。已存图片：${stored.map((img) => img.assetPath).join('、')}` : '';
      setNotice({
        tone: 'error',
        text: `保存失败：${toErrorText(cause)}。草稿已保留${extra}`,
      });
    } finally {
      setBusy(false);
    }
  }, [draft, kernel, queryClient, readonly]);

  const pendingCount = draft.images.filter(
    (img) => img.assetPath === undefined && img.error === undefined,
  ).length;
  const buttonLabel =
    pendingCount > 0 ? `保存（先存 ${pendingCount} 张图）` : '保存到 inbox';

  return (
    <div
      className={styles.root}
      role="dialog"
      aria-modal="true"
      aria-label="快速收集箱"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <header className={styles.header}>
        <span className={styles.headerIcon}>✎</span>
        <span className={styles.headerTitle}>快速收集箱</span>
        <span className={styles.headerCount}>⌘⇧I</span>
        <button
          type="button"
          className={styles.close}
          aria-label="关闭快速收集箱"
          disabled={busy}
          onClick={onClose}
        >
          ✕
        </button>
      </header>

      <div className={styles.body}>
        <input
          type="text"
          className={styles.title}
          placeholder="标题（可选；留空用正文首行）"
          value={draft.title}
          disabled={busy}
          maxLength={FILENAME_MAX}
          onChange={(event) => {
            setDraft((prev) => ({ ...prev, title: event.target.value }));
          }}
        />
        <textarea
          className={styles.bodyField}
          placeholder="把想法写下来… 也可直接拖图片进这里"
          value={draft.body}
          disabled={busy}
          onChange={(event) => {
            setDraft((prev) => ({ ...prev, body: event.target.value }));
          }}
        />
        <input
          type="text"
          className={styles.tags}
          placeholder="标签，用逗号分隔（可选）"
          value={draft.tags}
          disabled={busy}
          onChange={(event) => {
            setDraft((prev) => ({ ...prev, tags: event.target.value }));
          }}
        />

        <section className={styles.images}>
          <div className={styles.imagesHead}>
            <span className={styles.imagesTitle}>图片</span>
            <button
              type="button"
              className={styles.choose}
              disabled={busy}
              onClick={() => {
                inputRef.current?.click();
              }}
            >
              选择图片…
            </button>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept="image/*"
              className={styles.fileInput}
              disabled={busy}
              onChange={(event) => {
                if (event.target.files !== null) {
                  void addFiles(event.target.files);
                  event.currentTarget.value = '';
                }
              }}
            />
          </div>

          {draft.images.length === 0 ? (
            <p className={styles.empty}>拖进来、从上方选择，或 ⌘V 粘贴剪贴板图片。</p>
          ) : (
            <ul className={styles.imageList}>
              {draft.images.map((img, index) => (
                <li key={`${img.file.name}-${index}`} className={styles.imageItem}>
                  {/* 浏览器内 dataURL 缩略图，非 Next 页面 */}
                  <img src={img.dataUrl} alt={img.file.name} className={styles.imageThumb} />
                  <div className={styles.imageInfo}>
                    <span className={styles.imageName}>{img.file.name}</span>
                    <span className={styles.imageSize}>{(img.file.size / 1024).toFixed(1)} KB</span>
                    {img.assetPath !== undefined ? (
                      <span className={styles.imageStatus}>已存 {img.assetPath}</span>
                    ) : img.error !== undefined ? (
                      <span className={styles.imageError}>失败：{img.error}</span>
                    ) : (
                      <span className={styles.imagePending}>待保存</span>
                    )}
                  </div>
                  <button
                    type="button"
                    className={styles.imageRemove}
                    aria-label={`移除 ${img.file.name}`}
                    disabled={busy}
                    onClick={() => {
                      setDraft((prev) => ({
                        ...prev,
                        images: prev.images.filter((_, idx) => idx !== index),
                      }));
                    }}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {notice === null ? null : (
        <p className={`${styles.notice} ${styles[`notice_${notice.tone}`] ?? ''}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
          {notice.text}
        </p>
      )}

      <footer className={styles.footer}>
        {readonly ? (
          <span className={styles.readonly}>{readonlyText(kernel.env.readonlyReason)}</span>
        ) : null}
        <button
          type="button"
          className={styles.button}
          disabled={busy || readonly}
          onClick={onClose}
        >
          关闭
        </button>
        <button
          type="button"
          className={styles.primary}
          disabled={busy || readonly || !hasAnyContent(draft)}
          title={readonly ? readonlyText(kernel.env.readonlyReason) : undefined}
          onClick={() => {
            void save();
          }}
        >
          {busy ? '保存中…' : buttonLabel}
        </button>
      </footer>
    </div>
  );
};
