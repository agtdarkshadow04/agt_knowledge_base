import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { stringToPastelHex, TagChip } from './TagChip';

describe('TagChip', () => {
  it('generates a stable pastel color from the tag name', () => {
    expect(stringToPastelHex('portal')).toBe('#b5c3b7');
    expect(stringToPastelHex('guide')).toBe('#fd9cf0');
    expect(stringToPastelHex('portal')).not.toBe(stringToPastelHex('guide'));
  });

  it('uses the stored color for its content, border, and translucent background', () => {
    render(<TagChip tag={{ id: 'tag-1', name: 'portal', color: '#B5C3B7' }} />);

    const chip = screen.getByText('portal');
    expect(chip.style.color).toBe('rgb(181, 195, 183)');
    expect(chip.style.border).toBe('1px solid rgb(181, 195, 183)');
    expect(chip.style.backgroundColor).toBe('rgba(181, 195, 183, 0.1)');
  });
});
