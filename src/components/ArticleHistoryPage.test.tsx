import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { currentUrl, renderAt, RouteProbe } from '../test/navigation';
import { ArticleHistoryPage } from './ArticleHistoryPage';

const mocks = vi.hoisted(() => ({
  user: { sub: 'author', username: 'apollo', displayName: 'Apollo', role: 'Editor' as 'Moderator' | 'Editor' },
  listArticleRevisions: vi.fn(),
  restoreArticleRevision: vi.fn(),
}));

vi.mock('./AuthContext', () => ({
  useAuth: () => ({ user: mocks.user }),
}));

vi.mock('../lib/memberApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/memberApi')>();
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
    tags: [{ id: '10000000-0000-4000-8000-000000000001', name: 'portal', color: '#B5C3B7' }],
    visibility: 'Internal',
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
    tags: [{ id: '10000000-0000-4000-8000-000000000001', name: 'portal', color: '#B5C3B7' }],
    visibility: 'Public',
    isPinned: false,
    isProtected: false,
    revisedAt: '2026-01-01T00:00:00.000Z',
    revisedBy: 'author',
    revisedByName: 'Apollo',
    version: 1,
  },
];

function renderHistory() {
  return renderAt(
    '/?article=00000000-0000-4000-8000-000000000001&view=history',
    <><ArticleHistoryPage id="00000000-0000-4000-8000-000000000001" /><RouteProbe /></>,
  );
}

describe('ArticleHistoryPage', () => {
  beforeEach(() => {
    mocks.user.role = 'Editor';
    mocks.listArticleRevisions.mockReset();
    mocks.listArticleRevisions.mockResolvedValue(revisions);
    mocks.restoreArticleRevision.mockReset();
    mocks.restoreArticleRevision.mockResolvedValue({ ...revisions[0], version: 3 });
  });

  it('labels and compares the latest and previous revisions for Editors', async () => {
    renderHistory();
    expect(await screen.findByRole('heading', { name: 'Revision history' })).toBeInTheDocument();
    expect(screen.getAllByText('Version 2 · Latest').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Version 1 · Previous').length).toBeGreaterThan(0);
    expect(screen.getByText('2026-01-02T00:00:00.000Z')).toBeInTheDocument();
    expect(screen.getByText(/Earlier instructions/)).toBeInTheDocument();
    expect(screen.getByText(/Latest instructions/)).toBeInTheDocument();
    expect(screen.getByText('Not pinned')).toBeInTheDocument();
    expect(screen.getByText('Pinned')).toBeInTheDocument();
    expect(screen.getByText('Public')).toHaveClass('visibility-public');
    expect(screen.getByText('Internal')).toHaveClass('visibility-internal');
    expect(screen.queryByRole('button', { name: /Restore version/i })).not.toBeInTheDocument();
  });

  it('allows a Moderator to restore the selected revision as a new latest copy', async () => {
    mocks.user.role = 'Moderator';
    const user = userEvent.setup();
    renderHistory();
    await user.click(await screen.findByRole('button', { name: 'Restore version 1' }));
    // A11Y-2: the confirmation is a dialog with the safe choice focused.
    const dialog = await screen.findByRole('alertdialog', { name: 'Restore version 1?' });
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(mocks.restoreArticleRevision).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Restore' }));
    expect(mocks.restoreArticleRevision).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000001',
      1,
      2,
    );
    expect(await screen.findByTestId('route')).toHaveTextContent('article');
    expect(currentUrl()).toBe('/?article=00000000-0000-4000-8000-000000000001');
  });
});
