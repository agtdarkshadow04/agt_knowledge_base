import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { stringToPastelHex, TagChip } from './TagChip';

describe('TagChip', () => {
  it('generates a stable pastel color from the tag name', () => {
    expect(stringToPastelHex('portal')).toBe('#b5c3b7');
    expect(stringToPastelHex('guide')).toBe('#fd9cf0');
    expect(stringToPastelHex('portal')).not.toBe(stringToPastelHex('guide'));
  });

  it('uses the generated color for its content, border, and translucent background', () => {
    render(<TagChip tag="portal" />);

    const chip = screen.getByText('portal');
    expect(chip.style.color).toBe('rgb(181, 195, 183)');
    expect(chip.style.border).toBe('1px solid rgb(181, 195, 183)');
    expect(chip.style.backgroundColor).toBe('rgba(181, 195, 183, 0.1)');
  });
});
