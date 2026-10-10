import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SetupPage } from './SetupPage';

const mocks = vi.hoisted(() => ({ completeSetup: vi.fn() }));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ completeSetup: mocks.completeSetup }),
}));

function renderSetup() {
  const router = createMemoryRouter([
    { path: '/setup', element: <SetupPage /> },
    { path: '/admin', element: <div>Admin dashboard</div> },
  ], { initialEntries: ['/setup'] });
  return render(<RouterProvider router={router} />);
}

describe('SetupPage', () => {
  beforeEach(() => {
    mocks.completeSetup.mockReset();
    mocks.completeSetup.mockResolvedValue(undefined);
  });

  it('creates the first administrator and opens the admin area', async () => {
    const user = userEvent.setup();
    renderSetup();
    await user.type(screen.getByLabelText('Username'), 'atlas');
    await user.type(screen.getByLabelText('Display name'), 'Atlas');
    await user.type(screen.getByLabelText('Email (optional)'), 'atlas@example.com');
    await user.type(screen.getByLabelText('Password'), 'Permanent123!');
    await user.type(screen.getByLabelText('Confirm password'), 'Permanent123!');
    await user.click(screen.getByRole('button', { name: 'Complete setup' }));

    await waitFor(() => expect(mocks.completeSetup).toHaveBeenCalledWith({
      username: 'atlas',
      displayName: 'Atlas',
      email: 'atlas@example.com',
      password: 'Permanent123!',
      passwordConfirmation: 'Permanent123!',
    }));
    expect(await screen.findByText('Admin dashboard')).toBeInTheDocument();
  });

  it('does not submit mismatched passwords', async () => {
    const user = userEvent.setup();
    renderSetup();
    await user.type(screen.getByLabelText('Username'), 'atlas');
    await user.type(screen.getByLabelText('Display name'), 'Atlas');
    await user.type(screen.getByLabelText('Password'), 'Permanent123!');
    await user.type(screen.getByLabelText('Confirm password'), 'Different123!');
    await user.click(screen.getByRole('button', { name: 'Complete setup' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Passwords do not match.');
    expect(mocks.completeSetup).not.toHaveBeenCalled();
  });
});
