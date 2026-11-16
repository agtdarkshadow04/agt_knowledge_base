import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LogPanel } from './LogPanel';
import type { AuditLogEntry, ServerLogEntry } from './types';

const mocks = vi.hoisted(() => ({
  listServerLog: vi.fn(),
  listAuditLog: vi.fn(),
  clearServerLog: vi.fn(),
  exportLog: vi.fn(),
}));

vi.mock('./api', async (importOriginal) => ({ ...await importOriginal<typeof import('./api')>(), ...mocks }));

const serverEntry: ServerLogEntry = {
  id: '10000000-0000-4000-8000-000000000001',
  at: '2026-11-16T01:00:00.000Z',
  level: 'error',
  source: 'http',
  message: 'Unhandled API error',
  requestId: 'request-1',
  details: { error: { name: 'Error', message: 'boom' }, route: '/api/articles' },
};

const auditEntry: AuditLogEntry = {
  id: '10000000-0000-4000-8000-000000000002',
  at: '2026-11-16T01:00:00.000Z',
  lastAt: '2026-11-16T01:00:30.000Z',
  count: 3,
  actorType: 'anonymous',
  actor: null,
  ipHash: '218c1a9d04c04355',
  client: 'web',
  action: 'createAdminSession',
  method: 'POST',
  route: '/api/admin/login',
  targetType: null,
  targetId: null,
  outcome: 'denied',
  statusCode: 401,
  requestId: 'request-2',
  details: { error: 'invalid_credentials' },
};

describe('LogPanel (LOG-19, LOG-20)', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.listServerLog.mockResolvedValue({ items: [serverEntry], nextCursor: 'next' });
    mocks.listAuditLog.mockResolvedValue({ items: [auditEntry], nextCursor: null });
  });

  it('lists server log entries with their level as text, shows details, filters and pages', async () => {
    const user = userEvent.setup();
    render(<LogPanel kind="server" />);
    const row = (await screen.findByText('Unhandled API error')).closest('tr')!;
    expect(within(row).getByText('error')).toHaveClass('log-severity-error');
    await user.click(within(row).getByRole('button', { name: 'Details' }));
    expect(screen.getByLabelText('Entry details')).toHaveTextContent('"route": "/api/articles"');

    await user.selectOptions(screen.getByLabelText('Level'), 'warn');
    await user.type(screen.getByLabelText('Search'), 'boom');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(mocks.listServerLog).toHaveBeenLastCalledWith(expect.objectContaining({ level: 'warn', q: 'boom' }), '');

    await user.click(screen.getByRole('button', { name: 'Load older entries' }));
    expect(mocks.listServerLog).toHaveBeenLastCalledWith(expect.objectContaining({ level: 'warn' }), 'next');
  });

  it('clears the server log only after confirmation', async () => {
    const user = userEvent.setup();
    mocks.clearServerLog.mockResolvedValue(undefined);
    render(<LogPanel kind="server" />);
    await screen.findByText('Unhandled API error');
    await user.click(screen.getByRole('button', { name: 'Clear log' }));
    expect(mocks.clearServerLog).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog', { name: 'Clear the server log?' });
    expect(dialog).toHaveTextContent('Every server log entry is deleted. This cannot be undone. The audit log is not affected.');
    await user.click(within(dialog).getByRole('button', { name: 'Clear the server log' }));
    expect(mocks.clearServerLog).toHaveBeenCalledOnce();
    expect((await screen.findByText('The server log was cleared.')).closest('[role="status"]')).not.toBeNull();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('shows the audit log with outcomes and counts, without any way to change it, and exports CSV', async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn(() => 'blob:log');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    mocks.exportLog.mockResolvedValue({ blob: new Blob(['id']), filename: 'agt-knowledge-base-audit-log-2026-11-16T01-00-00-000Z.csv' });
    render(<LogPanel kind="audit" />);
    const row = (await screen.findByText('createAdminSession')).closest('tr')!;
    expect(within(row).getByText('Denied')).toHaveClass('log-severity-warn');
    expect(within(row).getByText('×3')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Clear/ })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Outcome'), 'denied');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    await user.selectOptions(screen.getByLabelText('Export format'), 'csv');
    await user.click(screen.getByRole('button', { name: 'Export' }));
    expect(mocks.exportLog).toHaveBeenCalledWith('audit', expect.objectContaining({ outcome: 'denied' }), 'csv');
    expect((click.mock.instances[0] as unknown as HTMLAnchorElement).download).toBe('agt-knowledge-base-audit-log-2026-11-16T01-00-00-000Z.csv');
    click.mockRestore();
  });
});
