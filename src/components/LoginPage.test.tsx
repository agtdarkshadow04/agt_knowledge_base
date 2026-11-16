import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '../lib/api';
import { ApiError } from '../lib/client';
import { currentUrl, renderAt, RouteProbe } from '../test/navigation';
import { LoginPage } from './LoginPage';

const mocks = vi.hoisted(() => ({
  user: null as SessionUser | null,
  signIn: vi.fn(),
}));

vi.mock('./AuthContext', () => ({
  useAuth: () => ({
    user: mocks.user,
    signIn: mocks.signIn,
  }),
}));

function renderLogin(next?: string) {
  return renderAt(next ? `/?view=login&next=${encodeURIComponent(next)}` : '/?view=login', <><LoginPage /><RouteProbe /></>);
}

async function submitCredentials(username: string, password: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/username or email/i), username);
  await user.type(screen.getByLabelText(/^password$/i), password);
  await user.click(screen.getByRole('button', { name: /^sign in$/i }));
}

describe('LoginPage', () => {
  beforeEach(() => {
    mocks.user = null;
    mocks.signIn.mockReset();
    mocks.signIn.mockImplementation(async (username: string) => {
      mocks.user = { sub: 'member', username, displayName: username, role: 'Editor' };
    });
  });

  it('describes local credentials', () => {
    renderLogin();

    expect(screen.getByText(/AGT Knowledge Base account/i)).toBeInTheDocument();
    expect(screen.queryByText(/cognito/i)).not.toBeInTheDocument();
  });

  it('signs in and returns to the requested page', async () => {
    renderLogin('/?view=new');

    await submitCredentials('darkshadow04', 'Correct-Horse-9');

    await waitFor(() => expect(mocks.signIn).toHaveBeenCalledWith('darkshadow04', 'Correct-Horse-9'));
    await waitFor(() => expect(screen.getByTestId('route')).toHaveTextContent('new'));
    expect(currentUrl()).toBe('/?view=new');
  });

  it('never returns to another site after signing in', async () => {
    renderLogin('https://evil.example/');
    expect(currentUrl()).toBe('/?view=login');
    await submitCredentials('darkshadow04', 'Correct-Horse-9');
    await waitFor(() => expect(currentUrl()).toBe('/'));
  });

  it('shows the sign-in error and stays on the page', async () => {
    // I18N-6: the reader sees the translation of the error code, not the server's English message.
    mocks.signIn.mockRejectedValue(new ApiError(401, 'Invalid username or password.', 'invalid_credentials'));
    renderLogin();

    await submitCredentials('darkshadow04', 'wrong-password');

    expect(await screen.findByRole('alert')).toHaveTextContent('The username or password is wrong.');
    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeEnabled();
    expect(screen.getByTestId('route')).toHaveTextContent('login');
  });
});
