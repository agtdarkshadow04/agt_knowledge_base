import { isValidElement, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

export interface HeadingItem {
  depth: number;
  text: string;
  id: string;
}

function createSlugger() {
  const counts = new Map<string, number>();
  return (text: string) => {
    const base = text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-').replace(/-+/g, '-') || 'section';
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    return count === 0 ? base : `${base}-${count + 1}`;
  };
}

function nodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return '';
}

export function extractHeadings(markdown: string): HeadingItem[] {
  const slug = createSlugger();
  let inFence = false;
  const headings: HeadingItem[] = [];
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const text = match[2].replace(/[*_`]/g, '').replaceAll('[', '').replaceAll(']', '').trim();
    headings.push({ depth: match[1].length, text, id: slug(text) });
  }
  return headings;
}

export function MarkdownContent({ content }: { content: string }) {
  const slug = createSlugger();
  const heading = (level: 1 | 2 | 3 | 4) => {
    const Component = `h${level}` as const;
    return function SafeHeading({ children }: { children?: React.ReactNode }) {
      const text = nodeText(children);
      return <Component id={slug(text)}>{children}</Component>;
    };
  };
  const components = { h1: heading(1), h2: heading(2), h3: heading(3), h4: heading(4) };

  return (
    <div className="markdown-content">
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={components}>
        {content}
      </Markdown>
    </div>
  );
}
