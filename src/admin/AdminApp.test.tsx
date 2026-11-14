import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../services/api';
import { AdminApp } from './AdminApp';

const mocks = vi.hoisted(() => ({
  getSetupStatus: vi.fn(),
  getSession: vi.fn(),
  completeSetup: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  listUsers: vi.fn(),
}));

vi.mock('./api', async (importOriginal) => ({ ...await importOriginal<typeof import('./api')>(), ...mocks }));

const session = { username: 'atlas', setupPasswordSet: false, version: '2.0.0' };

/** A small document in the shape the server generates (GET /api/openapi.json). */
const apiDocument = {
  openapi: '3.1.0',
  info: { title: 'AGT Knowledge Base API', version: '2.0.0' },
  components: {
    securitySchemes: {
      sessionCookie: { type: 'apiKey', in: 'cookie', name: 'agt_admin_session' },
      csrfHeader: { type: 'apiKey', in: 'header', name: 'x-agt-request' },
    },
  },
  tags: [{ name: 'admin' }, { name: 'auth' }],
  paths: {
    '/api/admin/settings': {
      put: {
        operationId: 'updateSettings',
        tags: ['admin'],
        summary: 'Change dashboard settings.',
        security: [{ sessionCookie: [], csrfHeader: [] }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { version: { type: 'integer' } }, required: ['version'] } } } },
        responses: { 200: { description: 'Default Response' } },
      },
    },
    '/api/admin/auth/login': {
      post: {
        operationId: 'createAdminSessionDeprecated',
        tags: ['auth'],
        summary: 'Deprecated: use POST /api/admin/login.',
        deprecated: true,
        security: [{ csrfHeader: [] }],
        responses: { 200: { description: 'Default Response' } },
      },
    },
  },
};

