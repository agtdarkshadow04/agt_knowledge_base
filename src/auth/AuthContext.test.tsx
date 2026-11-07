import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '../types';
import { AuthProvider, useAuth } from './AuthContext';

const mocks = vi.hoisted(() => ({
  getLocalSession: vi.fn(),
  createLocalSession: vi.fn(),
}));

vi.mock('../services/api', () => mocks);

const tokenKey = 'agt-local-auth-token';
const traveller: SessionUser = { sub: 'user-1', username: 'traveller', displayName: 'Traveller', role: 'Editor' };

function Probe() {
  const { user, loading, signIn, signOut, getToken } = useAuth();
  return (
    <div>
      <p>{loading ? 'loading' : 'ready'}</p>
      <p>user:{user?.username ?? 'none'}</p>
      <button type="button" onClick={() => void signIn('traveller', 'Correct-Horse-9')}>sign in</button>
      <button type="button" onClick={() => void signOut()}>sign out</button>
      <button type="button" onClick={() => void getToken().catch((error: Error) => { document.title = error.message; })}>token</button>
    </div>
  );
}

function renderProvider() {
  return render(<AuthProvider><Probe /></AuthProvider>);
}

describe('AuthProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    document.title = '';
    Object.values(mocks).forEach((mock) => mock.mockReset());
  });

  it('restores the session from a stored token', async () => {
    localStorage.setItem(tokenKey, 'stored-token');
    mocks.getLocalSession.mockResolvedValue(traveller);
    renderProvider();

    expect(await screen.findByText('user:traveller')).toBeInTheDocument();
    expect(mocks.getLocalSession).toHaveBeenCalledWith('stored-token');
  });

  it('discards a stored token the API rejects', async () => {
    localStorage.setItem(tokenKey, 'expired-token');
    mocks.getLocalSession.mockRejectedValue(new Error('Invalid or expired authentication token.'));
    renderProvider();

    expect(await screen.findByText('ready')).toBeInTheDocument();
    expect(screen.getByText('user:none')).toBeInTheDocument();
    expect(localStorage.getItem(tokenKey)).toBeNull();
  });

  it('stores the token on sign-in and removes it on sign-out', async () => {
    const user = userEvent.setup();
    mocks.createLocalSession.mockResolvedValue({ token: 'new-token', user: traveller });
    renderProvider();
    await screen.findByText('ready');

    await user.click(screen.getByRole('button', { name: 'sign in' }));
    expect(await screen.findByText('user:traveller')).toBeInTheDocument();
    expect(mocks.createLocalSession).toHaveBeenCalledWith('traveller', 'Correct-Horse-9');
    expect(localStorage.getItem(tokenKey)).toBe('new-token');

    await user.click(screen.getByRole('button', { name: 'sign out' }));
    expect(await screen.findByText('user:none')).toBeInTheDocument();
    expect(localStorage.getItem(tokenKey)).toBeNull();
  });

  it('reports an expired session when no token is stored', async () => {
    const user = userEvent.setup();
    renderProvider();
    await screen.findByText('ready');

    await user.click(screen.getByRole('button', { name: 'token' }));
    await waitFor(() => expect(document.title).toBe('Your session has expired. Sign in again.'));
  });
});
