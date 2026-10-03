import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { stringToPastelHex, TagChip } from './TagChip';

describe('TagChip', () => {
  it('generates a stable pastel color from the tag name', () => {
    expect(stringToPastelHex('portal')).toBe('#b5c3b7');
    expect(stringToPastelHex('guide')).toBe('#fd9cf0');
    expect(stringToPastelHex('portal')).not.toBe(stringToPastelHex('guide'));
  });

  it('uses the generated color as the tag background', () => {
    render(<TagChip tag="portal" />);

    expect(screen.getByText('portal')).toHaveStyle({ backgroundColor: '#b5c3b7', color: '#0a0a0a' });
  });
});
