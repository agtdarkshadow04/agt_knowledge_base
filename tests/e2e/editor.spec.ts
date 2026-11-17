import { expect, test } from '@playwright/test';
import { auth, createArticle, createTag, csrf, violations, watchViolations } from './fixtures';

/**
 * The article editor and the revision history (TEST-6), including the rich
 * editor under the production CSP (#48 §2, the MDXEditor deviation in AGENTS.md).
 */

test.describe('as an editor', () => {
  test.use({ storageState: auth.editor });

  test('offers only the visibility levels an Editor may set', async ({ page }) => {
    await page.goto('/?view=new');
    const visibility = page.getByLabel('Visibility');
    await expect(visibility.getByRole('option', { name: 'Private' })).toHaveAttribute('value', '1');
    await expect(visibility.getByRole('option', { name: 'Restricted' })).toHaveCount(0);
    await expect(visibility.getByRole('option', { name: 'Top Secret' })).toHaveCount(0);
  });

  test('switches editing modes without losing unsaved Markdown', async ({ page }) => {
    await page.goto('/?view=new');
    const plain = page.getByRole('textbox', { name: /markdown source/i });
    await plain.fill('# Draft\n\nUnsaved traveller notes.');
    await page.getByRole('button', { name: 'Visual Markdown' }).click();
    const rich = page.locator('.rich-editor-content[contenteditable="true"]');
    await expect(rich).toContainText('Draft');
    await expect(rich).toContainText('Unsaved traveller notes.');
    await page.getByRole('button', { name: 'Plain Markdown' }).click();
    await expect(page.getByRole('textbox', { name: /markdown source/i })).toHaveValue('# Draft\n\nUnsaved traveller notes.');
  });

  test('provides the toolbar actions as icon-only controls in the required order', async ({ page }) => {
    await page.goto('/?view=new');
    const guide = page.getByRole('link', { name: 'Markdown guide' });
    await expect(guide).toHaveAttribute('href', 'https://www.markdownguide.org/basic-syntax/');
    await expect(guide).toHaveAttribute('target', '_blank');
    expect(await page.locator('.editor-toolbar-actions > *').evaluateAll((controls) => controls.map((control) => control.getAttribute('title'))))
      .toEqual(['Markdown guide', 'Exit without saving', 'Save article', 'Show preview']);
    await expect(page.locator('[data-icon="eye"]')).toHaveCount(1);
    await page.getByRole('button', { name: 'Show preview' }).click();
    await expect(page.getByRole('button', { name: 'Hide preview' })).toHaveAttribute('title', 'Hide preview');
    await expect(page.locator('[data-icon="eye-off"]')).toHaveCount(1);
    await expect(page.getByRole('heading', { name: 'Preview' })).toBeVisible();
  });

  test('labels and compares the latest and previous revisions, without a restore action', async ({ browser, page }) => {
    const moderatorContext = await browser.newContext({ storageState: auth.moderator });
    const article = await createArticle(moderatorContext.request, { title: 'History Guide', content: '# History Guide\n\nEarlier instructions.', visibility: 'Public' });
    const pinned = await moderatorContext.request.patch(`/api/articles/${article.id}/pinning`, { headers: csrf, data: { isPinned: true, version: article.version } });
    const pinnedVersion = (await pinned.json() as { version: number }).version;
    const updated = await moderatorContext.request.put(`/api/articles/${article.id}`, {
      headers: csrf, data: { title: 'History Guide', content: '# History Guide\n\nLatest instructions.', tagIds: [], visibility: 'Internal', version: pinnedVersion },
    });
    expect(updated.status(), await updated.text()).toBe(200);
    await moderatorContext.close();

    await page.goto(`/?article=${article.id}&view=history`);
    await expect(page.getByRole('heading', { name: 'Revision history' })).toBeVisible();
    await expect(page.getByText(/· latest$/).first()).toBeVisible();
    await expect(page.getByText(/· previous$/).first()).toBeVisible();
    // I18N-5: a localized date and time, with the exact instant in the time element.
    await expect(page.locator('time[datetime]').first()).toHaveText(/\d{4}/);
    await expect(page.getByText(/Earlier instructions/)).toBeVisible();
    await expect(page.getByText(/Latest instructions/)).toBeVisible();
    await expect(page.locator('.visibility-public').first()).toBeVisible();
    await expect(page.locator('.visibility-internal').first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Restore version/ })).toHaveCount(0);
  });
});

