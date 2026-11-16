import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAt } from '../test/navigation';
import { HomePage } from './HomePage';

const mocks = vi.hoisted(() => ({
  listArticles: vi.fn(),
  listTags: vi.fn(),
}));

vi.mock('./AuthContext', () => ({
  useAuth: () => ({ user: null }),
}));

vi.mock('../lib/memberApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/memberApi')>();
  return { ...actual, listArticles: mocks.listArticles, listTags: mocks.listTags };
});

describe('HomePage', () => {
  beforeEach(() => {
    mocks.listArticles.mockReset();
    mocks.listArticles.mockResolvedValue({ items: [], nextCursor: null, total: 0 });
    mocks.listTags.mockReset();
    mocks.listTags.mockResolvedValue([
      { id: '10000000-0000-4000-8000-000000000001', name: 'portal', color: '#B5C3B7' },
    ]);
  });

  it('loads visibility, pin, and verification filters from search parameters', async () => {
    renderAt('/?visibility=public&pinned=pinned&verification=verified', <HomePage />);

    expect(screen.getByRole('combobox', { name: 'Pin status' })).toHaveValue('pinned');
    expect(screen.getByRole('combobox', { name: 'Visibility' })).toHaveValue('public');
    expect(screen.getByRole('combobox', { name: 'Verified' })).toHaveValue('verified');
    await waitFor(() => expect(mocks.listArticles).toHaveBeenCalledWith(
      expect.objectContaining({ visibility: 'public', pinned: 'pinned', verification: 'verified' }),
      expect.any(AbortSignal),
      false,
    ));
  });

  it('defaults the verification filter to all articles', async () => {
    renderAt('/', <HomePage />);

    expect(screen.getByRole('combobox', { name: 'Verified' })).toHaveValue('all');
    await waitFor(() => expect(mocks.listArticles).toHaveBeenCalledWith(
      expect.objectContaining({ verification: 'all' }),
      expect.any(AbortSignal),
      false,
    ));
  });

  it('loads an AGT-standard numeric visibility filter', async () => {
    renderAt('/?visibility=0', <HomePage />);

    expect(screen.getByRole('combobox', { name: 'Visibility' })).toHaveValue('0');
    await waitFor(() => expect(mocks.listArticles).toHaveBeenCalledWith(
      expect.objectContaining({ visibility: '0' }),
      expect.any(AbortSignal),
      false,
    ));
  });

  it('filters by a canonical tag ID instead of free text', async () => {
    const user = userEvent.setup();
    renderAt('/', <HomePage />);

    const tagFilter = await screen.findByRole('combobox', { name: 'Tag' });
    await waitFor(() => expect(tagFilter).toBeEnabled());
    await user.selectOptions(tagFilter, '10000000-0000-4000-8000-000000000001');

    await waitFor(() => expect(mocks.listArticles).toHaveBeenLastCalledWith(
      expect.objectContaining({ tagId: '10000000-0000-4000-8000-000000000001' }),
      expect.any(AbortSignal),
      false,
    ));
  });

  it('shows the total result count, and loads the next page with the cursor (API-8)', async () => {
    const user = userEvent.setup();
    const article = (id: string, title: string) => ({
      id,
      title,
      excerpt: '',
      tags: [],
      visibility: 'Public' as const,
      isPinned: false,
      isProtected: false,
      isVerified: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'user-1',
      createdByName: 'Test User',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      modifiedBy: 'user-1',
      modifiedByName: 'Test User',
      version: 1,
    });
    mocks.listArticles
      .mockResolvedValueOnce({ items: [article('article-1', 'First article')], nextCursor: 'cursor-1', total: 2 })
      .mockResolvedValueOnce({ items: [article('article-2', 'Second article')], nextCursor: null, total: 2 });
    renderAt('/', <HomePage />);

    expect(await screen.findByText('Results: 2 · shown: 1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Results: 2 · shown: 2')).toBeInTheDocument();
    expect(screen.getByText('First article')).toBeInTheDocument();
    expect(screen.getByText('Second article')).toBeInTheDocument();
    expect(mocks.listArticles).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'cursor-1', limit: 12 }), undefined, false);
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });
});
