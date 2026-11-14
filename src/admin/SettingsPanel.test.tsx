import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from './SettingsPanel';
import type { AdminSettingsView } from './types';

const mocks = vi.hoisted(() => ({ getSettings: vi.fn(), updateSettings: vi.fn() }));
vi.mock('./api', async (importOriginal) => ({ ...await importOriginal<typeof import('./api')>(), ...mocks }));

const state = (key: string, value: unknown, source: 'config' | 'dashboard' | 'default', defaultValue: unknown = value) => ({
  key, value, source, locked: source === 'config', default: defaultValue, description: `${key} description`,
});

const view = {
  states: [
    state('site.title', 'File Archive', 'config', 'AGT Knowledge Base'),
    state('site.subtitle', 'Dashboard subtitle', 'dashboard', 'Default subtitle'),
    state('site.supportUrl', 'https://www.nms-agt.com/support', 'default'),
    state('articles.defaultVisibility', 'Internal', 'dashboard'),
    state('access.allowPublicBrowsing', true, 'dashboard'),
    state('backup.maxZipBytes', 104857600, 'default'),
    state('backup.maxUncompressedBytes', 268435456, 'default'),
    state('backup.maxEntries', 30, 'dashboard', 16),
  ],
} as AdminSettingsView;

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
    expect(screen.getByText(/Set in the configuration file/)).toHaveTextContent('site.title');
    expect(screen.getByLabelText(/Subtitle or description/)).not.toHaveAttribute('readonly');

    await user.clear(screen.getByLabelText(/Subtitle or description/));
    await user.type(screen.getByLabelText(/Subtitle or description/), 'New subtitle');
    await user.type(screen.getByLabelText(/Largest backup upload/), '52428800');
    await user.clear(screen.getByLabelText(/Most entries/));
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledOnce());
    // Only changed keys are sent; clearing a limit resets it to its default.
    expect(mocks.updateSettings.mock.calls[0][0]).toEqual({
      values: {
        'site.subtitle': 'New subtitle',
        'backup.maxZipBytes': 52428800,
        'backup.maxEntries': null,
      },
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Settings saved.');
  });

  it('shows errors from the API', async () => {
    const user = userEvent.setup();
    mocks.updateSettings.mockRejectedValue(new Error('site.title is defined in the configuration file and cannot be changed from the dashboard.'));
    render(<SettingsPanel />);
    await user.click(await screen.findByRole('button', { name: 'Save settings' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('defined in the configuration file');
  });

  it('shows defaults as placeholders for limits left at their default', async () => {
    render(<SettingsPanel />);
    const upload = await screen.findByLabelText(/Largest backup upload/);
    expect(upload).toHaveValue(null);
    expect(upload).toHaveAttribute('placeholder', `Default: ${(104857600).toLocaleString()}`);
    expect(screen.getByLabelText(/Most entries/)).toHaveValue(30);
  });
});
