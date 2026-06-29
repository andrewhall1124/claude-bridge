// Per-file-type icon: a short monogram/glyph + a category color class.
// Kept within the phosphor palette (amber/grey/white) but differentiated by
// shape so file types are recognizable at a glance.

export interface FIcon {
  glyph: string;
  cls: string; // fi-code | fi-web | fi-data | fi-doc | fi-media | fi-default
}

const BY_EXT: Record<string, FIcon> = {
  ts: { glyph: "TS", cls: "fi-code" },
  tsx: { glyph: "TS", cls: "fi-code" },
  js: { glyph: "JS", cls: "fi-code" },
  jsx: { glyph: "JS", cls: "fi-code" },
  mjs: { glyph: "JS", cls: "fi-code" },
  cjs: { glyph: "JS", cls: "fi-code" },
  py: { glyph: "PY", cls: "fi-code" },
  go: { glyph: "GO", cls: "fi-code" },
  rs: { glyph: "RS", cls: "fi-code" },
  rb: { glyph: "RB", cls: "fi-code" },
  java: { glyph: "JV", cls: "fi-code" },
  kt: { glyph: "KT", cls: "fi-code" },
  c: { glyph: "C", cls: "fi-code" },
  h: { glyph: "H", cls: "fi-code" },
  cpp: { glyph: "C+", cls: "fi-code" },
  cc: { glyph: "C+", cls: "fi-code" },
  hpp: { glyph: "C+", cls: "fi-code" },
  cs: { glyph: "C#", cls: "fi-code" },
  php: { glyph: "PH", cls: "fi-code" },
  swift: { glyph: "SW", cls: "fi-code" },
  sh: { glyph: "SH", cls: "fi-code" },
  bash: { glyph: "SH", cls: "fi-code" },
  zsh: { glyph: "SH", cls: "fi-code" },
  json: { glyph: "{}", cls: "fi-data" },
  jsonc: { glyph: "{}", cls: "fi-data" },
  yml: { glyph: "YA", cls: "fi-data" },
  yaml: { glyph: "YA", cls: "fi-data" },
  toml: { glyph: "TO", cls: "fi-data" },
  ini: { glyph: "INI", cls: "fi-data" },
  conf: { glyph: "CFG", cls: "fi-data" },
  cfg: { glyph: "CFG", cls: "fi-data" },
  xml: { glyph: "<>", cls: "fi-data" },
  lock: { glyph: "⊘", cls: "fi-data" },
  sql: { glyph: "DB", cls: "fi-data" },
  html: { glyph: "<>", cls: "fi-web" },
  htm: { glyph: "<>", cls: "fi-web" },
  css: { glyph: "#", cls: "fi-web" },
  scss: { glyph: "#", cls: "fi-web" },
  sass: { glyph: "#", cls: "fi-web" },
  less: { glyph: "#", cls: "fi-web" },
  svg: { glyph: "▦", cls: "fi-web" },
  vue: { glyph: "V", cls: "fi-web" },
  md: { glyph: "MD", cls: "fi-doc" },
  mdx: { glyph: "MD", cls: "fi-doc" },
  markdown: { glyph: "MD", cls: "fi-doc" },
  txt: { glyph: "¶", cls: "fi-doc" },
  rst: { glyph: "¶", cls: "fi-doc" },
  log: { glyph: "¶", cls: "fi-doc" },
  png: { glyph: "▦", cls: "fi-media" },
  jpg: { glyph: "▦", cls: "fi-media" },
  jpeg: { glyph: "▦", cls: "fi-media" },
  gif: { glyph: "▦", cls: "fi-media" },
  webp: { glyph: "▦", cls: "fi-media" },
  ico: { glyph: "▦", cls: "fi-media" },
};

const BY_NAME: Record<string, FIcon> = {
  dockerfile: { glyph: "DK", cls: "fi-data" },
  makefile: { glyph: "MK", cls: "fi-data" },
  "package.json": { glyph: "{}", cls: "fi-data" },
  "package-lock.json": { glyph: "⊘", cls: "fi-data" },
  ".gitignore": { glyph: "GI", cls: "fi-doc" },
};

export function fileIcon(name: string): FIcon {
  const lower = name.toLowerCase();
  if (BY_NAME[lower]) return BY_NAME[lower]!;
  if (lower.startsWith(".env")) return { glyph: "ENV", cls: "fi-data" };
  const dot = lower.lastIndexOf(".");
  const ext = dot > 0 ? lower.slice(dot + 1) : "";
  return BY_EXT[ext] ?? { glyph: "·", cls: "fi-default" };
}
