import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HomePage } from './HomePage';

const mocks = vi.hoisted(() => ({
  getToken: vi.fn(async () => 'token'),
  listArticles: vi.fn(),
  listTags: vi.fn(),
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: null, getToken: mocks.getToken }),
}));

vi.mock('../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/api')>();
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
    const router = createMemoryRouter(
      [{ path: '/', element: <HomePage /> }],
      { initialEntries: ['/?visibility=public&pinned=pinned&verification=verified'] },
    );
    render(<RouterProvider router={router} />);

    expect(screen.getByRole('combobox', { name: 'Pin status' })).toHaveValue('pinned');
    expect(screen.getByRole('combobox', { name: 'Visibility' })).toHaveValue('public');
    expect(screen.getByRole('combobox', { name: 'Verified' })).toHaveValue('verified');
    await waitFor(() => expect(mocks.listArticles).toHaveBeenCalledWith(
      expect.objectContaining({ visibility: 'public', pinned: 'pinned', verification: 'verified' }),
      expect.any(AbortSignal),
      undefined,
    ));
  });

  it('defaults the verification filter to all articles', async () => {
    const router = createMemoryRouter([{ path: '/', element: <HomePage /> }]);
    render(<RouterProvider router={router} />);

    expect(screen.getByRole('combobox', { name: 'Verified' })).toHaveValue('all');
    await waitFor(() => expect(mocks.listArticles).toHaveBeenCalledWith(
      expect.objectContaining({ verification: 'all' }),
      expect.any(AbortSignal),
      undefined,
    ));
  });

  it('loads an AGT-standard numeric visibility filter', async () => {
    const router = createMemoryRouter(
      [{ path: '/', element: <HomePage /> }],
      { initialEntries: ['/?visibility=0'] },
    );
    render(<RouterProvider router={router} />);

    expect(screen.getByRole('combobox', { name: 'Visibility' })).toHaveValue('0');
    await waitFor(() => expect(mocks.listArticles).toHaveBeenCalledWith(
      expect.objectContaining({ visibility: '0' }),
      expect.any(AbortSignal),
      undefined,
    ));
  });

  it('filters by a canonical tag ID instead of free text', async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter([{ path: '/', element: <HomePage /> }]);
    render(<RouterProvider router={router} />);

    const tagFilter = await screen.findByRole('combobox', { name: 'Tag' });
    await waitFor(() => expect(tagFilter).toBeEnabled());
    await user.selectOptions(tagFilter, '10000000-0000-4000-8000-000000000001');

    await waitFor(() => expect(mocks.listArticles).toHaveBeenLastCalledWith(
      expect.objectContaining({ tagId: '10000000-0000-4000-8000-000000000001' }),
      expect.any(AbortSignal),
      undefined,
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
    const router = createMemoryRouter([{ path: '/', element: <HomePage /> }]);
    render(<RouterProvider router={router} />);

    expect(await screen.findByText('2 results • 1 shown')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('2 results • 2 shown')).toBeInTheDocument();
    expect(screen.getByText('First article')).toBeInTheDocument();
    expect(screen.getByText('Second article')).toBeInTheDocument();
    expect(mocks.listArticles).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'cursor-1', limit: 12 }), undefined, undefined);
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });
});
