import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '../types';
import { Layout } from './Layout';

const mocks = vi.hoisted(() => ({
  user: null as SessionUser | null,
  signOut: vi.fn(),
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: mocks.user, signOut: mocks.signOut }),
}));

describe('Layout settings', () => {
  beforeEach(() => {
    mocks.user = null;
    mocks.signOut.mockReset();
  });

  it('opens the settings dialog from the header icon button', async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter([
      { element: <Layout />, children: [{ index: true, element: <div>Home</div> }] },
    ]);
    render(<RouterProvider router={router} />);

    const button = screen.getByRole('button', { name: 'Settings' });
    expect(button).toHaveAttribute('title', 'Settings');
    expect(button.querySelector('svg')).toBeInTheDocument();
    await user.click(button);

    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
  });

  function renderLayout() {
    const router = createMemoryRouter([
      { element: <Layout />, children: [{ index: true, element: <div>Home</div> }] },
    ]);
    render(<RouterProvider router={router} />);
  }

  it('never links to the admin panel, whatever the role', () => {
    for (const role of [null, 'Editor', 'Moderator'] as const) {
      mocks.user = role ? { sub: role, username: role.toLowerCase(), displayName: role, role } : null;
      const { unmount } = render(<RouterProvider router={createMemoryRouter([{ element: <Layout />, children: [{ index: true, element: <div>Home</div> }] }])} />);
      expect(screen.queryByRole('link', { name: /admin/i })).not.toBeInTheDocument();
      expect(document.querySelector('a[href^="/admin"]')).toBeNull();
      unmount();
    }
  });

  it('does not link to an API reference, which only the Admin sees (API-14)', () => {
    renderLayout();
    expect(screen.queryByRole('link', { name: /API reference/ })).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="/api"]')).toBeNull();
  });

  it('shows the Tags link and Moderator badge only to Moderators', () => {
    mocks.user = { sub: 'moderator', username: 'atlas', displayName: 'Atlas', role: 'Moderator' };
    renderLayout();

    expect(screen.getByRole('link', { name: /tags/i })).toHaveAttribute('href', '/tags');
    expect(screen.getByText('Atlas · Moderator').closest('.identity-badge')).toHaveClass('moderator');
  });

  it('hides tag management from Editors', () => {
    mocks.user = { sub: 'editor', username: 'apollo', displayName: 'Apollo', role: 'Editor' };
    renderLayout();

    expect(screen.queryByRole('link', { name: /tags/i })).not.toBeInTheDocument();
    expect(screen.getByText('Apollo · Editor').closest('.identity-badge')).not.toHaveClass('moderator');
  });
});
