import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsModal } from './SettingsModal';

describe('SettingsModal', () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.uiScale;
    delete document.documentElement.dataset.fontSize;
  });

  it('shows public account fallbacks and closes with Escape', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<SettingsModal user={null} onClose={onClose} />);

    expect(screen.getByText('Public user')).toBeInTheDocument();
    expect(screen.getAllByText('N/A')).toHaveLength(2);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each([
    ['Standard', 'Standard'],
    ['Admin', 'Administrator'],
  ] as const)('shows the %s group as %s', (role, accountType) => {
    render(
      <SettingsModal
        user={{ sub: 'user-1', username: 'traveller', displayName: 'Traveller', role }}
        onClose={() => undefined}
      />,
    );

    expect(screen.getByText(accountType)).toBeInTheDocument();
  });

  it('displays account details and persists accessibility settings', async () => {
    const user = userEvent.setup();
    render(
      <SettingsModal
        user={{
          sub: 'user-1',
          username: 'traveller',
          displayName: 'Traveller',
          email: 'traveller@example.com',
          role: 'Admin',
        }}
        onClose={() => undefined}
      />,
    );

    expect(screen.getByText('traveller')).toBeInTheDocument();
    expect(screen.getByText('traveller@example.com')).toBeInTheDocument();
    expect(screen.getByText('Administrator')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('UI scale'), '1.50');
    await user.selectOptions(screen.getByLabelText('Font size'), 'large');
    expect(localStorage.getItem('agt-ui-scale')).toBe('1.50');
    expect(localStorage.getItem('agt-font-size')).toBe('large');
    expect(document.documentElement).toHaveAttribute('data-ui-scale', '1.50');
    expect(document.documentElement).toHaveAttribute('data-font-size', 'large');
  });
});
