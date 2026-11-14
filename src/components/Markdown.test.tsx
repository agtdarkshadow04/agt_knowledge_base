import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { extractHeadings, Markdown, safeUrl } from './Markdown';

describe('Markdown (SEC-12, SEC-13)', () => {
  it('shows raw HTML as text and never creates elements from it', () => {
    const { container } = render(<Markdown content={'Hello <b onclick="x()">bold</b>\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>'} />);
    expect(container.querySelector('b, script, img')).toBeNull();
    expect(container.textContent).toContain('<b onclick="x()">bold</b>');
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });

  it('keeps only http(s) and same-site URLs', () => {
    expect(safeUrl('https://example.org/a')).toBe('https://example.org/a');
    expect(safeUrl('HTTP://example.org')).toBe('HTTP://example.org');
    expect(safeUrl('#heading')).toBe('#heading');
    expect(safeUrl('/articles/1')).toBe('/articles/1');
    for (const url of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,x', 'vbscript:x', 'mailto:a@b.c', '//evil.example/x']) {
      expect(safeUrl(url), url).toBe('');
    }
    const { container } = render(<Markdown content={'[bad](javascript:alert(1)) ![pixel](data:image/png;base64,AAAA)'} />);
    expect(container.querySelector('a')?.getAttribute('href') ?? '').toBe('');
    expect(container.querySelector('img')).toBeNull();
  });

  it('opens external links in a new tab without a referrer, and keeps internal links in place', () => {
    render(<Markdown content={'[out](https://example.org) [in](#section)'} />);
    const external = screen.getByRole('link', { name: 'out' });
    expect(external).toHaveAttribute('target', '_blank');
    expect(external).toHaveAttribute('rel', 'noopener noreferrer');
    const internal = screen.getByRole('link', { name: 'in' });
    expect(internal).not.toHaveAttribute('target');
    expect(internal).toHaveAttribute('href', '#section');
  });

  it('loads external images lazily without a referrer and shows a fallback when one fails', () => {
    render(<Markdown content={'![Portal map](https://example.org/map.png)'} />);
    const image = screen.getByRole('img', { name: 'Portal map' });
    expect(image).toHaveAttribute('loading', 'lazy');
    expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
    fireEvent.error(image);
    expect(screen.getByRole('img', { name: 'Portal map' })).toHaveTextContent('[Image: Portal map]');
  });

  it('gives headings the same ids as the table of contents', () => {
    const content = '# Portal Guide\n\n## Steps\n\n## Steps';
    const { container } = render(<Markdown content={content} />);
    expect([...container.querySelectorAll('h1, h2')].map((heading) => heading.id)).toEqual(extractHeadings(content).map((heading) => heading.id));
    expect(extractHeadings(content).map((heading) => heading.id)).toEqual(['portal-guide', 'steps', 'steps-2']);
  });
});
