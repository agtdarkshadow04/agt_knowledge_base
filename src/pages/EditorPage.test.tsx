import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorPage } from './EditorPage';

const mocks = vi.hoisted(() => ({ createArticle: vi.fn() }));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { sub: 'author', username: 'apollo', displayName: 'Apollo', role: 'Standard' },
    getToken: async () => 'token',
  }),
}));

vi.mock('../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/api')>();
  return { ...actual, createArticle: mocks.createArticle, getArticle: vi.fn(), updateArticle: vi.fn() };
});

vi.mock('../components/RichMarkdownEditor', () => ({
  RichMarkdownEditor: ({ value, onChange }: { value: string; onChange(value: string): void }) => (
    <textarea aria-label="Visual Markdown editor" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));

function renderEditor() {
  const router = createMemoryRouter([
    { path: '/articles/new', element: <EditorPage /> },
    { path: '/articles/:id', element: <div>Saved article</div> },
  ], { initialEntries: ['/articles/new'] });
  return render(<RouterProvider router={router} />);
}

describe('EditorPage', () => {
  beforeEach(() => {
    mocks.createArticle.mockReset();
    mocks.createArticle.mockResolvedValue({ id: 'article-1', title: 'Portal Guide', tags: ['portal'], content: '# Portal Guide\n\nSafe instructions.', version: 1 });
  });

  it('switches editing modes without losing unsaved Markdown', async () => {
    const user = userEvent.setup();
    renderEditor();
    const plain = screen.getByRole('textbox', { name: /markdown source/i });
    await user.type(plain, '# Draft{enter}{enter}Unsaved traveller notes.');
    await user.click(screen.getByRole('button', { name: 'Visual Markdown' }));
    expect(await screen.findByRole('textbox', { name: 'Visual Markdown editor' })).toHaveValue('# Draft\n\nUnsaved traveller notes.');
    await user.click(screen.getByRole('button', { name: 'Plain Markdown' }));
    expect(screen.getByRole('textbox', { name: /markdown source/i })).toHaveValue('# Draft\n\nUnsaved traveller notes.');
  });

  it('provides icon-only Markdown guide and preview controls', async () => {
    const user = userEvent.setup();
    const { container } = renderEditor();
    const guide = screen.getByRole('link', { name: 'Markdown Guide' });
    expect(guide).toHaveAttribute('href', 'https://www.markdownguide.org/basic-syntax/');
    expect(guide).toHaveAttribute('target', '_blank');
    expect(guide).toHaveAttribute('title', 'Markdown Guide');

    const showPreview = screen.getByRole('button', { name: 'Show preview' });
    expect(showPreview).toHaveAttribute('title', 'Show preview');
    expect(container.querySelector('.lucide-eye')).toBeInTheDocument();
    await user.click(showPreview);

    const hidePreview = screen.getByRole('button', { name: 'Hide preview' });
    expect(hidePreview).toHaveAttribute('title', 'Hide preview');
    expect(container.querySelector('.lucide-eye-off')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Preview' })).toBeInTheDocument();
  });

  it('validates and saves a new article with normalized tag input', async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.type(screen.getByLabelText('Title'), 'Portal Guide');
    await user.type(screen.getByLabelText(/Tags/), 'portal, guide');
    await user.type(screen.getByRole('textbox', { name: /markdown source/i }), '# Portal Guide{enter}{enter}Safe instructions for travellers.');
    await user.click(screen.getByRole('button', { name: 'Save article' }));
    expect(mocks.createArticle).toHaveBeenCalledWith(expect.objectContaining({ title: 'Portal Guide', tags: ['portal', 'guide'] }), 'token');
    expect(await screen.findByText('Saved article')).toBeInTheDocument();
  });
});
