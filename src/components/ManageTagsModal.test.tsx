import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ManageTagsModal } from './ManageTagsModal';
import { stringToPastelHex } from './TagChip';

const mocks = vi.hoisted(() => ({
  createTag: vi.fn(),
  deleteTag: vi.fn(),
  listOrphanTagReferences: vi.fn(),
  listTags: vi.fn(),
  removeOrphanTagReference: vi.fn(),
  updateTag: vi.fn(),
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { sub: 'admin', username: 'atlas', displayName: 'Atlas', role: 'Moderator' },
  }),
}));

vi.mock('../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/api')>();
  return {
    ...actual,
    createTag: mocks.createTag,
    deleteTag: mocks.deleteTag,
    listOrphanTagReferences: mocks.listOrphanTagReferences,
    listTags: mocks.listTags,
    removeOrphanTagReference: mocks.removeOrphanTagReference,
    updateTag: mocks.updateTag,
  };
});

const portalTag = { id: '10000000-0000-4000-8000-000000000001', name: 'Portal', color: '#B5C3B7' };
const orphan = {
  articleId: '00000000-0000-4000-8000-000000000001',
  articleTitle: 'Portal Guide',
  version: 3,
  missingTagIds: ['10000000-0000-4000-8000-000000000099'],
};

describe('ManageTagsModal', () => {
  beforeEach(() => {
    mocks.createTag.mockReset();
    mocks.createTag.mockResolvedValue(portalTag);
    mocks.deleteTag.mockReset();
    mocks.deleteTag.mockResolvedValue(undefined);
    mocks.listTags.mockReset();
    mocks.listTags.mockResolvedValue([portalTag]);
    mocks.listOrphanTagReferences.mockReset();
    mocks.listOrphanTagReferences.mockResolvedValue([orphan]);
    mocks.removeOrphanTagReference.mockReset();
    mocks.removeOrphanTagReference.mockResolvedValue({});
    mocks.updateTag.mockReset();
    mocks.updateTag.mockResolvedValue(portalTag);
  });

  it('validates canonical names and colors before creating a tag', async () => {
    const user = userEvent.setup();
    render(<ManageTagsModal onClose={() => undefined} />);
    await screen.findByText('Portal');

    await user.type(screen.getByLabelText('Name'), 'portal');
    await user.click(screen.getByRole('button', { name: 'Create tag' }));
    expect(screen.getByText(/unique, regardless of capitalization/i)).toBeInTheDocument();
    expect(mocks.createTag).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Expedition');
    await user.clear(screen.getByLabelText('Color'));
    await user.type(screen.getByLabelText('Color'), 'orange');
    await user.click(screen.getByRole('button', { name: 'Create tag' }));
    expect(screen.getByText(/#RRGGBB format/i)).toBeInTheDocument();
    expect(mocks.createTag).not.toHaveBeenCalled();
  });

  it('generates a color from each nonblank name and resets it for blank names', async () => {
    const user = userEvent.setup();
    render(<ManageTagsModal onClose={() => undefined} />);
    await screen.findByText('Portal');

    const name = screen.getByLabelText('Name');
    const color = screen.getByLabelText('Color');

    await user.type(name, 'P');
    expect(color).toHaveValue(stringToPastelHex('P'));

    await user.type(name, 'ortal');
    expect(color).toHaveValue(stringToPastelHex('Portal'));

    await user.clear(name);
    await user.type(name, '   ');
    expect(color).toHaveValue('#FFB451');
  });

  it('creates and updates tags using trimmed canonical values', async () => {
    const user = userEvent.setup();
    render(<ManageTagsModal onClose={() => undefined} />);
    await screen.findByText('Portal');

    await user.type(screen.getByLabelText('Name'), '  Expedition  ');
    await user.clear(screen.getByLabelText('Color'));
    await user.type(screen.getByLabelText('Color'), '#abcdef');
    await user.click(screen.getByRole('button', { name: 'Create tag' }));
    await waitFor(() => expect(mocks.createTag).toHaveBeenCalledWith(
      { name: 'Expedition', color: '#ABCDEF' },
    ));

    await user.click(screen.getByRole('button', { name: 'Edit Portal' }));
    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Gateway');
    await user.click(screen.getByRole('button', { name: 'Save tag' }));
    await waitFor(() => expect(mocks.updateTag).toHaveBeenCalledWith(
      portalTag.id,
      { name: 'Gateway', color: stringToPastelHex('Gateway').toUpperCase() },
    ));
  });

  it('always explains retained unresolved references before deleting', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<ManageTagsModal onClose={() => undefined} />);
    await screen.findByText('Portal');

    await user.click(screen.getByRole('button', { name: 'Delete Portal' }));
    expect(mocks.deleteTag).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/references will be retained and may become unresolved/i));

    await user.click(screen.getByRole('button', { name: 'Delete Portal' }));
    await waitFor(() => expect(mocks.deleteTag).toHaveBeenCalledWith(portalTag.id));
  });

  it('removes one orphan using the current article version', async () => {
    const user = userEvent.setup();
    render(<ManageTagsModal onClose={() => undefined} />);
    await screen.findByText(orphan.missingTagIds[0]);

    await user.click(screen.getByRole('button', { name: 'Remove reference' }));
    await waitFor(() => expect(mocks.removeOrphanTagReference).toHaveBeenCalledWith(
      orphan.articleId,
      orphan.missingTagIds[0],
      orphan.version,
    ));
  });

  it('closes with Escape', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<ManageTagsModal onClose={onClose} />);
    await screen.findByRole('dialog', { name: 'Manage Tags' });
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });
});
