import { isValidElement, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * The one component that renders stored Markdown (SEC-12): `react-markdown` +
 * `remark-gfm`, raw HTML shown as text, only http(s) and same-site URLs, external
 * links in a new tab without a referrer (SEC-13), and external images loaded
 * lazily without a referrer, with a fallback when they fail. The Markdown is
 * stored exactly as written; nothing here changes it.
 */

export interface HeadingItem {
  depth: number;
  text: string;
  id: string;
}

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

/** A remark plugin that turns raw HTML nodes into text, so no element is ever created from HTML. */
export function remarkHtmlAsText() {
  const walk = (node: MdNode) => {
    if (node.type === 'html') node.type = 'text';
    node.children?.forEach(walk);
  };
  return (tree: MdNode) => walk(tree);
}

const scheme = /^([a-z][a-z0-9+.-]*):/i;

/** Keeps `http:` and `https:` URLs and scheme-less ones (same-site paths, `#anchors`); drops everything else. */
export function safeUrl(url: string) {
  const trimmed = url.trim();
  const found = scheme.exec(trimmed);
  if (!found) return trimmed.startsWith('//') ? '' : trimmed;
  return ['http', 'https'].includes(found[1].toLowerCase()) ? trimmed : '';
}

function isExternal(url: string | undefined) {
  return Boolean(url && /^https?:/i.test(url));
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

function Link({ href, children, node: _node, ...props }: ComponentPropsWithoutRef<'a'> & { node?: unknown }) {
  return isExternal(href)
    ? <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a>
    : <a {...props} href={href}>{children}</a>;
}

function Image({ src, alt, node: _node, ...props }: ComponentPropsWithoutRef<'img'> & { node?: unknown }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <span className="markdown-image-fallback" role="img" aria-label={alt || 'Image'}>{alt ? `[Image: ${alt}]` : '[Image unavailable]'}</span>;
  return <img {...props} src={src} alt={alt ?? ''} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

export function Markdown({ content }: { content: string }) {
  const slug = createSlugger();
  const heading = (level: 1 | 2 | 3 | 4) => {
    const Component = `h${level}` as const;
    return function SafeHeading({ children }: { children?: ReactNode }) {
      return <Component id={slug(nodeText(children))}>{children}</Component>;
    };
  };
  const components = { h1: heading(1), h2: heading(2), h3: heading(3), h4: heading(4), a: Link, img: Image };

  return (
    <div className="markdown-content">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkHtmlAsText]} urlTransform={safeUrl} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
