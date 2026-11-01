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

  it('shows the Admin navigation only to local Administrators', () => {
    mocks.user = { sub: 'admin', username: 'atlas', displayName: 'Atlas', role: 'Admin' };
    const router = createMemoryRouter([
      { element: <Layout />, children: [{ index: true, element: <div>Home</div> }] },
    ]);
    render(<RouterProvider router={router} />);

    expect(screen.getByRole('link', { name: /admin/i })).toHaveAttribute('href', '/admin');
    expect(screen.queryByRole('button', { name: 'Manage Tags' })).not.toBeInTheDocument();
  });

  it('hides tag management from non-Administrators', () => {
    mocks.user = { sub: 'standard', username: 'apollo', displayName: 'Apollo', role: 'Standard' };
    const router = createMemoryRouter([
      { element: <Layout />, children: [{ index: true, element: <div>Home</div> }] },
    ]);
    render(<RouterProvider router={router} />);

    expect(screen.queryByRole('link', { name: /admin/i })).not.toBeInTheDocument();
  });
});
