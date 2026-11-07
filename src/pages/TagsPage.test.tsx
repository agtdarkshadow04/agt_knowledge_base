import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RequireModerator } from '../auth/RequireModerator';
import type { SessionUser } from '../types';
import { TagsPage } from './TagsPage';

const mocks = vi.hoisted(() => ({
  user: null as SessionUser | null,
  listTags: vi.fn(),
  listOrphanTagReferences: vi.fn(),
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: mocks.user, loading: false, getToken: async () => 'token' }),
}));

vi.mock('../services/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/api')>(),
  listTags: mocks.listTags,
  listOrphanTagReferences: mocks.listOrphanTagReferences,
}));

function renderTags() {
  const router = createMemoryRouter([
    { path: '/tags', element: <RequireModerator><TagsPage /></RequireModerator> },
    { path: '/', element: <p>Home page</p> },
    { path: '/login', element: <p>Login page</p> },
  ], { initialEntries: ['/tags'] });
  render(<RouterProvider router={router} />);
}

describe('tag management page', () => {
  beforeEach(() => {
    mocks.listTags.mockResolvedValue([{ id: '10000000-0000-4000-8000-000000000001', name: 'Portal', color: '#B5C3B7' }]);
    mocks.listOrphanTagReferences.mockReset().mockResolvedValue([]);
  });

  it('lets Moderators manage the tag catalog and orphaned references', async () => {
    mocks.user = { sub: 'moderator', username: 'atlas', displayName: 'Atlas', role: 'Moderator' };
    renderTags();

    expect(await screen.findByRole('region', { name: 'Manage Tags' })).toBeInTheDocument();
    expect(await screen.findByText('Portal')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Orphaned references' })).toBeInTheDocument();
    expect(mocks.listOrphanTagReferences).toHaveBeenCalledWith('token', expect.anything());
  });

  it('sends Editors home and signed-out visitors to sign-in', async () => {
    mocks.user = { sub: 'editor', username: 'apollo', displayName: 'Apollo', role: 'Editor' };
    renderTags();
    expect(await screen.findByText('Home page')).toBeInTheDocument();

    mocks.user = null;
    renderTags();
    expect(await screen.findByText('Login page')).toBeInTheDocument();
    expect(mocks.listOrphanTagReferences).not.toHaveBeenCalled();
  });
});
