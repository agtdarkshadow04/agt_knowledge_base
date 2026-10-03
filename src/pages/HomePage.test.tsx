import { render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HomePage } from './HomePage';

const mocks = vi.hoisted(() => ({
  getToken: vi.fn(async () => 'token'),
  listArticles: vi.fn(),
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: null, getToken: mocks.getToken }),
}));

vi.mock('../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/api')>();
  return { ...actual, listArticles: mocks.listArticles };
});

describe('HomePage', () => {
  beforeEach(() => {
    mocks.listArticles.mockReset();
    mocks.listArticles.mockResolvedValue({ items: [], page: 1, pageSize: 12, total: 0, totalPages: 1 });
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

  it('shows the total result count and the number of articles on the current page', async () => {
    mocks.listArticles.mockResolvedValueOnce({
      items: [{
        id: 'article-1',
        title: 'Test article',
        excerpt: '',
        tags: [],
        visibility: 'Public',
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
      }],
      page: 2,
      pageSize: 12,
      total: 13,
      totalPages: 2,
    });
    const router = createMemoryRouter([{ path: '/', element: <HomePage /> }]);
    render(<RouterProvider router={router} />);

    expect(await screen.findByText('13 results • 1 shown')).toBeInTheDocument();
  });
});
