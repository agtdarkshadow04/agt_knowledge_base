import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Article } from '../types';
import { ArticlePage } from './ArticlePage';

const mocks = vi.hoisted(() => ({
  getToken: vi.fn(async () => 'token'),
  getArticle: vi.fn(),
  setArticlePinned: vi.fn(),
  setArticleVerified: vi.fn(),
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { sub: 'admin', username: 'atlas', displayName: 'Atlas', role: 'Admin' },
    getToken: mocks.getToken,
  }),
}));

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
    mocks.getArticle.mockReset();
    mocks.getArticle.mockResolvedValue(article);
    mocks.setArticlePinned.mockReset();
    mocks.setArticlePinned.mockResolvedValue({ ...article, isPinned: true, version: 2 });
    mocks.setArticleVerified.mockReset();
    mocks.setArticleVerified.mockResolvedValue({ ...article, isVerified: true, version: 2 });
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
