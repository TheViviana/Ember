import { useState, type ReactElement } from 'react';
import { toErrorText } from '../../kernel/errors.ts';
import { validateFolderName } from '../../kernel/folder-service.ts';
import styles from './DocumentListPanel.module.css';

export interface FolderCreateRowProps {
  /** 父目录：空串表示库根 */
  readonly parent: string;
  readonly disabled: boolean;
  readonly onCancel: () => void;
  /** 返回 null 表示成功；返回文案表示失败并由本行展示 */
  readonly onSubmit: (name: string) => Promise<string | null>;
}

const validate = (name: string): string | null => {
  try {
    validateFolderName(name);
    return null;
  } catch (cause) {
    return toErrorText(cause);
  }
};

/**
 * 新建文件夹的内联输入行：输入即时跑与内核同一套命名校验，
 * Enter 提交、Esc 取消；服务层与后端仍会各自再校验一遍。
 */
export const FolderCreateRow = ({
  parent,
  disabled,
  onCancel,
  onSubmit,
}: FolderCreateRowProps): ReactElement => {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const validation = name.length === 0 ? null : validate(name);

  const submit = (): void => {
    if (disabled || busy) return;
    if (name.length === 0) {
      setError('文件夹名称不能为空');
      return;
    }
    if (validation !== null) {
      setError(validation);
      return;
    }
    setBusy(true);
    setError(null);
    void onSubmit(name).then((message) => {
      setBusy(false);
      if (message !== null) setError(message);
    });
  };

  return (
    <div className={styles.createRow}>
      <span className={styles.createHint}>在 {parent.length === 0 ? '库根' : parent} 下新建文件夹</span>
      <div className={styles.createInputRow}>
        <input
          className={styles.createInput}
          autoFocus
          placeholder="文件夹名称"
          value={name}
          disabled={disabled || busy}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submit();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              onCancel();
            }
          }}
        />
        <button
          type="button"
          className={styles.createSubmit}
          disabled={disabled || busy || name.length === 0 || validation !== null}
          onClick={submit}
        >
          {busy ? '创建中…' : '创建'}
        </button>
        <button type="button" className={styles.createCancel} disabled={busy} onClick={onCancel}>
          取消
        </button>
      </div>
      {error === null && validation === null ? null : (
        <p className={styles.createError}>{error ?? validation}</p>
      )}
    </div>
  );
};
