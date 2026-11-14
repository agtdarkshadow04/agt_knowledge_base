import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '../types';
import { AuthProvider, useAuth } from './AuthContext';

const mocks = vi.hoisted(() => ({
  getLocalSession: vi.fn(),
  createLocalSession: vi.fn(),
  deleteLocalSession: vi.fn(),
}));

vi.mock('../services/api', () => mocks);

const legacyTokenKey = 'agt-local-auth-token';
const traveller: SessionUser = { sub: 'user-1', username: 'traveller', displayName: 'Traveller', role: 'Editor' };

function Probe() {
  const { user, loading, signIn, signOut } = useAuth();
  return (
    <div>
      <p>{loading ? 'loading' : 'ready'}</p>
      <p>user:{user?.username ?? 'none'}</p>
      <button type="button" onClick={() => void signIn('traveller', 'Correct-Horse-9')}>sign in</button>
      <button type="button" onClick={() => void signOut().catch(() => undefined)}>sign out</button>
    </div>
  );
}

function renderProvider() {
  return render(<AuthProvider><Probe /></AuthProvider>);
}

describe('AuthProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.values(mocks).forEach((mock) => mock.mockReset());
  });

  it('restores the session from the session cookie', async () => {
    mocks.getLocalSession.mockResolvedValue(traveller);
    renderProvider();

    expect(await screen.findByText('user:traveller')).toBeInTheDocument();
    expect(mocks.getLocalSession).toHaveBeenCalledWith();
  });

  it('starts signed out when the API has no session, and drops a 1.x stored token (FE-3)', async () => {
    localStorage.setItem(legacyTokenKey, 'old-token');
    mocks.getLocalSession.mockRejectedValue(new Error('Sign-in is required.'));
    renderProvider();

    expect(await screen.findByText('ready')).toBeInTheDocument();
    expect(screen.getByText('user:none')).toBeInTheDocument();
    expect(localStorage.getItem(legacyTokenKey)).toBeNull();
  });

  it('signs in and out through the API, keeping nothing in localStorage', async () => {
    const user = userEvent.setup();
    mocks.getLocalSession.mockRejectedValue(new Error('Sign-in is required.'));
    mocks.createLocalSession.mockResolvedValue(traveller);
    mocks.deleteLocalSession.mockResolvedValue(undefined);
    renderProvider();
    await screen.findByText('ready');

    await user.click(screen.getByRole('button', { name: 'sign in' }));
    expect(await screen.findByText('user:traveller')).toBeInTheDocument();
    expect(mocks.createLocalSession).toHaveBeenCalledWith('traveller', 'Correct-Horse-9');
    expect(localStorage.length).toBe(0);

    await user.click(screen.getByRole('button', { name: 'sign out' }));
    expect(await screen.findByText('user:none')).toBeInTheDocument();
    expect(mocks.deleteLocalSession).toHaveBeenCalledOnce();
  });

  it('signs out locally even when the logout request fails', async () => {
    const user = userEvent.setup();
    mocks.getLocalSession.mockResolvedValue(traveller);
    mocks.deleteLocalSession.mockRejectedValue(new Error('offline'));
    renderProvider();
    await screen.findByText('user:traveller');

    await user.click(screen.getByRole('button', { name: 'sign out' }));
    expect(await screen.findByText('user:none')).toBeInTheDocument();
  });
});
