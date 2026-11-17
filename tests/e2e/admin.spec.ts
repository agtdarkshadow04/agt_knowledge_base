import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { admin } from './fixtures';

/**
 * The admin panel (TEST-6, UI-8): sign-in and sessions, the tabs, the API
 * reference (API-14), the log badge (LOG-21), backups (BAK-1), the logs
 * (LOG-19, LOG-20) and the settings (CFG-6). Each test signs in afresh, so a
 * sign-out never ends another test's session. States a fresh server cannot
 * show on demand (a newer-schema preview, file-defined settings, given log
 * entries) are answered by `page.route`; the restore itself is answered too,
 * because a real one would sign every other test out (the server tests cover
 * real restores).
 */

async function signIn(page: Page) {
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Admin sign-in' })).toBeVisible();
  await page.getByLabel('Username').fill(admin.username);
  await page.getByLabel('Password').fill(admin.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // The heading shows on the sign-in screen too; the tabs show the dashboard.
  await expect(page.getByRole('tablist')).toBeVisible();
}

async function openTab(page: Page, name: string) {
  await page.getByRole('tab', { name }).click();
  await expect(page.getByRole('tabpanel', { name })).toBeVisible();
}

test.describe('sign-in and sessions', () => {
  test('explains how to enable setup when the setup password is unset', async ({ page }) => {
    await page.route('**/api/setup/status', (route) => route.fulfill({ json: { adminExists: false, setupPasswordConfigured: false, required: true } }));
    await page.goto('/admin');
    await expect(page.getByRole('alert')).toHaveText('Setup is unavailable: AGT_KNOWLEDGE_BASE_SETUP_PASSWORD is not set. Set it in .env and restart.');
    await expect(page.getByLabel('Setup password')).toHaveCount(0);
  });

  test('shows sign-in errors without leaving the sign-in screen', async ({ page }) => {
    await page.goto('/admin');
    await page.getByLabel('Username').fill(admin.username);
    await page.getByLabel('Password').fill('Wrong-password-1!');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toHaveText('The username or password is wrong.');
    await expect(page.getByRole('heading', { name: 'Admin sign-in' })).toBeVisible();
  });

  test('signs in to every tab in the UI-8 order, moves between tabs with the arrow keys, and keeps nothing in localStorage', async ({ page }) => {
    await signIn(page);
    const tabs = page.getByRole('tab');
    await expect(tabs).toHaveText(['Users', 'Data', 'Settings', 'Server log', 'Audit log', 'Backup & restore', 'Account', 'API']);
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel', { name: 'Users' })).toBeVisible();
    await tabs.first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Data' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: 'Data' })).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('tab', { name: 'API' })).toHaveAttribute('aria-selected', 'true');
    expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  });

  test('resumes the session after a reload, and signs out to the sign-in screen', async ({ page }) => {
    await signIn(page);
    await page.reload();
    await expect(page.getByRole('tablist')).toBeVisible();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Admin sign-in' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Admin sign-in' })).toBeVisible();
  });

  test('returns to sign-in, with a status message, when the session ends mid-use', async ({ page }) => {
    await signIn(page);
    // The session ends on the server, as when it expires or the password changes elsewhere.
    await page.request.post('/api/admin/logout', { headers: { 'x-agt-request': '1' } });
    await page.getByRole('tab', { name: 'Data' }).click();
    await expect(page.getByRole('heading', { name: 'Admin sign-in' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: /session has ended/ })).toBeVisible();
  });
});

