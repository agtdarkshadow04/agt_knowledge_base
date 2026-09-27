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

  it('displays account details and persists accessibility settings', async () => {
    const user = userEvent.setup();
    render(
      <SettingsModal
        user={{
          sub: 'user-1',
          username: 'traveller',
          displayName: 'Traveller',
          email: 'traveller@example.com',
          createdAt: '2024-03-12T10:15:00.000Z',
          role: 'Standard',
        }}
        onClose={() => undefined}
      />,
    );

    expect(screen.getByText('traveller')).toBeInTheDocument();
    expect(screen.getByText('traveller@example.com')).toBeInTheDocument();
    expect(screen.getByText('March 12, 2024')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('UI scale'), '1.50');
    await user.selectOptions(screen.getByLabelText('Font size'), 'large');
    expect(localStorage.getItem('agt-ui-scale')).toBe('1.50');
    expect(localStorage.getItem('agt-font-size')).toBe('large');
    expect(document.documentElement).toHaveAttribute('data-ui-scale', '1.50');
    expect(document.documentElement).toHaveAttribute('data-font-size', 'large');
  });
});
