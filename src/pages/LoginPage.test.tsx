import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginPage } from './LoginPage';

const mocks = vi.hoisted(() => ({
  signIn: vi.fn(),
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: null,
    signIn: mocks.signIn,
  }),
}));

function renderLogin(from?: string) {
  const router = createMemoryRouter([
    { path: '/login', element: <LoginPage /> },
    { path: '/', element: <div>Signed in home</div> },
    { path: '/articles/new', element: <div>New article page</div> },
  ], { initialEntries: [{ pathname: '/login', state: from ? { from } : null }] });
  return render(<RouterProvider router={router} />);
}

async function submitCredentials(username: string, password: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/username or email/i), username);
  await user.type(screen.getByLabelText(/^password$/i), password);
  await user.click(screen.getByRole('button', { name: /^sign in$/i }));
}

describe('LoginPage', () => {
  beforeEach(() => {
    mocks.signIn.mockReset();
    mocks.signIn.mockResolvedValue(undefined);
  });

  it('describes local credentials', () => {
    renderLogin();

    expect(screen.getByText(/locally managed AGT account/i)).toBeInTheDocument();
    expect(screen.queryByText(/cognito/i)).not.toBeInTheDocument();
  });

  it('signs in and returns to the requested page', async () => {
    renderLogin('/articles/new');

    await submitCredentials('darkshadow04', 'Correct-Horse-9');

    await waitFor(() => expect(mocks.signIn).toHaveBeenCalledWith('darkshadow04', 'Correct-Horse-9'));
    expect(await screen.findByText('New article page')).toBeInTheDocument();
  });

  it('shows the sign-in error and stays on the page', async () => {
    mocks.signIn.mockRejectedValue(new Error('Invalid username or password.'));
    renderLogin();

    await submitCredentials('darkshadow04', 'wrong-password');

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid username or password.');
    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeEnabled();
    expect(screen.queryByText('Signed in home')).not.toBeInTheDocument();
  });
});
