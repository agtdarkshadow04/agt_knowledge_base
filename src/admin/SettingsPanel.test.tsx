import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from './SettingsPanel';
import type { AdminSettingsView } from './types';

const mocks = vi.hoisted(() => ({ getSettings: vi.fn(), updateSettings: vi.fn() }));
vi.mock('./api', async (importOriginal) => ({ ...await importOriginal<typeof import('./api')>(), ...mocks }));

const view: AdminSettingsView = {
  version: 3,
  settings: {
    applicationName: { key: 'site.applicationName', value: 'File Archive', source: 'file' },
    applicationSubtitle: { key: 'site.applicationSubtitle', value: 'Dashboard subtitle', source: 'dashboard' },
    defaultVisibility: { key: 'articles.defaultVisibility', value: 'Internal', source: 'dashboard' },
    allowPublicBrowsing: { key: 'access.allowPublicBrowsing', value: true, source: 'dashboard' },
    backupMaxBytes: { key: 'backup.maxBytes', value: 104857600, source: 'default' },
    backupMaxEntries: { key: 'backup.maxEntries', value: 16, source: 'default' },
    backupMaxUncompressedBytes: { key: 'backup.maxUncompressedBytes', value: 268435456, source: 'default' },
  },
};

describe('SettingsPanel', () => {
  beforeEach(() => {
    mocks.getSettings.mockReset().mockResolvedValue(view);
    mocks.updateSettings.mockReset().mockResolvedValue(view);
  });

  it('shows file-defined settings as read-only and never sends them', async () => {
    const user = userEvent.setup();
    render(<SettingsPanel />);

    const name = await screen.findByLabelText(/Application name/);
    expect(name).toHaveValue('File Archive');
    expect(name).toHaveAttribute('readonly');
    expect(screen.getByText(/Set in the configuration file/)).toHaveTextContent('site.applicationName');
    expect(screen.getByLabelText(/Subtitle or description/)).not.toHaveAttribute('readonly');

    await user.clear(screen.getByLabelText(/Subtitle or description/));
    await user.type(screen.getByLabelText(/Subtitle or description/), 'New subtitle');
    await user.type(screen.getByLabelText(/Largest backup upload/), '52428800');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledOnce());
    const input = mocks.updateSettings.mock.calls[0][0];
    expect(input).not.toHaveProperty('applicationName');
    expect(input).toMatchObject({
      version: 3,
      applicationSubtitle: 'New subtitle',
      backupMaxBytes: 52428800,
      backupMaxEntries: null,
      backupMaxUncompressedBytes: null,
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Settings saved.');
  });

  it('shows save conflicts from the API', async () => {
    const user = userEvent.setup();
    mocks.updateSettings.mockRejectedValue(new Error('Application settings changed after you opened them. Reload and try again.'));
    render(<SettingsPanel />);
    await user.click(await screen.findByRole('button', { name: 'Save settings' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('changed after you opened them');
  });
});
