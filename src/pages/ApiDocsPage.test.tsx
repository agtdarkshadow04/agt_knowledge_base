import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiDocsPage } from './ApiDocsPage';

describe('ApiDocsPage', () => {
  it('renders the public and member operations with auth badges', () => {
    render(<ApiDocsPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'AGT Knowledge Base API' })).toBeInTheDocument();

    const login = screen.getByRole('article', { name: 'Sign in as a member' });
    expect(within(login).getByText('/auth/login')).toBeInTheDocument();
    expect(within(login).getByText('Public')).toBeInTheDocument();
    expect(within(login).getByText('Rate-limited (login)')).toBeInTheDocument();
    expect(within(login).getByText('INVALID_CREDENTIALS', { selector: '.api-error-codes code' })).toBeInTheDocument();

    const remove = screen.getByRole('article', { name: 'Delete an article' });
    expect(within(remove).getByText('DELETE')).toHaveClass('api-method-delete');
    expect(within(remove).getByText('Member token')).toBeInTheDocument();
    expect(within(remove).getByText('Moderator only')).toBeInTheDocument();
    expect(within(remove).getByText('VERSION_CONFLICT', { selector: '.api-error-codes code' })).toBeInTheDocument();
  });

  it('shows parameters, request body constraints, and error codes', () => {
    render(<ApiDocsPage />);
    const list = screen.getByRole('article', { name: 'List public articles' });
    expect(within(list).getByText('PUBLIC_BROWSING_DISABLED', { selector: '.api-error-codes code' })).toBeInTheDocument();
    expect(within(list).getByRole('table', { name: 'Parameters of GET /articles' })).toHaveTextContent('pageSize');

    const create = screen.getByRole('article', { name: 'Create an article' });
    const body = within(create).getByRole('table', { name: 'Request body of POST /articles' });
    expect(body).toHaveTextContent('3–180 characters');
    expect(body).toHaveTextContent('at most 12 items');
    expect(body).toHaveTextContent('20–250,000 characters');
    expect(within(create).getByText('INVALID_TAG_IDS', { selector: '.api-error-codes code' })).toBeInTheDocument();
  });

  it('links each operation from the contents and leaves the Admin routes out', () => {
    const { container } = render(<ApiDocsPage />);
    const contents = screen.getByRole('navigation', { name: 'API contents' });
    expect(within(contents).getByRole('link', { name: /POST \/articles$/ })).toHaveAttribute('href', '#createArticle');
    expect(container.querySelector('#createArticle')).not.toBeNull();
    const paths = [...container.querySelectorAll('.api-endpoint code')].map((element) => element.textContent);
    expect(paths).toHaveLength(22);
    expect(paths.filter((path) => path?.startsWith('/admin'))).toEqual([]);
    expect(screen.queryByText('Admin session')).not.toBeInTheDocument();
  });
});
