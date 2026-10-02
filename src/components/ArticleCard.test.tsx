import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { ArticleSummary } from '../types';
import { ArticleCard } from './ArticleCard';

const article: ArticleSummary = {
  id: '00000000-0000-4000-8000-000000000001',
  title: 'Portal Guide',
  excerpt: 'Safe portal navigation.',
  tags: ['portal'],
  visibility: 'Internal',
  isPinned: true,
  isProtected: true,
  isVerified: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'author',
  createdByName: 'Apollo',
  modifiedAt: '2026-01-02T00:00:00.000Z',
  modifiedBy: 'admin',
  modifiedByName: 'Atlas',
  version: 2,
};

describe('ArticleCard', () => {
  it('shows visibility, verified, pinned, and protected status indicators', () => {
    const { container } = render(<MemoryRouter><ArticleCard article={article} /></MemoryRouter>);

    expect(screen.getByText('Internal')).toHaveClass('visibility-internal');
    expect(container.querySelector('.visibility-eye-icon')).toBeInTheDocument();
    expect(screen.getByText('Verified')).toHaveClass('verified');
    expect(screen.getByText('Pinned')).toHaveClass('pinned');
    expect(screen.getByText('Protected')).toHaveClass('protected');
  });
});
