import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { FileContent, FileEntry, ReferenceMatch } from "../protocol";
import { fileIcon } from "./fileIcon";
import { CodeView } from "./CodeView";

interface Props {
  repoId: string | null;
}

interface DirNode {
  entries: FileEntry[];
  open: boolean;
  loading: boolean;
}

interface RefsState {
  symbol: string;
  matches: ReferenceMatch[];
  truncated: boolean;
  notGit?: boolean;
  loading: boolean;
}

export function FileBrowser({ repoId }: Props) {
  // map of dir path -> node ("" is the root)
  const [dirs, setDirs] = useState<Record<string, DirNode>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<FileContent | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refs, setRefs] = useState<RefsState | null>(null);
  const [highlightLine, setHighlightLine] = useState<number | null>(null);

  const loadDir = useCallback(
    async (path: string) => {
      if (!repoId) return;
      setDirs((d) => ({
        ...d,
        [path]: { entries: d[path]?.entries ?? [], open: true, loading: true },
      }));
      try {
        const res = await api.listFiles(repoId, path);
        setDirs((d) => ({
          ...d,
          [path]: { entries: res.entries, open: true, loading: false },
        }));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setDirs((d) => ({
          ...d,
          [path]: { entries: [], open: true, loading: false },
        }));
      }
    },
    [repoId]
  );

  useEffect(() => {
    setDirs({});
    setSelected(null);
    setFile(null);
    setError(null);
    setRefs(null);
    setHighlightLine(null);
    if (repoId) void loadDir("");
  }, [repoId, loadDir]);

  function toggleDir(path: string) {
    const node = dirs[path];
    if (node?.open) {
      setDirs((d) => ({ ...d, [path]: { ...node, open: false } }));
    } else if (node && node.entries.length > 0) {
      setDirs((d) => ({ ...d, [path]: { ...node, open: true } }));
    } else {
      void loadDir(path);
    }
  }

  async function openFile(path: string, line?: number) {
    if (!repoId) return;
    // Already open: just jump to the line without refetching.
    if (path === selected && file && !file.binary) {
      setHighlightLine(line ?? null);
      return;
    }
    setSelected(path);
    setFileLoading(true);
    setFile(null);
    setHighlightLine(line ?? null);
    try {
      const res = await api.readFile(repoId, path);
      setFile(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFileLoading(false);
    }
  }

  async function findReferences(symbol: string) {
    if (!repoId) return;
    setRefs({ symbol, matches: [], truncated: false, loading: true });
    try {
      const res = await api.findReferences(repoId, symbol);
      setRefs({
        symbol: res.symbol,
        matches: res.matches,
        truncated: res.truncated,
        notGit: res.notGit,
        loading: false,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRefs(null);
    }
  }

  function renderDir(path: string, depth: number) {
    const node = dirs[path];
    if (!node || !node.open) return null;
    if (node.loading && node.entries.length === 0) {
      return (
        <div className="tree-loading subtle" style={{ paddingLeft: depth * 14 }}>
          loading…
        </div>
      );
    }
    return node.entries
      .slice()
      .sort((a, b) =>
        a.type === b.type
          ? a.name.localeCompare(b.name)
          : a.type === "dir"
          ? -1
          : 1
      )
      .map((entry) => {
        const isDir = entry.type === "dir";
        const childOpen = dirs[entry.path]?.open;
        const icon = isDir ? null : fileIcon(entry.name);
        return (
          <div key={entry.path}>
            <button
              className={`tree-row ${
                selected === entry.path ? "selected" : ""
              }`}
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() =>
                isDir ? toggleDir(entry.path) : void openFile(entry.path)
              }
            >
              {isDir ? (
                <span className="tree-icon tree-chevron">
                  {childOpen ? "▾" : "▸"}
                </span>
              ) : (
                <span className={`tree-icon ficon ${icon!.cls}`}>
                  {icon!.glyph}
                </span>
              )}
              <span className="tree-name">{entry.name}</span>
            </button>
            {isDir && renderDir(entry.path, depth + 1)}
          </div>
        );
      });
  }

  if (!repoId) {
    return <div className="empty-state subtle">No repo selected.</div>;
  }

  return (
    <div className="file-browser">
      <div className="file-tree">
        {error && <div className="system-line error">⚠ {error}</div>}
        {renderDir("", 0)}
      </div>
      <div className="file-view">
        {!selected && <div className="empty-state subtle">Select a file.</div>}
        {selected && (
          <>
            <div className="file-view-head">{selected}</div>
            {fileLoading && (
              <div className="subtle" style={{ padding: 12 }}>
                Loading…
              </div>
            )}
            {file?.binary && (
              <div className="empty-state subtle">Binary file — not shown.</div>
            )}
            {file && !file.binary && (
              <CodeView
                content={file.content}
                filename={selected}
                onFindReferences={findReferences}
                highlightLine={highlightLine}
              />
            )}
            {refs && (
              <div className="refs-panel">
                <div className="refs-head">
                  <span>
                    Usages of <span className="refs-sym">{refs.symbol}</span>
                    {refs.loading
                      ? " …"
                      : ` · ${refs.matches.length}${refs.truncated ? "+" : ""}`}
                  </span>
                  <button
                    className="icon-btn icon-btn-sm"
                    onClick={() => setRefs(null)}
                    aria-label="Close usages"
                  >
                    ✕
                  </button>
                </div>
                {refs.notGit && (
                  <div className="subtle refs-empty">
                    Not a git repo — find-usages needs git.
                  </div>
                )}
                {!refs.loading &&
                  !refs.notGit &&
                  refs.matches.length === 0 && (
                    <div className="subtle refs-empty">No usages found.</div>
                  )}
                <div className="refs-list">
                  {refs.matches.map((m, i) => (
                    <button
                      key={i}
                      className="ref-row"
                      onClick={() => void openFile(m.path, m.line)}
                    >
                      <span className="ref-loc">
                        {m.path}:{m.line}
                      </span>
                      <span className="ref-text">{m.text.trim()}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