describe('AdminApp', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    localStorage.clear();
    mocks.getSetupStatus.mockResolvedValue({ required: false, setupPasswordConfigured: false });
    mocks.getSession.mockResolvedValue(null);
    mocks.listUsers.mockResolvedValue({ items: [], page: 1, pageSize: 25, total: 0, totalPages: 1 });
    mocks.signOut.mockResolvedValue(undefined);
  });

  it('shows first-run setup on a fresh installation and opens the dashboard afterwards', async () => {
    const user = userEvent.setup();
    mocks.getSetupStatus.mockResolvedValue({ required: true, setupPasswordConfigured: true });
    mocks.completeSetup.mockResolvedValue({ username: 'atlas', setupPasswordSet: true, version: '2.0.0' });
    render(<AdminApp />);

    expect(await screen.findByRole('heading', { name: 'Create the Admin account' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Setup password'), 'one-time');
    await user.type(screen.getByLabelText('Admin username'), 'atlas');
    await user.type(screen.getByLabelText('New password'), 'Permanent123!');
    await user.type(screen.getByLabelText('Confirm new password'), 'Permanent123!');
    await user.click(screen.getByRole('button', { name: 'Complete setup' }));

    expect(mocks.completeSetup).toHaveBeenCalledWith({
      setupPassword: 'one-time',
      username: 'atlas',
      password: 'Permanent123!',
      passwordConfirmation: 'Permanent123!',
    });
    expect(await screen.findByRole('heading', { name: 'Administration' })).toBeInTheDocument();
    // The setup password is still configured, so the dashboard reminds the Admin to remove it.
    expect(screen.getByRole('alert')).toHaveTextContent('AGT_KNOWLEDGE_BASE_SETUP_PASSWORD is still set');
  });

  it('explains how to enable setup when AGT_KNOWLEDGE_BASE_SETUP_PASSWORD is unset', async () => {
    mocks.getSetupStatus.mockResolvedValue({ required: true, setupPasswordConfigured: false });
    render(<AdminApp />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Setup is disabled');
    expect(screen.queryByLabelText('Setup password')).not.toBeInTheDocument();
  });

  it('asks an existing installation to sign in, then shows every dashboard tab', async () => {
    const user = userEvent.setup();
    mocks.signIn.mockResolvedValue(session);
    render(<AdminApp />);

    expect(await screen.findByRole('heading', { name: 'Admin sign-in' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Username'), 'atlas');
    await user.type(screen.getByLabelText('Password'), 'Permanent123!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Administration' })).toBeInTheDocument();
    const tabs = screen.getByRole('navigation', { name: 'Administration sections' });
    expect([...tabs.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Users', 'Data', 'Settings', 'Backup & restore', 'Account', 'API']);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // The member session is untouched.
    expect(localStorage.length).toBe(0);
  });

  it('shows sign-in errors without leaving the login screen', async () => {
    const user = userEvent.setup();
    mocks.signIn.mockRejectedValue(new ApiError('Invalid username or password.', 401));
    render(<AdminApp />);
    await screen.findByRole('heading', { name: 'Admin sign-in' });
    await user.type(screen.getByLabelText('Username'), 'atlas');
    await user.type(screen.getByLabelText('Password'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid username or password.');
  });

  it('resumes an existing session, and signs out to the login screen', async () => {
    const user = userEvent.setup();
    localStorage.setItem('agt-local-auth-token', 'member-token');
    mocks.getSession.mockResolvedValue(session);
    render(<AdminApp />);

    expect(await screen.findByRole('heading', { name: 'Administration' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Admin sign-in' })).toBeInTheDocument();
    expect(mocks.signOut).toHaveBeenCalledOnce();
    expect(localStorage.getItem('agt-local-auth-token')).toBe('member-token');
  });

  it('shows the version in the header and renders the generated API document in the API tab (API-14)', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(apiDocument), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      mocks.getSession.mockResolvedValue(session);
      render(<AdminApp />);
      await screen.findByRole('heading', { name: 'Administration' });
      expect(screen.getByText('Version 2.0.0')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'API' }));

      expect(await screen.findByRole('heading', { name: 'AGT Knowledge Base API' })).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledWith('/api/openapi.json', expect.anything());
      const settings = screen.getByRole('article', { name: 'Change dashboard settings.' });
      expect(within(settings).getByText('/api/admin/settings')).toBeInTheDocument();
      expect(within(settings).getByText('Admin session')).toBeInTheDocument();
      expect(within(settings).getByText('x-agt-request: 1', { selector: '.api-badge' })).toBeInTheDocument();
      const legacy = screen.getByRole('article', { name: 'Deprecated: use POST /api/admin/login.' });
      expect(within(legacy).getByText('Deprecated', { selector: '.api-badge' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'OpenAPI document' })).toHaveAttribute('href', '/api/openapi.json');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns to sign-in when the session ends mid-use', async () => {
    mocks.getSession.mockResolvedValue(session);
    render(<AdminApp />);
    await screen.findByRole('heading', { name: 'Administration' });
    act(() => { window.dispatchEvent(new Event('agt-admin-unauthorized')); });
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Admin sign-in' })).toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent('session has ended');
  });
});

describe('bundle separation', () => {
  const sources = import.meta.glob<string>(['../**/*.ts', '../**/*.tsx', '!../admin/**', '!../**/*.test.ts', '!../**/*.test.tsx'], { query: '?raw', import: 'default', eager: true });
  const html = import.meta.glob<string>('../../*.html', { query: '?raw', import: 'default', eager: true });

  it('keeps admin panel code out of the member bundle', () => {
    const memberFiles = Object.entries(sources);
    expect(memberFiles.length).toBeGreaterThan(10);
    for (const [path, source] of memberFiles) {
      expect(source, path).not.toMatch(/from ['"][./]*admin\//);
      expect(source, path).not.toMatch(/['"]\/admin['"]/);
      expect(source, path).not.toContain('openapi-admin.yaml');
    }
  });

  it('serves the admin panel from its own HTML entry', () => {
    expect(html['../../admin.html']).toContain('/src/admin/main.tsx');
    expect(html['../../index.html']).not.toContain('admin');
  });
});
