import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import type { CanonicalTag } from '../types';
import { TagPicker } from './TagPicker';

const tags: CanonicalTag[] = Array.from({ length: 13 }, (_, index) => ({
  id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  name: `Tag ${index + 1}`,
  color: '#B5C3B7',
}));

function PickerHarness({ initial = [] }: { initial?: string[] }) {
  const [selectedIds, setSelectedIds] = useState(initial);
  return <TagPicker tags={tags} selectedIds={selectedIds} onChange={setSelectedIds} />;
}

describe('TagPicker', () => {
  it('shows ten matches initially and reveals more in batches', async () => {
    const user = userEvent.setup();
    render(<PickerHarness />);

    await user.click(screen.getByRole('combobox', { name: 'Tags' }));
    expect(screen.getAllByRole('option')).toHaveLength(10);
    await user.click(screen.getByRole('button', { name: 'Show More' }));
    expect(screen.getAllByRole('option')).toHaveLength(13);
  });

  it('never turns arbitrary search text into a selected value', async () => {
    const user = userEvent.setup();
    render(<PickerHarness />);

    const input = screen.getByRole('combobox', { name: 'Tags' });
    await user.type(input, 'not a canonical tag{Enter}');
    expect(screen.getByText('0 of 12 tags selected.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Selected tags' })).not.toBeInTheDocument();
  });

  it('supports keyboard selection and removable stored-color chips', async () => {
    const user = userEvent.setup();
    render(<PickerHarness />);

    const input = screen.getByRole('combobox', { name: 'Tags' });
    await user.type(input, 'Tag 13{Enter}');
    expect(screen.getByText('1 of 12 tags selected.')).toBeInTheDocument();
    const chip = within(screen.getByRole('list', { name: 'Selected tags' })).getByText('Tag 13');
    expect(chip.style.color).toBe('rgb(181, 195, 183)');
    await user.click(screen.getByRole('button', { name: 'Remove Tag 13' }));
    expect(screen.getByText('0 of 12 tags selected.')).toBeInTheDocument();
  });

  it('enforces the twelve-tag limit until a selection is removed', async () => {
    const user = userEvent.setup();
    render(<PickerHarness initial={tags.slice(0, 12).map((tag) => tag.id)} />);

    await user.click(screen.getByRole('combobox', { name: 'Tags' }));
    await user.click(screen.getByRole('button', { name: 'Show More' }));
    expect(screen.getByRole('option', { name: /Tag 13/ })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Remove Tag 1' }));
    await user.click(screen.getByRole('combobox', { name: 'Tags' }));
    expect(screen.getByRole('option', { name: /Tag 13/ })).toBeEnabled();
  });
});
