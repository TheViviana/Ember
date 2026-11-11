import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import type { DocId } from '#doc-model';
import type { CommandDescriptor } from '../../kernel/types.ts';
import { isEscTop, useEscLayer } from '../esc-arbiter.ts';
import { useKernel } from '../kernel-provider.tsx';
import { editorArgsFor, filterCommands, scopeLabel } from './palette.ts';
import styles from './CommandPalette.module.css';

export interface CommandPaletteProps {
  readonly commands: readonly CommandDescriptor[];
  readonly activeDocId: DocId | null;
  readonly onClose: () => void;
}

/** ⌘K 命令面板：列表与执行都走 kernel.commands，编辑器命令由调用方补 docId 参数 */
export const CommandPalette = ({
  commands,
  activeDocId,
  onClose,
}: CommandPaletteProps): ReactElement => {
  const kernel = useKernel();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const visible = useMemo(() => filterCommands(commands, query), [commands, query]);
  const activeIndex = visible.length === 0 ? 0 : Math.min(index, visible.length - 1);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    itemRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const run = async (command: CommandDescriptor): Promise<void> => {
    if (running) return;
    const args = command.scope === 'editor' ? editorArgsFor(activeDocId) : undefined;
    if (command.scope === 'editor' && args === null) {
      setError('先打开一篇文档，再执行这条命令');
      return;
    }
    setRunning(true);
    setError(null);
    const result = await kernel.commands.execute(command.id, args ?? undefined);
    setRunning(false);
    if (result.ok) {
      onClose();
      return;
    }
    setError(result.error ?? '命令执行失败');
  };

  useEscLayer('palette', true);

  // Esc 统一仲裁走 window 级：聚焦在列表按钮上时输入框的 onKeyDown 收不到
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (!isEscTop('palette')) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    // IME 组合态的方向键/回车是选词操作，不移动选中项、不执行命令
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (visible.length > 0) setIndex((activeIndex + 1) % visible.length);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (visible.length > 0) setIndex((activeIndex + visible.length - 1) % visible.length);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const command = visible[activeIndex];
      if (command !== undefined) void run(command);
    }
  };

  return (
    <div
      className={styles.scrim}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={styles.palette} role="dialog" aria-modal="true" aria-label="命令面板">
        <input
          ref={inputRef}
          className={styles.input}
          value={query}
          placeholder="搜索命令…"
          aria-label="搜索命令"
          role="combobox"
          aria-expanded="true"
          aria-controls="command-palette-list"
          aria-activedescendant={visible[activeIndex] === undefined ? undefined : `command-${String(visible[activeIndex].id)}`}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setIndex(0);
            setError(null);
          }}
          onKeyDown={onKeyDown}
        />
        {visible.length === 0 ? (
          <p className={styles.empty}>没有匹配的命令</p>
        ) : (
          <ul className={styles.list} id="command-palette-list" role="listbox" aria-label="可执行命令">
            {visible.map((command, position) => (
              <li key={String(command.id)}>
                <button
                  ref={(node) => {
                    itemRefs.current[position] = node;
                  }}
                  id={`command-${String(command.id)}`}
                  type="button"
                  role="option"
                  aria-selected={position === activeIndex}
                  className={position === activeIndex ? `${styles.item} ${styles.itemActive}` : styles.item}
                  onMouseEnter={() => {
                    setIndex(position);
                  }}
                  onClick={() => {
                    void run(command);
                  }}
                >
                  <span className={styles.itemTitle}>{command.title}</span>
                  <span className={styles.itemMeta}>
                    <span className={styles.scope}>{scopeLabel(command.scope)}</span>
                    <span className={styles.id}>{String(command.id)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {error !== null ? <p className={styles.error}>{error}</p> : null}
        <footer className={styles.foot}>↑↓ 选择 · Enter 执行 · Esc 关闭 · ⌘K 开关面板</footer>
      </div>
    </div>
  );
};
