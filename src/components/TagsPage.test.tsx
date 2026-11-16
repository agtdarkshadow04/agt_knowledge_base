import { cleanup, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RequireModerator } from './RequireModerator';
import type { SessionUser } from '../lib/api';
import { TagsPage } from './TagsPage';
import { currentUrl, renderAt, RouteProbe } from '../test/navigation';

const mocks = vi.hoisted(() => ({
  user: null as SessionUser | null,
  listTags: vi.fn(),
  listOrphanTagReferences: vi.fn(),
}));

vi.mock('./AuthContext', () => ({
  useAuth: () => ({ user: mocks.user, loading: false }),
}));

vi.mock('../lib/memberApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/memberApi')>(),
  listTags: mocks.listTags,
  listOrphanTagReferences: mocks.listOrphanTagReferences,
}));

function renderTags() {
  renderAt('/?view=tags', <><RequireModerator><TagsPage /></RequireModerator><RouteProbe /></>);
}

describe('tag management page', () => {
  beforeEach(() => {
    mocks.listTags.mockResolvedValue([{ id: '10000000-0000-4000-8000-000000000001', name: 'Portal', color: '#B5C3B7' }]);
    mocks.listOrphanTagReferences.mockReset().mockResolvedValue([]);
  });

  it('lets Moderators manage the tag catalog and orphaned references', async () => {
    mocks.user = { sub: 'moderator', username: 'atlas', displayName: 'Atlas', role: 'Moderator' };
    renderTags();

    expect(await screen.findByRole('region', { name: 'Manage tags' })).toBeInTheDocument();
    expect(await screen.findByText('Portal')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Orphaned references' })).toBeInTheDocument();
    expect(mocks.listOrphanTagReferences).toHaveBeenCalledWith(expect.anything());
  });

  it('sends Editors home and signed-out visitors to sign-in', async () => {
    mocks.user = { sub: 'editor', username: 'apollo', displayName: 'Apollo', role: 'Editor' };
    renderTags();
    await waitFor(() => expect(currentUrl()).toBe('/'));
    expect(screen.getByTestId('route')).toHaveTextContent('home');
    cleanup();

    mocks.user = null;
    renderTags();
    await waitFor(() => expect(screen.getByTestId('route')).toHaveTextContent('login'));
    expect(currentUrl()).toBe(`/?view=login&next=${encodeURIComponent('/?view=tags')}`);
    expect(mocks.listOrphanTagReferences).not.toHaveBeenCalled();
  });
});