test.describe('the dashboard', () => {
  test.beforeEach(async ({ page }) => signIn(page));

  test('shows the version and renders the generated API document in the API tab (API-14)', async ({ page }) => {
    await expect(page.getByText('Version 2.0.0')).toBeVisible();
    const documentRequest = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/openapi.json');
    await openTab(page, 'API');
    await documentRequest;
    await expect(page.getByRole('heading', { name: 'AGT Knowledge Base API' })).toBeVisible();
    const settings = page.locator('section, article', { has: page.getByText('/api/admin/settings', { exact: true }) }).first();
    await expect(settings.getByText('Admin session').first()).toBeVisible();
    await expect(page.locator('.api-badge', { hasText: 'x-agt-request: 1' }).first()).toBeVisible();
    await expect(page.locator('.api-badge', { hasText: 'Deprecated' }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'OpenAPI document' })).toHaveAttribute('href', '/api/openapi.json');
  });

  test('badges the Server log tab with unseen warnings and errors, and marks them seen when it is opened (LOG-21)', async ({ page }) => {
    let seen = false;
    await page.route('**/api/admin/logs/server/summary', (route) => route.fulfill({ json: seen ? { unseenWarnings: 0, unseenErrors: 0 } : { unseenWarnings: 2, unseenErrors: 1 } }));
    await page.route('**/api/admin/logs/server/seen', (route) => { seen = true; return route.fulfill({ status: 204 }); });
    await page.reload();
    const tab = page.getByRole('tab', { name: /Server log/ });
    await expect(tab).toContainText('3');
    await tab.click();
    await expect.poll(() => seen).toBe(true);
    await expect(tab).not.toContainText('3');
  });
});

