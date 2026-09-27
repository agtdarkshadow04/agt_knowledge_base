import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { Layout } from './Layout';

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: null, signOut: vi.fn() }),
}));

describe('Layout settings', () => {
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
});
