import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorPage } from './EditorPage';

const mocks = vi.hoisted(() => ({
  createArticle: vi.fn(),
  getArticle: vi.fn(),
  listTags: vi.fn(),
  updateArticle: vi.fn(),
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { sub: 'author', username: 'apollo', displayName: 'Apollo', role: 'Editor' },
  }),
}));

vi.mock('../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/api')>();
  return {
    ...actual,
    createArticle: mocks.createArticle,
    getArticle: mocks.getArticle,
    listTags: mocks.listTags,
    updateArticle: mocks.updateArticle,
  };
});

vi.mock('../components/RichMarkdownEditor', () => ({
  RichMarkdownEditor: ({ value, onChange }: { value: string; onChange(value: string): void }) => (
    <textarea aria-label="Visual Markdown editor" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));

function renderEditor(initialEntry = '/articles/new') {
  const router = createMemoryRouter([
    { path: '/articles/new', element: <EditorPage /> },
    { path: '/articles/:id/edit', element: <EditorPage /> },
    { path: '/articles/:id', element: <div>Saved article</div> },
  ], { initialEntries: [initialEntry] });
  return render(<RouterProvider router={router} />);
}

const portalTag = { id: '10000000-0000-4000-8000-000000000001', name: 'portal', color: '#B5C3B7' };
const guideTag = { id: '10000000-0000-4000-8000-000000000002', name: 'guide', color: '#FD9CF0' };

describe('EditorPage', () => {
  beforeEach(() => {
    mocks.createArticle.mockReset();
    mocks.createArticle.mockResolvedValue({ id: 'article-1', title: 'Portal Guide', tags: [portalTag, guideTag], content: '# Portal Guide\n\nSafe instructions.', visibility: 'Internal', version: 1 });
    mocks.getArticle.mockReset();
    mocks.getArticle.mockResolvedValue({ id: 'article-1', title: 'Portal Guide', tags: [portalTag], content: '# Portal Guide\n\nCurrent instructions.', visibility: 'Internal', isProtected: false, version: 1 });
    mocks.listTags.mockReset();
    mocks.listTags.mockResolvedValue([portalTag, guideTag]);
    mocks.updateArticle.mockReset();
    mocks.updateArticle.mockResolvedValue({ id: 'article-1', title: 'Updated Portal Guide', tags: [portalTag], content: '# Portal Guide\n\nUpdated instructions.', visibility: 'Internal', version: 2 });
  });

  it('offers Editors the permitted AGT-standard visibility levels', () => {
    renderEditor();

    expect(screen.getByRole('option', { name: 'Private' })).toHaveValue('1');
    expect(screen.queryByRole('option', { name: 'Restricted' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Top Secret' })).not.toBeInTheDocument();
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

  it('provides the toolbar actions as icon-only controls in the required order', async () => {
    const user = userEvent.setup();
    const { container } = renderEditor();
    const guide = screen.getByRole('link', { name: 'Markdown Guide' });
    expect(guide).toHaveAttribute('href', 'https://www.markdownguide.org/basic-syntax/');
    expect(guide).toHaveAttribute('target', '_blank');
    expect(guide).toHaveAttribute('title', 'Markdown Guide');

    expect(screen.getByRole('button', { name: 'Exit without saving' })).toHaveAttribute('title', 'Exit without saving');
    expect(screen.getByRole('button', { name: 'Save article' })).toHaveAttribute('title', 'Save article');
    expect(Array.from(container.querySelectorAll('.editor-toolbar-actions > *')).map((control) => control.getAttribute('title'))).toEqual([
      'Markdown Guide',
      'Exit without saving',
      'Save article',
      'Show preview',
    ]);

    const showPreview = screen.getByRole('button', { name: 'Show preview' });
    expect(showPreview).toHaveAttribute('title', 'Show preview');
    expect(container.querySelector('.lucide-eye')).toBeInTheDocument();
    await user.click(showPreview);

    const hidePreview = screen.getByRole('button', { name: 'Hide preview' });
    expect(hidePreview).toHaveAttribute('title', 'Hide preview');
    expect(container.querySelector('.lucide-eye-off')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Preview' })).toBeInTheDocument();
  });

  it('shows a revision diff and requires confirmation before saving a new article', async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.type(screen.getByLabelText('Title'), 'Portal Guide');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save article' })).toBeEnabled());
    await user.click(screen.getByRole('combobox', { name: 'Tags' }));
    await user.click(screen.getByRole('option', { name: /portal/i }));
    await user.click(screen.getByRole('option', { name: /guide/i }));
    await user.type(screen.getByRole('textbox', { name: /markdown source/i }), '# Portal Guide{enter}{enter}Safe instructions for travellers.');
    await user.click(screen.getByRole('button', { name: 'Save article' }));

    expect(mocks.createArticle).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog', { name: 'Review changes before saving' });
    expect(within(dialog).getByRole('heading', { name: 'Current revision content' })).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: 'New revision content' })).toBeInTheDocument();
    expect(within(dialog).getByText('No content')).toBeInTheDocument();
    expect(within(dialog).getByText(/Safe instructions for travellers/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(mocks.createArticle).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Save article' }));
    await user.click(screen.getByRole('button', { name: 'Confirm save' }));
    expect(mocks.createArticle).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Portal Guide',
      tagIds: [portalTag.id, guideTag.id],
      visibility: 'Internal',
    }));
    expect(await screen.findByText('Saved article')).toBeInTheDocument();
  });

  it('compares the current article revision with the proposed edit', async () => {
    const user = userEvent.setup();
    renderEditor('/articles/article-1/edit');

    const title = await screen.findByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'Updated Portal Guide');
    const content = screen.getByRole('textbox', { name: /markdown source/i });
    await user.clear(content);
    await user.type(content, '# Portal Guide{enter}{enter}Updated instructions.');
    await user.click(screen.getByRole('button', { name: 'Save article' }));

    const dialog = screen.getByRole('alertdialog', { name: 'Review changes before saving' });
    expect(within(dialog).getByText('Portal Guide')).toBeInTheDocument();
    expect(within(dialog).getByText('Updated Portal Guide')).toBeInTheDocument();
    expect(within(dialog).getByText(/Current instructions/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Updated instructions/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Confirm save' }));
    expect(mocks.updateArticle).toHaveBeenCalledWith(
      'article-1',
      expect.objectContaining({ title: 'Updated Portal Guide', version: 1 }),
    );
    expect(await screen.findByText('Saved article')).toBeInTheDocument();
  });
});
