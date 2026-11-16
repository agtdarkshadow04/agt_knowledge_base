import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '../lib/api';
import { renderAt } from '../test/navigation';
import { Layout } from './Layout';

const mocks = vi.hoisted(() => ({
  user: null as SessionUser | null,
  signOut: vi.fn(),
}));

vi.mock('./AuthContext', () => ({
  useAuth: () => ({ user: mocks.user, signOut: mocks.signOut }),
}));

describe('Layout settings', () => {
  beforeEach(() => {
    mocks.user = null;
    mocks.signOut.mockReset();
  });

  it('opens the settings dialog from the header icon button', async () => {
    const user = userEvent.setup();
    renderAt('/', <Layout><div>Home</div></Layout>);

    const button = screen.getByRole('button', { name: 'Settings' });
    expect(button).toHaveAttribute('title', 'Settings');
    expect(button.querySelector('svg')).toBeInTheDocument();
    await user.click(button);

    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(button).toHaveAttribute('aria-expanded', 'true');
    // A11Y-2: focus moves into the dialog, Escape closes it and focus returns to the opener.
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it('applies the stored text size to the page and follows changes (A11Y-6)', async () => {
    localStorage.clear();
    localStorage.setItem('agt-font-size', 'large');
    const user = userEvent.setup();
    renderAt('/', <Layout><div>Home</div></Layout>);
    // The 1.x key moved to the new one.
    expect(document.documentElement).toHaveAttribute('data-font-scale', '1.25');
    expect(localStorage.getItem('agt-font-size')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.selectOptions(screen.getByLabelText('Text size'), '2');
    expect(document.documentElement).toHaveAttribute('data-font-scale', '2');
  });

  it('shows the UI-7 brand lockup and a support link to site.supportUrl', () => {
    renderAt('/', <Layout><div>Home</div></Layout>);
    expect(screen.getByText('Alliance of Galactic Travellers', { selector: '.brand-name' })).toBeInTheDocument();
    expect(document.querySelector('img.brand-logo')).toHaveAttribute('src', '/AgtOfficialLogo.webp');
    expect(document.querySelector('img.brand-logo')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('link', { name: 'Support' })).toHaveAttribute('href', 'https://www.nms-agt.com/support');
    for (const button of document.querySelectorAll('.header-actions .button-icon')) {
      expect(button).toHaveAttribute('aria-label');
      expect(button.getAttribute('title')).toBe(button.getAttribute('aria-label'));
    }
  });

  function renderLayout() {
    renderAt('/', <Layout><div>Home</div></Layout>);
  }

  it('never links to the admin panel, whatever the role', () => {
    for (const role of [null, 'Editor', 'Moderator'] as const) {
      mocks.user = role ? { sub: role, username: role.toLowerCase(), displayName: role, role } : null;
      const { unmount } = renderAt('/', <Layout><div>Home</div></Layout>);
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

    expect(screen.getByRole('link', { name: 'Manage tags' })).toHaveAttribute('href', '/?view=tags');
    expect(screen.getByText('Atlas · Moderator').closest('.identity-badge')).toHaveClass('moderator');
  });

  it('hides tag management from Editors', () => {
    mocks.user = { sub: 'editor', username: 'apollo', displayName: 'Apollo', role: 'Editor' };
    renderLayout();

    expect(screen.queryByRole('link', { name: /tags/i })).not.toBeInTheDocument();
    expect(screen.getByText('Apollo · Editor').closest('.identity-badge')).not.toHaveClass('moderator');
  });
});