test.describe('backups (BAK-1)', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await openTab(page, 'Backup & restore');
  });

  test('downloads a backup, uploads it as multipart/form-data, and previews it before anything changes', async ({ page }) => {
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download backup' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^agt-knowledge-base-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.zip$/);
    const archive = readFileSync(await file.path());
    expect(archive.subarray(0, 2).toString()).toBe('PK');

    await page.getByLabel('Backup file').setInputFiles({ name: 'agt-knowledge-base-backup.zip', mimeType: 'application/zip', buffer: archive });
    await expect(page.getByRole('button', { name: 'Restore backup' })).toHaveCount(0);
    const upload = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/admin/restore');
    await page.getByRole('button', { name: 'Preview backup' }).click();
    // Chromium does not expose a multipart upload's body; the server accepting it shows the backup and action fields.
    const request = await upload;
    expect(request.headers()['x-agt-request']).toBe('1');
    expect(request.headers()['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    await expect(page.getByRole('heading', { name: 'Backup preview' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Restore backup' })).toBeDisabled();
  });

  test('shows what an upgrade, ignored settings and config.yaml changes mean, and restores only after confirmation', async ({ page }) => {
    const preview = {
      createdAt: '2026-11-01T00:00:00.000Z', appVersion: '2.0.0', formatVersion: 1,
      schemaVersion: { backup: 17, current: 18 }, migrations: { backup: ['001_initial'], upgrade: ['018_spec_storage'] },
      warnings: ['The dump contains log or control tables; they are ignored.'], warningCodes: ['log_tables_ignored'],
      counts: { app_users: 2, local_users: 2, tags: 4, articles: 7, article_revisions: 12, settings: 1, admin: 1 },
      config: { included: true, content: 'server:\n  port: 3001\n', diff: [{ kind: ' ', text: 'server:' }, { kind: '-', text: '  port: 4000' }, { kind: '+', text: '  port: 3001' }], identical: false },
      ignoredSettings: ['site.title'],
    };
    const report = { ...preview, preRestoreBackup: 'pre-restore-backup-2026-11-07T06-15-00-123Z.zip', upgradedFrom: 17, schemaVersion: 18, ignoredSettings: [], warnings: [], warningCodes: [], migrations: [] };
    const actions: string[] = [];
    await page.route('**/api/admin/restore', async (route) => {
      // The panel previews first and restores only after the confirmation.
      const action = actions.length === 0 ? 'preview' : 'restore';
      actions.push(action);
      return route.fulfill({ json: action === 'preview' ? preview : report });
    });
    await page.getByLabel('Backup file').setInputFiles({ name: 'backup.zip', mimeType: 'application/zip', buffer: Buffer.from('PK') });
    await page.getByRole('button', { name: 'Preview backup' }).click();
    await expect(page.getByRole('heading', { name: 'Backup preview' })).toBeVisible();
    await expect(page.getByText(/upgrades its database from schema 17 to 18/)).toBeVisible();
    await expect(page.getByText('The backup contains log or control tables; they are ignored.')).toBeVisible();
    await expect(page.getByText(/backup's values are ignored: site.title/)).toBeVisible();
    await expect(page.getByLabel('config.yaml differences')).toContainText(/- +port: 4000/);
    await expect(page.getByText('Article revisions').locator('xpath=following-sibling::*[1]')).toHaveText('12');
    const restore = page.getByRole('button', { name: 'Restore backup' });
    await expect(restore).toBeDisabled();
    expect(actions).toEqual(['preview']);
    await page.getByRole('checkbox', { name: /permanently replaces all current data/ }).check();
    await restore.click();
    await expect(page.getByRole('heading', { name: 'Backup restored' })).toBeVisible();
    expect(actions).toEqual(['preview', 'restore']);
    await expect(page.getByText(/pre-restore-backup-2026-11-07T06-15-00-123Z\.zip/)).toBeVisible();
    await page.getByRole('button', { name: 'Sign in again' }).click();
    await expect(page.getByRole('heading', { name: 'Admin sign-in' })).toBeVisible();
  });

  test('explains a rejected archive in the reader\'s words, keeps the server\'s text as details, and never restores', async ({ page }) => {
    await page.getByLabel('Backup file').setInputFiles({ name: 'not-a-backup.zip', mimeType: 'application/zip', buffer: Buffer.from('not a zip archive at all') });
    await page.getByRole('button', { name: 'Preview backup' }).click();
    const alert = page.getByRole('tabpanel').getByRole('alert');
    await expect(alert).toContainText('This backup cannot be restored. The file is not a ZIP archive.');
    await expect(alert.getByText('Technical details')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Restore backup' })).toHaveCount(0);
  });
});

test.describe('logs (LOG-19, LOG-20)', () => {
  const serverEntry = {
    id: '10000000-0000-4000-8000-000000000001', at: '2026-11-16T01:00:00.000Z', level: 'error', source: 'http',
    message: 'Unhandled API error', requestId: 'request-1', details: { error: { name: 'Error', message: 'boom' }, route: '/api/articles' },
  };
  const auditEntry = {
    id: '10000000-0000-4000-8000-000000000002', at: '2026-11-16T01:00:00.000Z', lastAt: '2026-11-16T01:00:30.000Z', count: 3,
    actorType: 'anonymous', actor: null, ipHash: '218c1a9d04c04355', client: 'web', action: 'createAdminSession', method: 'POST',
    route: '/api/admin/login', targetType: null, targetId: null, outcome: 'denied', statusCode: 401, requestId: 'request-2', details: { error: 'invalid_credentials' },
  };

  test.beforeEach(async ({ page }) => signIn(page));

  test('lists server log entries with their level as text, shows details, filters and pages', async ({ page }) => {
    const queries: URLSearchParams[] = [];
    await page.route(/\/api\/admin\/logs\/server(\?.*)?$/, (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      queries.push(new URL(route.request().url()).searchParams);
      return route.fulfill({ json: { items: [serverEntry], nextCursor: 'next' } });
    });
    await openTab(page, 'Server log');
    const row = page.getByRole('row', { name: /Unhandled API error/ });
    await expect(row.getByText('Error', { exact: true })).toHaveClass(/log-severity-error/);
    await row.getByRole('button', { name: 'Details' }).click();
    await expect(page.getByLabel('Entry details')).toContainText('"route": "/api/articles"');
    await page.getByLabel('Level').selectOption('warn');
    await page.getByLabel('Search').fill('boom');
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await expect.poll(() => queries.at(-1)?.get('q')).toBe('boom');
    expect(queries.at(-1)?.get('level')).toBe('warn');
    await page.getByRole('button', { name: 'Load older entries' }).click();
    await expect.poll(() => queries.at(-1)?.get('cursor')).toBe('next');
    expect(queries.at(-1)?.get('level')).toBe('warn');
  });

  test('clears the server log only after confirmation', async ({ page }) => {
    await openTab(page, 'Server log');
    let cleared = false;
    page.on('request', (request) => { if (request.method() === 'DELETE' && new URL(request.url()).pathname === '/api/admin/logs/server') cleared = true; });
    await page.getByRole('button', { name: 'Clear log' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Every server log entry is deleted. This cannot be undone. The audit log is not affected.');
    expect(cleared).toBe(false);
    await dialog.getByRole('button', { name: 'Clear the server log' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'The server log was cleared.' })).toBeVisible();
    expect(cleared).toBe(true);
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
  });

  test('shows the audit log with outcomes and counts, with no way to change it, and exports CSV', async ({ page }) => {
    await page.route(/\/api\/admin\/logs\/audit(\?.*)?$/, (route) => route.fulfill({ json: { items: [auditEntry], nextCursor: null } }));
    await openTab(page, 'Audit log');
    const row = page.getByRole('row', { name: /createAdminSession/ });
    await expect(row.getByText('Denied')).toHaveClass(/log-severity-warn/);
    await expect(row.getByText('×3')).toBeVisible();
    await expect(page.getByRole('button', { name: /Clear/ })).toHaveCount(0);
    await page.getByLabel('Outcome').selectOption('denied');
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await page.getByLabel('Export format').selectOption('csv');
    const download = page.waitForEvent('download');
    const request = page.waitForRequest((candidate) => new URL(candidate.url()).pathname === '/api/admin/logs/audit/export');
    await page.getByRole('button', { name: 'Export' }).click();
    const query = new URL((await request).url()).searchParams;
    expect([query.get('outcome'), query.get('format')]).toEqual(['denied', 'csv']);
    expect((await download).suggestedFilename()).toMatch(/^agt-knowledge-base-audit-log-.+\.csv$/);
  });
});

test.describe('settings (CFG-6, CFG-7)', () => {
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
      state('logs.serverRetentionDays', 30, 'default'),
      state('logs.serverMaxEntries', 100000, 'default'),
      state('logs.auditRetentionDays', 365, 'default'),
      state('logs.auditMaxEntries', 1000000, 'default'),
    ],
  };

  test.beforeEach(async ({ page }) => {
    await page.route('**/api/admin/settings', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: view }) : route.fallback()));
    await signIn(page);
  });

  test('shows file-defined settings read-only, never sends them, and shows defaults as placeholders', async ({ page }) => {
    let sent: unknown;
    await page.route('**/api/admin/settings', (route) => {
      if (route.request().method() !== 'PUT') return route.fallback();
      sent = route.request().postDataJSON();
      return route.fulfill({ json: view });
    });
    await openTab(page, 'Settings');
    const name = page.getByLabel(/Application name/);
    await expect(name).toHaveValue('File Archive');
    await expect(name).toHaveAttribute('readonly', '');
    await expect(page.getByText(/Set in the configuration file/)).toContainText('site.title');
    await expect(page.getByLabel(/Subtitle or description/)).not.toHaveAttribute('readonly');
    const upload = page.getByLabel(/Largest backup upload/);
    await expect(upload).toHaveValue('');
    await expect(upload).toHaveAttribute('placeholder', 'Default: 104,857,600');
    await expect(page.getByLabel(/Most entries/)).toHaveValue('30');
    await page.getByLabel(/Subtitle or description/).fill('New subtitle');
    await upload.fill('52428800');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'The settings were saved.' })).toBeVisible();
    const values = (sent as { values: Record<string, unknown> }).values;
    expect(values).not.toHaveProperty('site.title');
    expect(values).toMatchObject({ 'site.subtitle': 'New subtitle', 'backup.maxZipBytes': 52428800 });
  });

  test('shows errors from the API in the reader\'s words', async ({ page }) => {
    await page.route('**/api/admin/settings', (route) => (route.request().method() === 'PUT'
      ? route.fulfill({ status: 409, json: { error: 'defined_in_config', message: 'site.title is set in config.yaml.', params: { key: 'site.title' } } })
      : route.fallback()));
    await openTab(page, 'Settings');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByRole('tabpanel').getByRole('alert')).toContainText('site.title is set in config.yaml and cannot be changed here.');
  });
});
