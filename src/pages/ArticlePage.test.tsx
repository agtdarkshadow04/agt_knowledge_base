import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Article, SessionUser } from '../types';
import { ArticlePage } from './ArticlePage';

const mocks = vi.hoisted(() => {
  const pdfWorker = { set: vi.fn(), from: vi.fn(), save: vi.fn() };
  return {
    user: { sub: 'admin', username: 'atlas', displayName: 'Atlas', role: 'Admin' } as SessionUser | null,
    getToken: vi.fn(async () => 'token'),
    getArticle: vi.fn(),
    setArticlePinned: vi.fn(),
    setArticleVerified: vi.fn(),
    pdfWorker,
    html2pdf: vi.fn(() => pdfWorker),
  };
});

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: mocks.user,
    getToken: mocks.getToken,
  }),
}));

vi.mock('html2pdf.js', () => ({ default: mocks.html2pdf }));

vi.mock('../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/api')>();
  return {
    ...actual,
    getArticle: mocks.getArticle,
    setArticlePinned: mocks.setArticlePinned,
    setArticleVerified: mocks.setArticleVerified,
  };
});

const article: Article = {
  id: '00000000-0000-4000-8000-000000000001',
  title: 'Portal Guide',
  excerpt: 'Safe portal navigation.',
  content: '# Portal Guide\n\nSafe portal navigation instructions.',
  tags: ['portal'],
  visibility: 'Public',
  isPinned: false,
  isProtected: false,
  isVerified: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'author',
  createdByName: 'Apollo',
  modifiedAt: '2026-01-02T00:00:00.000Z',
  modifiedBy: 'author',
  modifiedByName: 'Apollo',
  version: 1,
};

describe('ArticlePage', () => {
  beforeEach(() => {
    mocks.user = { sub: 'admin', username: 'atlas', displayName: 'Atlas', role: 'Admin' };
    mocks.getArticle.mockReset();
    mocks.getArticle.mockResolvedValue(article);
    mocks.setArticlePinned.mockReset();
    mocks.setArticlePinned.mockResolvedValue({ ...article, isPinned: true, version: 2 });
    mocks.setArticleVerified.mockReset();
    mocks.setArticleVerified.mockResolvedValue({ ...article, isVerified: true, version: 2 });
    mocks.html2pdf.mockReset();
    mocks.html2pdf.mockReturnValue(mocks.pdfWorker);
    mocks.pdfWorker.set.mockReset();
    mocks.pdfWorker.set.mockReturnValue(mocks.pdfWorker);
    mocks.pdfWorker.from.mockReset();
    mocks.pdfWorker.from.mockReturnValue(mocks.pdfWorker);
    mocks.pdfWorker.save.mockReset();
    mocks.pdfWorker.save.mockResolvedValue(undefined);
  });

  it('offers raw Markdown and PDF downloads to Standard users', async () => {
    mocks.user = { sub: 'standard', username: 'apollo', displayName: 'Apollo', role: 'Standard' };
    const router = createMemoryRouter(
      [{ path: '/articles/:id', element: <ArticlePage /> }],
      { initialEntries: [`/articles/${article.id}`] },
    );
    render(<RouterProvider router={router} />);

    expect(await screen.findByRole('button', { name: 'Download raw Markdown' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download PDF' })).toBeInTheDocument();
  });

  it('does not offer downloads to anonymous visitors', async () => {
    mocks.user = null;
    const router = createMemoryRouter(
      [{ path: '/articles/:id', element: <ArticlePage /> }],
      { initialEntries: [`/articles/${article.id}`] },
    );
    render(<RouterProvider router={router} />);

    await screen.findByText('Created by');
    expect(screen.queryByRole('button', { name: 'Download raw Markdown' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download PDF' })).not.toBeInTheDocument();
  });

  it('downloads the unmodified Markdown source', async () => {
    const createObjectURL = vi.fn((blob: Blob) => {
      void blob;
      return 'blob:article';
    });
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    let download = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      download = this.download;
    });
    const router = createMemoryRouter(
      [{ path: '/articles/:id', element: <ArticlePage /> }],
      { initialEntries: [`/articles/${article.id}`] },
    );
    const user = userEvent.setup();
    render(<RouterProvider router={router} />);

    await user.click(await screen.findByRole('button', { name: 'Download raw Markdown' }));

    const blob = createObjectURL.mock.calls[0][0] as Blob;
    const contents = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob);
    });
    expect(contents).toBe(article.content);
    expect(blob.type).toBe('text/markdown;charset=utf-8');
    expect(download).toBe('Portal Guide.md');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:article');
  });

  it('renders and saves the sanitized article as a client-side PDF', async () => {
    const router = createMemoryRouter(
      [{ path: '/articles/:id', element: <ArticlePage /> }],
      { initialEntries: [`/articles/${article.id}`] },
    );
    const user = userEvent.setup();
    render(<RouterProvider router={router} />);

    await user.click(await screen.findByRole('button', { name: 'Download PDF' }));

    await waitFor(() => expect(mocks.pdfWorker.save).toHaveBeenCalled());
    expect(mocks.pdfWorker.set).toHaveBeenCalledWith(expect.objectContaining({ filename: 'Portal Guide.pdf' }));
    const pdfSource = mocks.pdfWorker.from.mock.calls[0][0] as HTMLElement;
    expect(pdfSource).toHaveTextContent('Portal Guide');
    expect(pdfSource).toHaveTextContent('Safe portal navigation instructions.');
    expect(document.body).not.toContainElement(pdfSource);
  });

  it('allows an Administrator to pin an article', async () => {
    const router = createMemoryRouter(
      [{ path: '/articles/:id', element: <ArticlePage /> }],
      { initialEntries: [`/articles/${article.id}`] },
    );
    const user = userEvent.setup();
    render(<RouterProvider router={router} />);

    await user.click(await screen.findByRole('button', { name: 'Pin' }));

    expect(screen.getByText('Public')).toHaveClass('visibility-public');
    expect(mocks.setArticlePinned).toHaveBeenCalledWith(article.id, true, article.version, 'token');
    expect(await screen.findByRole('button', { name: 'Unpin' })).toBeInTheDocument();
  });

  it('allows an Administrator to verify an article', async () => {
    const router = createMemoryRouter(
      [{ path: '/articles/:id', element: <ArticlePage /> }],
      { initialEntries: [`/articles/${article.id}`] },
    );
    const user = userEvent.setup();
    render(<RouterProvider router={router} />);

    await user.click(await screen.findByRole('button', { name: 'Verify' }));

    expect(mocks.setArticleVerified).toHaveBeenCalledWith(article.id, true, article.version, 'token');
    expect(await screen.findByText('Verified')).toHaveClass('verified');
    expect(screen.getByRole('button', { name: 'Unverify' })).toBeInTheDocument();
  });
});
