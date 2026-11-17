/**
 * The framework-free parts of Markdown rendering (SEC-12, SEC-13), shared by
 * `src/components/Markdown.tsx` and tested in plain Node: the remark plugin
 * that shows raw HTML as text, the URL allowlist, and the heading ids the
 * article's table of contents links to.
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

export function isExternal(url: string | undefined) {
  return Boolean(url && /^https?:/i.test(url));
}

export function createSlugger() {
  const counts = new Map<string, number>();
  return (text: string) => {
    const base = text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-').replace(/-+/g, '-') || 'section';
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    return count === 0 ? base : `${base}-${count + 1}`;
  };
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
