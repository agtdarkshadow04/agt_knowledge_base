import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArticleHistoryPage } from './ArticleHistoryPage';

const mocks = vi.hoisted(() => ({
  user: { sub: 'author', username: 'apollo', displayName: 'Apollo', role: 'Standard' as 'Admin' | 'Standard' },
  getToken: vi.fn(async () => 'token'),
  listArticleRevisions: vi.fn(),
  restoreArticleRevision: vi.fn(),
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: mocks.user, getToken: mocks.getToken }),
}));

vi.mock('../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/api')>();
  return {
    ...actual,
    listArticleRevisions: mocks.listArticleRevisions,
    restoreArticleRevision: mocks.restoreArticleRevision,
  };
});

const revisions = [
  {
    articleId: '00000000-0000-4000-8000-000000000001',
    title: 'Portal Guide',
    content: '# Portal Guide\n\nLatest instructions.',
    tags: ['portal'],
    isPinned: true,
    isProtected: false,
    revisedAt: '2026-01-02T00:00:00.000Z',
    revisedBy: 'admin',
    revisedByName: 'Atlas',
    version: 2,
  },
  {
    articleId: '00000000-0000-4000-8000-000000000001',
    title: 'Portal Guide',
    content: '# Portal Guide\n\nEarlier instructions.',
    tags: ['portal'],
    isPinned: false,
    isProtected: false,
    revisedAt: '2026-01-01T00:00:00.000Z',
    revisedBy: 'author',
    revisedByName: 'Apollo',
    version: 1,
  },
];

function renderHistory() {
  const router = createMemoryRouter([
    { path: '/articles/:id/history', element: <ArticleHistoryPage /> },
    { path: '/articles/:id', element: <div>Current article</div> },
  ], { initialEntries: ['/articles/00000000-0000-4000-8000-000000000001/history'] });
  return render(<RouterProvider router={router} />);
}

describe('ArticleHistoryPage', () => {
  beforeEach(() => {
    mocks.user.role = 'Standard';
    mocks.listArticleRevisions.mockReset();
    mocks.listArticleRevisions.mockResolvedValue(revisions);
    mocks.restoreArticleRevision.mockReset();
    mocks.restoreArticleRevision.mockResolvedValue({ ...revisions[0], version: 3 });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('labels and compares the latest and previous revisions for Standard users', async () => {
    renderHistory();
    expect(await screen.findByRole('heading', { name: 'Revision history' })).toBeInTheDocument();
    expect(screen.getAllByText('Version 2 · Latest').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Version 1 · Previous').length).toBeGreaterThan(0);
    expect(screen.getByText('2026-01-02T00:00:00.000Z')).toBeInTheDocument();
    expect(screen.getByText(/Earlier instructions/)).toBeInTheDocument();
    expect(screen.getByText(/Latest instructions/)).toBeInTheDocument();
    expect(screen.getByText('Not pinned')).toBeInTheDocument();
    expect(screen.getByText('Pinned')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Restore version/i })).not.toBeInTheDocument();
  });

  it('allows an Administrator to restore the selected revision as a new latest copy', async () => {
    mocks.user.role = 'Admin';
    const user = userEvent.setup();
    renderHistory();
    await user.click(await screen.findByRole('button', { name: 'Restore version 1' }));
    expect(mocks.restoreArticleRevision).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000001',
      1,
      2,
      'token',
    );
    expect(await screen.findByText('Current article')).toBeInTheDocument();
  });
});
