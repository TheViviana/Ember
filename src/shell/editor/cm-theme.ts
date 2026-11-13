import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { colors, fonts, fontSize, overlay, radius, space } from '../theme/tokens.ts';

/**
 * CodeMirror 主题：所有颜色/字号/间距都取自 tokens.ts（与 tokens.css 同源）。
 * 这里只写 token 引用，不新增品牌值。
 */
export const emberEditorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      color: colors.textPrimary,
      backgroundColor: colors.bgBase,
      fontFamily: fonts.mono,
      fontSize: fontSize.base,
    },
    '.cm-scroller': {
      fontFamily: fonts.mono,
      lineHeight: '1.7',
    },
    '.cm-content': {
      // 两侧留白随浮窗宽度伸缩：窄窗收窄（不挤压正文），宽窗回到常规留白
      padding: `${space.lg} clamp(${space.sm}, 4%, ${space.xl})`,
      caretColor: colors.primary,
    },
    '.cm-line': {
      padding: '0',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: colors.primary,
      borderLeftWidth: '2px',
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: colors.primaryTintStrong,
    },
    '.cm-gutters': {
      backgroundColor: colors.bgBase,
      color: colors.textMuted,
      border: 'none',
      paddingRight: space.sm,
    },
    '.cm-lineNumbers .cm-gutterElement': {
      padding: `0 ${space.sm} 0 ${space.md}`,
      minWidth: '32px',
    },
    '.cm-activeLine': {
      backgroundColor: colors.primaryTintWeak,
    },
    '.cm-activeLineGutter': {
      backgroundColor: colors.primaryTintSoft,
      color: colors.textAccent,
    },
    '.cm-selectionMatch': {
      backgroundColor: colors.primaryTintSoft,
    },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
      backgroundColor: colors.primaryTintStrong,
      outline: `1px solid ${colors.borderStrong}`,
    },
    '.cm-foldPlaceholder': {
      backgroundColor: colors.bgElevated,
      border: `1px solid ${colors.border}`,
      borderRadius: radius.sm,
      color: colors.textMuted,
    },
    '.cm-placeholder': {
      color: colors.textMuted,
    },
    // `/` 命令菜单：与工具浮层同一套菜单配色
    '.cm-tooltip': {
      border: `1px solid ${colors.border}`,
      borderRadius: radius.md,
      backgroundColor: overlay.menuBg,
      boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
      color: colors.textPrimary,
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul': {
      maxHeight: '260px',
      padding: `${space.xs}`,
      fontFamily: fonts.body,
      fontSize: fontSize.sm,
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
      padding: `${space.xs} ${space.sm}`,
      borderRadius: radius.sm,
      color: colors.textSecondary,
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: colors.bgHover,
      color: colors.textPrimary,
    },
    '.cm-completionDetail': {
      marginLeft: space.sm,
      color: colors.textMuted,
      fontStyle: 'normal',
      fontSize: fontSize.xs,
    },
    '.ember-wikilink': {
      color: colors.textAccent,
      textDecoration: 'underline',
      textUnderlineOffset: '2px',
      textDecorationColor: colors.borderGlow,
    },
  },
  { dark: true },
);

export const emberHighlightStyle = HighlightStyle.define([
  { tag: tags.heading1, color: colors.textPrimary, fontWeight: '600', fontSize: '1.5em' },
  { tag: tags.heading2, color: colors.textPrimary, fontWeight: '600', fontSize: '1.3em' },
  { tag: tags.heading3, color: colors.textPrimary, fontWeight: '600', fontSize: '1.15em' },
  { tag: [tags.heading4, tags.heading5, tags.heading6], color: colors.textSecondary, fontWeight: '600' },
  { tag: tags.strong, color: colors.textPrimary, fontWeight: '600' },
  { tag: tags.emphasis, color: colors.textSecondary, fontStyle: 'italic' },
  { tag: tags.strikethrough, color: colors.textMuted, textDecoration: 'line-through' },
  { tag: tags.link, color: colors.textAccent, textDecoration: 'underline' },
  { tag: tags.url, color: colors.textMuted },
  { tag: tags.monospace, color: colors.success, fontFamily: fonts.mono },
  { tag: tags.quote, color: colors.textSecondary, fontStyle: 'italic' },
  { tag: tags.list, color: colors.textAccent },
  { tag: [tags.keyword, tags.atom, tags.bool, tags.number], color: colors.secondary },
  { tag: tags.comment, color: colors.textMuted },
  { tag: tags.invalid, color: colors.danger },
]);

export const emberEditorThemeExtensions = [emberEditorTheme, syntaxHighlighting(emberHighlightStyle)];
