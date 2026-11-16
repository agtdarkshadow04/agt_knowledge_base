import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackupPanel } from './BackupPanel';
import type { RestorePreview } from './types';

const mocks = vi.hoisted(() => ({
  downloadBackup: vi.fn(),
  previewBackup: vi.fn(),
  restoreBackup: vi.fn(),
}));

vi.mock('./api', async (importOriginal) => ({ ...await importOriginal<typeof import('./api')>(), ...mocks }));

const preview: RestorePreview = {
  createdAt: '2026-11-01T00:00:00.000Z',
  appVersion: '2.0.0',
  formatVersion: 1,
  schemaVersion: { backup: 17, current: 18 },
  migrations: { backup: ['001_initial'], upgrade: ['018_spec_storage'] },
  warnings: ['The dump contains log or control tables; they are ignored.'],
  counts: { app_users: 2, local_users: 2, tags: 4, articles: 7, article_revisions: 12, settings: 1, admin: 1 },
  config: {
    included: true,
    content: 'server:\n  port: 3001\n',
    diff: [{ kind: ' ', text: 'server:' }, { kind: '-', text: '  port: 4000' }, { kind: '+', text: '  port: 3001' }],
    identical: false,
  },
  ignoredSettings: ['site.title'],
};

const archive = () => new File(['PK'], 'agt-knowledge-base-backup.zip', { type: 'application/zip' });

describe('BackupPanel', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
  });

  it('previews before restoring and needs explicit confirmation', async () => {
    const user = userEvent.setup();
    const onRestored = vi.fn();
    mocks.previewBackup.mockResolvedValue(preview);
    mocks.restoreBackup.mockResolvedValue({ ...preview, preRestoreBackup: 'pre-restore-backup-2026-11-07T06-15-00-123Z.zip' });
    render(<BackupPanel onRestored={onRestored} />);

    expect(screen.queryByRole('button', { name: 'Restore backup' })).not.toBeInTheDocument();
    const file = archive();
    await user.upload(screen.getByLabelText('Backup file'), file);
    await user.click(screen.getByRole('button', { name: 'Preview backup' }));

    expect(await screen.findByRole('heading', { name: 'Backup preview' })).toBeInTheDocument();
    expect(mocks.previewBackup).toHaveBeenCalledWith(file);
    expect(mocks.restoreBackup).not.toHaveBeenCalled();
    expect(screen.getByText(/upgrades its database from schema 17 to 18/)).toBeInTheDocument();
    expect(screen.getByText('The dump contains log or control tables; they are ignored.')).toBeInTheDocument();
    expect(screen.getByText(/backup's values are ignored: site.title/)).toBeInTheDocument();
    expect(screen.getByLabelText('config.yaml differences')).toHaveTextContent(/- +port: 4000/);
    expect(screen.getByText('Article revisions').nextSibling).toHaveTextContent('12');

    const restore = screen.getByRole('button', { name: 'Restore backup' });
    expect(restore).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /permanently replaces all current data/ }));
    await user.click(restore);

    expect(await screen.findByRole('heading', { name: 'Backup restored' })).toBeInTheDocument();
    expect(mocks.restoreBackup).toHaveBeenCalledWith(file);
    expect(screen.getByText('pre-restore-backup-2026-11-07T06-15-00-123Z.zip')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(onRestored).toHaveBeenCalledOnce();
  });

  it('shows preview failures and never restores', async () => {
    const user = userEvent.setup();
    mocks.previewBackup.mockRejectedValue(new Error('The backup has format version 2; this version of AGT Knowledge Base restores up to 1. Upgrade first.'));
    render(<BackupPanel onRestored={() => undefined} />);

    await user.upload(screen.getByLabelText('Backup file'), archive());
    await user.click(screen.getByRole('button', { name: 'Preview backup' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('format version 2');
    expect(screen.queryByRole('button', { name: 'Restore backup' })).not.toBeInTheDocument();
    expect(mocks.restoreBackup).not.toHaveBeenCalled();
  });

  it('downloads the backup with the server-provided filename', async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn(() => 'blob:backup');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    mocks.downloadBackup.mockResolvedValue({ blob: new Blob(['PK']), filename: 'agt-knowledge-base-backup-2026-11-01T00-00-00-000Z.zip' });
    render(<BackupPanel onRestored={() => undefined} />);

    await user.click(screen.getByRole('button', { name: 'Download backup' }));

    expect(mocks.downloadBackup).toHaveBeenCalledOnce();
    expect((click.mock.instances[0] as unknown as HTMLAnchorElement).download).toBe('agt-knowledge-base-backup-2026-11-01T00-00-00-000Z.zip');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:backup');
    click.mockRestore();
  });

  it('uploads the archive and the action to POST /api/admin/restore as multipart/form-data (BAK-1)', async () => {
    const actual = await vi.importActual<typeof import('./api')>('./api');
    const fetch = vi.fn(async () => new Response(JSON.stringify(preview), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    try {
      const file = archive();
      await actual.previewBackup(file);
      const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('/api/admin/restore');
      expect(init.method).toBe('POST');
      expect(new Headers(init.headers).get('x-agt-request')).toBe('1');
      // The browser sets the multipart boundary itself.
      expect(new Headers(init.headers).has('content-type')).toBe(false);
      const form = init.body as FormData;
      expect(form.get('action')).toBe('preview');
      expect((form.get('backup') as File).name).toBe('agt-knowledge-base-backup.zip');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