test.describe('as a moderator', () => {
  test.use({ storageState: auth.moderator });

  test('shows a diff and asks for confirmation before saving a new article', async ({ page }) => {
    const portal = `portal-${Date.now()}`;
    const guide = `guide-${Date.now()}`;
    await createTag(page.request, portal);
    await createTag(page.request, guide);
    await page.goto('/?view=new');
    await page.getByLabel('Title').fill('Confirmed Guide');
    await page.getByRole('combobox', { name: 'Tags' }).click();
    await page.getByRole('combobox', { name: 'Tags' }).fill('portal-');
    await page.getByRole('option', { name: new RegExp(portal) }).click();
    await page.getByRole('combobox', { name: 'Tags' }).fill('guide-');
    await page.getByRole('option', { name: new RegExp(guide) }).click();
    await page.getByRole('textbox', { name: /markdown source/i }).fill('# Confirmed Guide\n\nSafe instructions for travellers.');
    let created = false;
    page.on('request', (request) => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/articles') created = true; });
    await page.getByRole('button', { name: 'Save article' }).click();
    const dialog = page.getByRole('dialog', { name: 'Review changes before saving' });
    await expect(dialog.getByRole('heading', { name: 'Current content' })).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'New content' })).toBeVisible();
    await expect(dialog.getByText('No content')).toBeVisible();
    await expect(dialog.getByText(/Safe instructions for travellers/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Keep editing' }).click();
    expect(created).toBe(false);
    await page.getByRole('button', { name: 'Save article' }).click();
    const request = page.waitForRequest((candidate) => candidate.method() === 'POST' && new URL(candidate.url()).pathname === '/api/articles');
    await page.getByRole('button', { name: 'Confirm save' }).click();
    const body = (await request).postDataJSON() as { title: string; tagIds: string[]; visibility: string };
    expect(body.title).toBe('Confirmed Guide');
    expect(body.tagIds).toHaveLength(2);
    expect(body.visibility).toBe('Internal');
    await expect(page).toHaveURL(/\/\?article=[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { name: 'Confirmed Guide', level: 1 }).first()).toBeVisible();
  });

  test('compares the current revision with the proposed edit, and saves it with the version', async ({ page }) => {
    const article = await createArticle(page.request, { title: 'Edited Guide', content: '# Edited Guide\n\nCurrent instructions.', visibility: 'Internal' });
    await page.goto(`/?article=${article.id}&view=edit`);
    await page.getByLabel('Title').fill('Updated Edited Guide');
    await page.getByRole('textbox', { name: /markdown source/i }).fill('# Edited Guide\n\nUpdated instructions.');
    await page.getByRole('button', { name: 'Save article' }).click();
    const dialog = page.getByRole('dialog', { name: 'Review changes before saving' });
    await expect(dialog.getByText('Edited Guide', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Updated Edited Guide')).toBeVisible();
    await expect(dialog.getByText(/Current instructions/)).toBeVisible();
    await expect(dialog.getByText(/Updated instructions/)).toBeVisible();
    const request = page.waitForRequest((candidate) => candidate.method() === 'PUT');
    await dialog.getByRole('button', { name: 'Confirm save' }).click();
    expect((await request).postDataJSON()).toMatchObject({ title: 'Updated Edited Guide', version: article.version });
    await expect(page).toHaveURL(new RegExp(`/\\?article=${article.id}$`));
  });

  test('restores a selected revision as a new latest copy after confirmation', async ({ page }) => {
    const article = await createArticle(page.request, { title: 'Restored Guide', content: '# Restored Guide\n\nEarlier instructions.' });
    const updated = await page.request.put(`/api/articles/${article.id}`, {
      headers: csrf, data: { title: 'Restored Guide', content: '# Restored Guide\n\nLatest instructions.', tagIds: [], visibility: 'Public', version: article.version },
    });
    expect(updated.status()).toBe(200);
    await page.goto(`/?article=${article.id}&view=history`);
    await page.getByRole('button', { name: `Restore version ${article.version}` }).click();
    // A11Y-2: the confirmation is a dialog with the safe choice focused.
    const dialog = page.getByRole('alertdialog', { name: `Restore version ${article.version}?` });
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/\\?article=${article.id}$`));
    await expect(page.locator('.article-body')).toContainText('Earlier instructions.');
  });

  test('the rich editor works under the CSP, with the dark theme, three heading levels, and popovers that return focus', async ({ page }) => {
    await watchViolations(page);
    const response = await page.goto('/?view=new');
    expect(response?.headers()['content-security-policy']).toContain("style-src 'self'");
    await page.getByRole('button', { name: 'Visual Markdown' }).click();
    await expect(page.locator('.mdxeditor.dark-theme')).toHaveCount(1);
    const editor = page.locator('.rich-editor-content[contenteditable="true"]');
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.type('Portal travel notes for the archive.');
    await expect(editor).toContainText('Portal travel notes');
    expect(await violations(page)).toEqual([]);

    // The block-type select: opens from the keyboard, offers headings 1–3 only, closes with Escape, focus returns.
    const blockType = page.getByRole('combobox', { name: 'Block type' });
    await blockType.focus();
    await page.keyboard.press('Enter');
    const listbox = page.getByRole('listbox');
    await expect(listbox).toBeVisible();
    await expect(listbox.getByRole('option', { name: /Heading 3/ })).toHaveCount(1);
    await expect(listbox.getByRole('option', { name: /Heading 4/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(listbox).toBeHidden();
    await expect(blockType).toBeFocused();

    // The link dialog.
    await editor.click();
    await page.getByRole('button', { name: 'Create link' }).click();
    await expect(page.locator('.mdxeditor-popup-container input').first()).toBeVisible();
    await page.keyboard.press('Escape');

    // The one exception: the Radix select's scroll-lock <style> element, which the CSP blocks.
    for (const violation of await violations(page)) {
      expect(violation, JSON.stringify(violation)).toEqual({ directive: 'style-src-elem', blocked: 'inline' });
    }
  });
});
