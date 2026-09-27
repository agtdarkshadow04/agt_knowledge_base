import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginPage } from './LoginPage';

const mocks = vi.hoisted(() => ({
  signIn: vi.fn(),
  completeNewPassword: vi.fn(),
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: null,
    configured: true,
    signIn: mocks.signIn,
    completeNewPassword: mocks.completeNewPassword,
  }),
}));

function renderLogin() {
  const router = createMemoryRouter([
    { path: '/login', element: <LoginPage /> },
    { path: '/', element: <div>Signed in home</div> },
  ], { initialEntries: ['/login'] });
  return render(<RouterProvider router={router} />);
}

describe('LoginPage', () => {
  beforeEach(() => {
    mocks.signIn.mockReset();
    mocks.completeNewPassword.mockReset();
    mocks.signIn.mockResolvedValue('SIGNED_IN');
    mocks.completeNewPassword.mockResolvedValue(undefined);
  });

  it('completes Cognito first-login password setup', async () => {
    const user = userEvent.setup();
    mocks.signIn.mockResolvedValue('NEW_PASSWORD_REQUIRED');
    renderLogin();

    await user.type(screen.getByLabelText(/username or email/i), 'darkshadow04');
    await user.type(screen.getByLabelText(/^password$/i), 'Temporary1!');
    await user.click(screen.getByRole('button', { name: /^sign in$/i }));

    expect(mocks.signIn).toHaveBeenCalledWith('darkshadow04', 'Temporary1!');
    expect(await screen.findByRole('heading', { name: /choose a permanent password/i })).toBeInTheDocument();

    const newPassword = screen.getByLabelText(/^new password$/i);
    const confirmPassword = screen.getByLabelText(/confirm new password/i);
    await user.type(newPassword, 'Permanent123!');
    await user.type(confirmPassword, 'Permanent123!');
    expect(newPassword).toHaveValue('Permanent123!');
    expect(confirmPassword).toHaveValue('Permanent123!');
    await user.click(screen.getByRole('button', { name: /set password and sign in/i }));

    await waitFor(() => expect(mocks.completeNewPassword).toHaveBeenCalledWith('Permanent123!'));
    expect(await screen.findByText('Signed in home')).toBeInTheDocument();
  });

  it('does not submit mismatched permanent passwords', async () => {
    const user = userEvent.setup();
    mocks.signIn.mockResolvedValue('NEW_PASSWORD_REQUIRED');
    renderLogin();

    await user.type(screen.getByLabelText(/username or email/i), 'darkshadow04');
    await user.type(screen.getByLabelText(/^password$/i), 'Temporary1!');
    await user.click(screen.getByRole('button', { name: /^sign in$/i }));
    await user.type(await screen.findByLabelText(/^new password$/i), 'Permanent123!');
    await user.type(screen.getByLabelText(/confirm new password/i), 'Different123!');
    await user.click(screen.getByRole('button', { name: /set password and sign in/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The new passwords do not match.');
    expect(mocks.completeNewPassword).not.toHaveBeenCalled();
  });
});
