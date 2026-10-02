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

  it('loads visibility and pin filters from search parameters', async () => {
    const router = createMemoryRouter(
      [{ path: '/', element: <HomePage /> }],
      { initialEntries: ['/?visibility=public&pinned=pinned'] },
    );
    render(<RouterProvider router={router} />);

    expect(screen.getByRole('combobox', { name: 'Pin status' })).toHaveValue('pinned');
    expect(screen.getByRole('combobox', { name: 'Visibility' })).toHaveValue('public');
    await waitFor(() => expect(mocks.listArticles).toHaveBeenCalledWith(
      expect.objectContaining({ visibility: 'public', pinned: 'pinned' }),
      expect.any(AbortSignal),
      undefined,
    ));
  });
});
