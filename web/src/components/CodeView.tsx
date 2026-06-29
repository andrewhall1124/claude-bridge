import { useEffect, useMemo, useRef } from "react";

// Heuristic, language-agnostic tokenizer for syntax highlighting + a clickable
// symbol layer. Not a real parser — good enough for the common C-family / JS /
// Python / shell cases to color tokens and make identifiers interactive.

type TokType = "id" | "kw" | "str" | "com" | "num" | "punct" | "ws";
interface Tok {
  t: TokType;
  v: string;
}

const KEYWORDS = new Set([
  // JS/TS
  "const","let","var","function","return","if","else","for","while","do","switch","case",
  "break","continue","new","class","extends","super","this","typeof","instanceof","in","of",
  "import","from","export","default","async","await","yield","try","catch","finally","throw",
  "interface","type","enum","implements","public","private","protected","readonly","static",
  "abstract","as","is","keyof","namespace","declare","void","null","undefined","true","false",
  "boolean","number","string","any","unknown","never","object",
  // python
  "def","elif","except","lambda","pass","raise","with","global","nonlocal","and","or","not",
  "None","True","False","self","print","del","assert","yield",
  // go / rust / c-family extras
  "func","struct","map","chan","go","defer","fn","let","mut","impl","trait","pub","use","mod",
  "match","where","unsafe","int","float","double","char","bool","long","short","unsigned",
  "package","nil","range","select","var",
]);

const isIdStart = (c: string) => /[A-Za-z_$]/.test(c);
const isIdChar = (c: string) => /[A-Za-z0-9_$]/.test(c);

const HASH_LANGS = new Set([
  "py","rb","sh","bash","zsh","yml","yaml","toml","conf","cfg","ini","env","r","pl","ex",
]);
const NO_SLASH_LANGS = new Set(["py","rb","sh","bash","zsh","yml","yaml","toml"]);

function tokenize(text: string, ext: string): Tok[][] {
  const hash = HASH_LANGS.has(ext);
  const slash = !NO_SLASH_LANGS.has(ext);
  const lines: Tok[][] = [];
  let cur: Tok[] = [];
  const emit = (t: TokType, s: string) => {
    const parts = s.split("\n");
    for (let k = 0; k < parts.length; k++) {
      if (k > 0) {
        lines.push(cur);
        cur = [];
      }
      if (parts[k] !== "") cur.push({ t, v: parts[k]! });
    }
  };

  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i]!;
    // block comment
    if (c === "/" && text[i + 1] === "*") {
      let j = text.indexOf("*/", i + 2);
      j = j < 0 ? n : j + 2;
      emit("com", text.slice(i, j));
      i = j;
      continue;
    }
    // line comment //
    if (slash && c === "/" && text[i + 1] === "/") {
      let j = text.indexOf("\n", i);
      if (j < 0) j = n;
      emit("com", text.slice(i, j));
      i = j;
      continue;
    }
    // line comment #
    if (hash && c === "#") {
      let j = text.indexOf("\n", i);
      if (j < 0) j = n;
      emit("com", text.slice(i, j));
      i = j;
      continue;
    }
    // strings
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      let j = i + 1;
      while (j < n) {
        const d = text[j]!;
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === q) {
          j++;
          break;
        }
        if (d === "\n" && q !== "`") break; // unterminated single/double quote
        j++;
      }
      emit("str", text.slice(i, j));
      i = j;
      continue;
    }
    // number
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(text[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < n && /[0-9a-fA-FxXoObB._]/.test(text[j]!)) j++;
      emit("num", text.slice(i, j));
      i = j;
      continue;
    }
    // identifier / keyword
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdChar(text[j]!)) j++;
      const word = text.slice(i, j);
      emit(KEYWORDS.has(word) ? "kw" : "id", word);
      i = j;
      continue;
    }
    // whitespace (incl. newlines)
    if (/\s/.test(c)) {
      let j = i + 1;
      while (j < n && /\s/.test(text[j]!)) j++;
      emit("ws", text.slice(i, j));
      i = j;
      continue;
    }
    // punctuation / operators (run of non-id, non-space, non-quote chars)
    {
      let j = i + 1;
      while (
        j < n &&
        !isIdStart(text[j]!) &&
        !/\s/.test(text[j]!) &&
        !/[0-9'"`]/.test(text[j]!) &&
        !(text[j] === "/" && (text[j + 1] === "/" || text[j + 1] === "*"))
      )
        j++;
      emit("punct", text.slice(i, j));
      i = j;
      continue;
    }
  }
  lines.push(cur);
  return lines;
}

function extOf(name: string): string {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot > 0 ? lower.slice(dot + 1) : "";
}

const MAX_INTERACTIVE_LINES = 4000;

interface Props {
  content: string;
  filename: string;
  onFindReferences: (symbol: string) => void;
  highlightLine?: number | null;
}

export function CodeView({ content, filename, onFindReferences, highlightLine }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const hoverSym = useRef<string | null>(null);

  const lines = useMemo(() => tokenize(content, extOf(filename)), [content, filename]);
  const tooBig = lines.length > MAX_INTERACTIVE_LINES;

  // Scroll to and flash a target line (e.g. when jumping to a usage).
  useEffect(() => {
    if (!highlightLine || !ref.current) return;
    const row = ref.current.querySelector<HTMLElement>(
      `.cv-row[data-line="${highlightLine}"]`,
    );
    if (!row) return;
    row.scrollIntoView({ block: "center" });
    row.classList.add("cv-flash");
    const t = setTimeout(() => row.classList.remove("cv-flash"), 1400);
    return () => clearTimeout(t);
  }, [highlightLine, content]);

  function applyHl(sym: string | null) {
    const root = ref.current;
    if (!root || sym === hoverSym.current) return;
    hoverSym.current = sym;
    root.querySelectorAll(".sym-hl").forEach((el) => el.classList.remove("sym-hl"));
    if (sym) {
      root
        .querySelectorAll(`.tok-id[data-sym="${CSS.escape(sym)}"]`)
        .forEach((el) => el.classList.add("sym-hl"));
    }
  }

  function onOver(e: React.MouseEvent) {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".tok-id");
    applyHl(el?.dataset.sym ?? null);
  }
  function onClick(e: React.MouseEvent) {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".tok-id");
    if (el?.dataset.sym) onFindReferences(el.dataset.sym);
  }

  if (tooBig) {
    return (
      <div className="cv cv-plain">
        <div className="cv-note subtle">
          {lines.length.toLocaleString()} lines — highlighting disabled for very large files.
        </div>
        <pre>{content}</pre>
      </div>
    );
  }

  return (
    <div
      className="cv"
      ref={ref}
      onMouseOver={onOver}
      onMouseLeave={() => applyHl(null)}
      onClick={onClick}
    >
      {lines.map((toks, idx) => (
        <div className="cv-row" key={idx} data-line={idx + 1}>
          <span className="cv-ln">{idx + 1}</span>
          <span className="cv-code">
            {toks.length === 0
              ? "​"
              : toks.map((tok, k) =>
                  tok.t === "ws" ? (
                    tok.v
                  ) : tok.t === "id" ? (
                    <span key={k} className="tok tok-id" data-sym={tok.v}>
                      {tok.v}
                    </span>
                  ) : (
                    <span key={k} className={`tok tok-${tok.t}`}>
                      {tok.v}
                    </span>
                  ),
                )}
          </span>
        </div>
      ))}
    </div>
  );
}
