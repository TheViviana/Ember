import { useEffect, useRef, useState, type ReactElement } from 'react';
import styles from './FloatTagBar.module.css';

export interface FloatTagBarProps {
  readonly tags: readonly string[];
  /** 全库已有标签，供「+」输入时筛选 */
  readonly knownTags: readonly string[];
  readonly summary: string;
  /** 简介是否来自 frontmatter（false = 正文派生，编辑前不落盘） */
  readonly hasSummary: boolean;
  readonly onTagsChange: (tags: readonly string[]) => void;
  readonly onSummaryCommit: (value: string) => void;
  /** AI 一键简介：null = 当前不可用（只读 / 未配置模型） */
  readonly onAiSummary: (() => void) | null;
  readonly aiSummaryBusy: boolean;
  /** AI 简介的失败提示；null = 无 */
  readonly aiSummaryError: string | null;
}

const normalizeTag = (value: string): string => value.trim().replace(/^#/, '');

const dedupe = (tags: readonly string[]): readonly string[] => {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const tag of tags) {
    if (tag.length === 0 || seen.has(tag)) continue;
    seen.add(tag);
    next.push(tag);
  }
  return next;
};

/**
 * 标签栏：标签为胶囊，点击原地编辑/删除；末尾「+」输入即筛选全库已有标签，也可直接新建。
 * 简介放在同一块的次要行里展开，不新增第四段。
 */
export const FloatTagBar = ({
  tags,
  knownTags,
  summary,
  hasSummary,
  onTagsChange,
  onSummaryCommit,
  onAiSummary,
  aiSummaryBusy,
  aiSummaryError,
}: FloatTagBarProps): ReactElement => {
  const zoneRef = useRef<HTMLElement | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [tagDraft, setTagDraft] = useState('');
  const editSettled = useRef(false);
  const [adding, setAdding] = useState(false);
  const [addDraft, setAddDraft] = useState('');
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState(summary);

  useEffect(() => {
    setSummaryDraft(summary);
  }, [summary]);

  const finishEdit = (index: number, commit: boolean, remove: boolean): void => {
    if (editSettled.current) return;
    editSettled.current = true;
    setEditingIndex(null);
    if (!commit) return;
    const value = normalizeTag(tagDraft);
    const next = [...tags];
    if (remove || value.length === 0) next.splice(index, 1);
    else next[index] = value;
    onTagsChange(dedupe(next));
  };

  const addTag = (raw: string): void => {
    const value = normalizeTag(raw);
    setAdding(false);
    setAddDraft('');
    if (value.length === 0) return;
    onTagsChange(dedupe([...tags, value]));
  };

  const commitSummary = (): void => {
    if (summaryDraft.trim() === summary.trim()) return;
    onSummaryCommit(summaryDraft.trim());
  };

  const typed = normalizeTag(addDraft).toLowerCase();
  const suggestions = knownTags
    .filter((tag) => !tags.includes(tag))
    .filter((tag) => typed.length === 0 || tag.toLowerCase().includes(typed))
    .slice(0, 8);

  return (
    <section
      ref={zoneRef}
      className={styles.zone}
      aria-label="标签与简介"
      onBlur={(event) => {
        const next = event.relatedTarget;
        const inside = next instanceof Node && zoneRef.current !== null && zoneRef.current.contains(next);
        if (!inside) setAdding(false);
      }}
    >
      <div className={styles.headerRow}>
        <div className={styles.tagList}>
          {tags.length === 0 ? <span className={styles.empty}>无标签</span> : null}

          {tags.map((tag, index) =>
            editingIndex === index ? (
              <span className={styles.editor} key={`edit-${String(index)}`}>
                <input
                  className={styles.tagInput}
                  value={tagDraft}
                  size={Math.max(4, Math.min(24, tagDraft.length + 1))}
                  aria-label="编辑标签"
                  autoFocus
                  onChange={(event) => {
                    setTagDraft(event.target.value);
                  }}
                  onBlur={() => {
                    finishEdit(index, true, false);
                  }}
                  onKeyDown={(event) => {
                    // IME 组合态的 Enter/Esc 是选词操作，不提交标签
                    if (event.nativeEvent.isComposing) return;
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      finishEdit(index, true, false);
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      finishEdit(index, false, false);
                    } else if (event.key === 'Backspace' && tagDraft.length === 0) {
                      event.preventDefault();
                      finishEdit(index, true, true);
                    }
                  }}
                />
                <button
                  type="button"
                  className={styles.remove}
                  aria-label={`删除标签 ${tag}`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                  }}
                  onClick={() => {
                    finishEdit(index, true, true);
                  }}
                >
                  ×
                </button>
              </span>
            ) : (
              <button
                type="button"
                className={styles.pill}
                key={`tag-${tag}-${String(index)}`}
                title={tag}
                onClick={() => {
                  editSettled.current = false;
                  setTagDraft(tag);
                  setEditingIndex(index);
                }}
              >
                {tag}
              </button>
            ),
          )}

          {adding ? (
            <input
              className={styles.tagInput}
              value={addDraft}
              size={Math.max(6, Math.min(24, addDraft.length + 1))}
              aria-label="新建或筛选标签"
              placeholder="标签"
              autoFocus
              onChange={(event) => {
                setAddDraft(event.target.value);
              }}
              onKeyDown={(event) => {
                // IME 组合态的 Enter/Esc 是选词操作，不提交/关闭
                if (event.nativeEvent.isComposing) return;
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addTag(addDraft);
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setAdding(false);
                  setAddDraft('');
                }
              }}
            />
          ) : (
            <button
              type="button"
              className={styles.add}
              aria-label="添加标签"
              onClick={() => {
                setAddDraft('');
                setAdding(true);
              }}
            >
              +
            </button>
          )}
        </div>

        <div className={styles.summaryActions}>
          {onAiSummary === null ? null : (
            <button
              type="button"
              className={styles.summaryToggle}
              disabled={aiSummaryBusy}
              title="AI 依据正文生成 80 字以内简介并写入 frontmatter"
              onClick={() => {
                setSummaryOpen(true);
                onAiSummary();
              }}
            >
              {aiSummaryBusy ? '生成中…' : '✦ AI 简介'}
            </button>
          )}
          <button
            type="button"
            className={styles.summaryToggle}
            aria-expanded={summaryOpen}
            onClick={() => {
              setSummaryOpen((open) => !open);
            }}
          >
            {summaryOpen ? '收起简介' : '简介'}
          </button>
        </div>
      </div>

      {adding && suggestions.length > 0 ? (
        <div className={styles.suggestions}>
          {suggestions.map((tag) => (
            <button
              type="button"
              className={styles.suggestion}
              key={`suggest-${tag}`}
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => {
                addTag(tag);
              }}
            >
              {tag}
            </button>
          ))}
        </div>
      ) : null}

      {summaryOpen ? (
        <div className={styles.summaryWrap}>
          <textarea
            className={styles.summaryInput}
            value={summaryDraft}
            rows={2}
            aria-label="文章简介"
            placeholder="留空则显示正文首段"
            onChange={(event) => {
              setSummaryDraft(event.target.value);
            }}
            onBlur={commitSummary}
          />
          <p className={styles.hint}>
            {aiSummaryError !== null
              ? aiSummaryError
              : hasSummary
                ? '简介写入 frontmatter.summary'
                : '简介来自正文首段派生，未写入磁盘；编辑后才会落盘'}
          </p>
        </div>
      ) : null}
    </section>
  );
};
