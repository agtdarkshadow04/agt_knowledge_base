import { isValidElement, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { formatTranslation } from '../translations';
import { useI18n } from './I18n';
import { createSlugger, isExternal, remarkHtmlAsText, safeUrl } from '../lib/markdown';

export { extractHeadings, safeUrl, type HeadingItem } from '../lib/markdown';

/**
 * The one component that renders stored Markdown (SEC-12): `react-markdown` +
 * `remark-gfm`, raw HTML shown as text, only http(s) and same-site URLs, external
 * links in a new tab without a referrer (SEC-13), and external images loaded
 * lazily without a referrer, with a fallback when they fail. The Markdown is
 * stored exactly as written; nothing here changes it.
 */

function nodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return '';
}

function Link({ href, children, node: _node, ...props }: ComponentPropsWithoutRef<'a'> & { node?: unknown }) {
  return isExternal(href)
    ? <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a>
    : <a {...props} href={href}>{children}</a>;
}

function Image({ src, alt, node: _node, ...props }: ComponentPropsWithoutRef<'img'> & { node?: unknown }) {
  const [failed, setFailed] = useState(false);
  const { t } = useI18n();
  if (!src || failed) {
    return (
      <span className="markdown-image-fallback" role="img" aria-label={alt || t.markdown.image}>
        {alt ? formatTranslation(t.markdown.imageAlt, { alt }) : t.markdown.imageUnavailable}
      </span>
    );
  }
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
