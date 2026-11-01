import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RichMarkdownEditor } from './RichMarkdownEditor';

const mocks = vi.hoisted(() => ({
  headingsPlugin: vi.fn(() => ({ name: 'headings' })),
  linkDialogPlugin: vi.fn(() => ({ name: 'link-dialog' })),
  toolbarContents: undefined as (() => React.ReactNode) | undefined,
}));

vi.mock('@mdxeditor/editor', () => ({
  BlockTypeSelect: () => <button>Heading options</button>,
  BoldItalicUnderlineToggles: () => null,
  CreateLink: () => null,
  headingsPlugin: mocks.headingsPlugin,
  linkDialogPlugin: mocks.linkDialogPlugin,
  linkPlugin: () => ({ name: 'link' }),
  listsPlugin: () => ({ name: 'lists' }),
  ListsToggle: () => null,
  MDXEditor: ({ className }: { className?: string }) => (
    <div className={className} data-testid="mdx-editor">{mocks.toolbarContents?.()}</div>
  ),
  quotePlugin: () => ({ name: 'quote' }),
  thematicBreakPlugin: () => ({ name: 'thematic-break' }),
  toolbarPlugin: ({ toolbarContents }: { toolbarContents(): React.ReactNode }) => {
    mocks.toolbarContents = toolbarContents;
    return { name: 'toolbar' };
  },
  UndoRedo: () => null,
}));

describe('RichMarkdownEditor', () => {
  it('uses the dark theme and configures its toolbar plugins', () => {
    render(<RichMarkdownEditor value="" onChange={() => undefined} />);

    expect(screen.getByTestId('mdx-editor')).toHaveClass('dark-theme');
    expect(mocks.headingsPlugin).toHaveBeenCalledWith({ allowedHeadingLevels: [1, 2, 3] });
    expect(mocks.linkDialogPlugin).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Heading options' })).toBeInTheDocument();
  });
});

