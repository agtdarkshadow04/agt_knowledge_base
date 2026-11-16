import { render, screen } from '@testing-library/react';
import { I18nProvider } from './I18n';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { preferencesChangedEvent } from '../lib/preferences';
import { SettingsModal } from './SettingsModal';

describe('SettingsModal', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('shows public account fallbacks and closes with Escape', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<SettingsModal user={null} onClose={onClose} />);

    expect(screen.getByRole('dialog', { name: 'Settings' })).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('Not signed in')).toBeInTheDocument();
    expect(screen.getAllByText('N/A')).toHaveLength(2);
    expect(screen.queryByRole('combobox', { name: 'Article downloads' })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each([
    ['Editor', 'Editor'],
    ['Moderator', 'Moderator'],
  ] as const)('shows the %s group as %s', (role, accountType) => {
    render(
      <SettingsModal
        user={{ sub: 'user-1', username: 'traveller', displayName: 'Traveller', role }}
        onClose={() => undefined}
      />,
    );

    expect(screen.getByText(accountType)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Article downloads' })).toHaveValue('false');
  });

  it('displays account details and stores the preferences under agt_knowledge_base_* keys (FE-3, A11Y-6)', async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    window.addEventListener(preferencesChangedEvent, changed);
    render(
      <SettingsModal
        user={{
          sub: 'user-1',
          username: 'traveller',
          displayName: 'Traveller',
          email: 'traveller@example.com',
          role: 'Moderator',
        }}
        onClose={() => undefined}
      />,
    );

    expect(screen.getByText('traveller')).toBeInTheDocument();
    expect(screen.getByText('traveller@example.com')).toBeInTheDocument();
    expect(screen.getByText('Moderator')).toBeInTheDocument();

    expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual([
      'Language and display',
      'Articles',
      'Account',
    ]);
    expect(screen.getByRole('combobox', { name: 'Search results' })).toHaveValue('cards');
    expect(screen.getByRole('combobox', { name: 'Article downloads' })).toHaveValue('false');
    const scale = screen.getByRole('combobox', { name: 'Text size' });
    expect([...scale.querySelectorAll('option')].map((option) => option.value)).toEqual(['1', '1.25', '1.5', '1.75', '2']);

    await user.selectOptions(screen.getByLabelText('Search results'), 'rows');
    await user.selectOptions(screen.getByLabelText('Article downloads'), 'true');
    await user.selectOptions(scale, '1.5');
    // I18N-4: one agt_knowledge_base_settings object, shared with the admin dashboard.
    expect(JSON.parse(localStorage.getItem('agt_knowledge_base_settings')!)).toMatchObject({ searchResults: 'rows', allowDownloads: true, fontScale: '1.5' });
    expect(Object.keys(localStorage)).toEqual(['agt_knowledge_base_settings']);
    expect(changed).toHaveBeenCalledTimes(3);
    window.removeEventListener(preferencesChangedEvent, changed);
  });

  it('switches the whole interface and <html lang> to the chosen language (I18N-3, I18N-4)', async () => {
    const user = userEvent.setup();
    render(<I18nProvider><SettingsModal user={null} onClose={() => undefined} /></I18nProvider>);

    expect(document.documentElement.lang).toBe('en');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'fr');

    expect(await screen.findByRole('dialog', { name: 'Paramètres' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Langue' })).toHaveValue('fr');
    expect(document.documentElement.lang).toBe('fr');
    expect(JSON.parse(localStorage.getItem('agt_knowledge_base_settings')!)).toMatchObject({ language: 'fr' });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Langue' }), 'pt');
    expect(document.documentElement.lang).toBe('pt-BR');
  });
});
