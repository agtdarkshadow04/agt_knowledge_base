import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackupPanel } from './BackupPanel';

const mocks = vi.hoisted(() => ({
  downloadDatabaseBackup: vi.fn(),
  getToken: vi.fn(async () => 'token'),
  restoreDatabaseBackup: vi.fn(),
  signOut: vi.fn(async () => undefined),
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { sub: 'admin', username: 'atlas', displayName: 'Atlas', role: 'Admin', isSuperAdmin: true },
    getToken: mocks.getToken,
    signOut: mocks.signOut,
  }),
}));

vi.mock('../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/api')>();
  return {
    ...actual,
    downloadDatabaseBackup: mocks.downloadDatabaseBackup,
    restoreDatabaseBackup: mocks.restoreDatabaseBackup,
  };
});

const restored = {
  app_users: 2,
  local_users: 2,
  tags: 4,
  articles: 7,
  article_revisions: 12,
  application_settings: 1,
};

describe('BackupPanel', () => {
  beforeAll(() => {
    // jsdom does not implement Blob.text(), which every supported browser has.
    if (!Blob.prototype.text) {
      Blob.prototype.text = function text(this: Blob) {
        return new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsText(this);
        });
      };
    }
  });

  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockClear());
    mocks.restoreDatabaseBackup.mockReset();
  });

  it('requires a file and explicit confirmation before restoring', async () => {
    const user = userEvent.setup();
    mocks.restoreDatabaseBackup.mockResolvedValue({ restored });
    render(<BackupPanel />);

    const restore = screen.getByRole('button', { name: 'Restore backup' });
    expect(restore).toBeDisabled();
    await user.upload(screen.getByLabelText('Backup file'), new File(['{"format":"agt"}'], 'backup.json', { type: 'application/json' }));
    expect(restore).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /permanently replaces all current data/ }));
    await user.click(restore);

    expect(await screen.findByRole('heading', { name: 'Backup restored' })).toBeInTheDocument();
    expect(mocks.restoreDatabaseBackup).toHaveBeenCalledWith('{"format":"agt"}', 'token');
    expect(screen.getByText('Article revisions').nextSibling).toHaveTextContent('12');
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeInTheDocument();
  });

  it('shows restore failures without leaving the form', async () => {
    const user = userEvent.setup();
    mocks.restoreDatabaseBackup.mockRejectedValue(new Error('The backup cannot be restored: it was created with a different database schema version.'));
    render(<BackupPanel />);

    await user.upload(screen.getByLabelText('Backup file'), new File(['{}'], 'backup.json', { type: 'application/json' }));
    await user.click(screen.getByRole('checkbox', { name: /permanently replaces all current data/ }));
    await user.click(screen.getByRole('button', { name: 'Restore backup' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('different database schema version');
    expect(screen.getByRole('button', { name: 'Restore backup' })).toBeEnabled();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it('downloads the backup with the server-provided filename', async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn(() => 'blob:backup');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    mocks.downloadDatabaseBackup.mockResolvedValue({ blob: new Blob(['{}']), filename: 'agt-backup-20261101-000000.json' });
    render(<BackupPanel />);

    await user.click(screen.getByRole('button', { name: 'Download backup' }));

    expect(mocks.downloadDatabaseBackup).toHaveBeenCalledWith('token');
    expect(click).toHaveBeenCalledOnce();
    expect((click.mock.instances[0] as unknown as HTMLAnchorElement).download).toBe('agt-backup-20261101-000000.json');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:backup');
    click.mockRestore();
  });
});
