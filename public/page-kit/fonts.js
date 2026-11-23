/**
 * Font catalog for workbench pages. Every option is either a system stack
 * (no file to ship) or a webfont already licensed and served from
 * /assets/fonts/ (Fraunces, Instrument Sans — both SIL Open Font License).
 *
 * Stored in page JSON as:
 *   page.font            — page-level default (body + titles inherit)
 *   block.data.font      — optional override on a text block only
 * Values are the ids below; unknown ids fall back to "instrument".
 */
export const FONTS = [
  {
    id: 'instrument',
    label: 'Instrument Sans',
    sample: 'Aa 汉字',
    hint: '干净的无衬线，默认正文字体',
    stack: '"Instrument Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif',
    titleStack: '"Fraunces", "Iowan Old Style", Palatino, Georgia, "Noto Serif CJK SC", serif',
  },
  {
    id: 'fraunces',
    label: 'Fraunces',
    sample: 'Aa 汉字',
    hint: '有个性的衬线，整页都用展示体',
    stack: '"Fraunces", "Iowan Old Style", Palatino, Georgia, "Noto Serif CJK SC", serif',
    titleStack: '"Fraunces", "Iowan Old Style", Palatino, Georgia, "Noto Serif CJK SC", serif',
  },
  {
    id: 'system',
    label: '系统默认',
    sample: 'Aa 汉字',
    hint: '跟随访客电脑或手机的界面字体',
    stack: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif',
    titleStack: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif',
  },
  {
    id: 'serif',
    label: '衬线',
    sample: 'Aa 汉字',
    hint: '经典衬线，像印刷纸面',
    stack: 'Georgia, "Iowan Old Style", "Palatino Linotype", Palatino, "Noto Serif CJK SC", "Songti SC", serif',
    titleStack: 'Georgia, "Iowan Old Style", "Palatino Linotype", Palatino, "Noto Serif CJK SC", "Songti SC", serif',
  },
  {
    id: 'mono',
    label: '等宽',
    sample: 'Aa 01',
    hint: '等宽字体，适合代码或笔记感',
    stack: 'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Noto Sans Mono CJK SC", monospace',
    titleStack: 'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Noto Sans Mono CJK SC", monospace',
  },
];

const BY_ID = Object.fromEntries(FONTS.map((font) => [font.id, font]));

export const DEFAULT_FONT = 'instrument';
export const FONT_IDS = FONTS.map((font) => font.id);

export function resolveFont(id) {
  return BY_ID[id] || BY_ID[DEFAULT_FONT];
}

/** Escape a CSS font-family list so it is safe in a style="" attribute. */
export function fontStyle(id, { titles = false } = {}) {
  const font = resolveFont(id);
  const family = titles ? font.titleStack : font.stack;
  return `--pk-sans:${family};--pk-serif:${font.titleStack};font-family:${family}`;
}

export function isFontId(value) {
  return FONT_IDS.includes(value);
}
