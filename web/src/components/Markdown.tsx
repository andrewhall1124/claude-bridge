import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { ComponentProps } from "react";

// Renders assistant text as GitHub-flavored Markdown. Raw HTML is disabled by
// default in react-markdown, so model output can't inject markup. Links open in
// a new tab with a safe rel.
function Anchor({ node: _node, ...props }: ComponentProps<"a"> & { node?: unknown }) {
  return <a {...props} target="_blank" rel="noopener noreferrer" />;
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{ a: Anchor }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
