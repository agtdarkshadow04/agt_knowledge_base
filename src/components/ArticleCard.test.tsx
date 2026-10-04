import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { ArticleSummary } from '../types';
import { ArticleCard } from './ArticleCard';

const article: ArticleSummary = {
  id: '00000000-0000-4000-8000-000000000001',
  title: 'Portal Guide',
  excerpt: 'Safe portal navigation.',
  tags: [{ id: '10000000-0000-4000-8000-000000000001', name: 'portal', color: '#B5C3B7' }],
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

  it('positions status indicators between the title and excerpt', () => {
    const { container } = render(<MemoryRouter><ArticleCard article={article} /></MemoryRouter>);
    const heading = container.querySelector('.article-card-heading');
    const status = container.querySelector('.article-card-status');
    const excerpt = container.querySelector('.excerpt');
    const tags = container.querySelector('.tag-list');

    expect(heading?.nextElementSibling).toBe(status);
    expect(status?.nextElementSibling).toBe(excerpt);
    expect(excerpt?.nextElementSibling).toBe(tags);
  });
});
