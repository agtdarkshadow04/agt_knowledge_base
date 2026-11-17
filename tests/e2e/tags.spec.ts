import { expect, test } from '@playwright/test';
import { auth, createArticle, createTag, csrf } from './fixtures';

/**
 * Tags (TEST-6): the Moderator's Tags page (canonical names, colors, deleting
 * with retained references, removing orphaned references), who may open it,
 * the tag picker in the editor, and tag chips.
 */

const pastel = (value: string) => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = value.charCodeAt(index) + ((hash << 5) - hash);
  let color = '#';
  for (let index = 0; index < 3; index += 1) color += Math.floor((((hash >> (index * 8)) & 0xff) + 255) / 2).toString(16).padStart(2, '0');
  return color;
};

test.describe('the Tags page', () => {
  test.use({ storageState: auth.moderator });

  test('validates canonical names and colors before creating a tag', async ({ page }) => {
    await page.goto('/?view=tags');
    await expect(page.getByRole('region', { name: 'Manage tags' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Orphaned references' })).toBeVisible();
    let created = false;
    page.on('request', (request) => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/tags') created = true; });
    await page.getByLabel('Name').fill('PORTAL');
    await page.getByRole('button', { name: 'Create tag' }).click();
    await expect(page.getByText(/unique, whatever their capitalization/i)).toBeVisible();
    await page.getByLabel('Name').fill('Expedition');
    await page.getByLabel('Color').fill('orange');
    await page.getByRole('button', { name: 'Create tag' }).click();
    await expect(page.getByText(/Color is not in the right format/i)).toBeVisible();
    expect(created).toBe(false);
  });

  test('generates a color from each nonblank name and resets it for blank names', async ({ page }) => {
    await page.goto('/?view=tags');
    const name = page.getByLabel('Name');
    const color = page.getByLabel('Color');
    await name.pressSequentially('P');
    await expect(color).toHaveValue(pastel('P'));
    await name.pressSequentially('ortal');
    await expect(color).toHaveValue(pastel('Portal'));
    await name.fill('   ');
    await expect(color).toHaveValue('#FFB451');
  });

  test('creates and updates tags with trimmed canonical values', async ({ page }) => {
    const stamp = Date.now();
    await page.goto('/?view=tags');
    await page.getByLabel('Name').fill(`  Expedition ${stamp}  `);
    await page.getByLabel('Color').fill('#abcdef');
    const create = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/tags');
    await page.getByRole('button', { name: 'Create tag' }).click();
    expect((await create).postDataJSON()).toEqual({ name: `Expedition ${stamp}`, color: '#ABCDEF' });
    await page.getByRole('button', { name: `Edit Expedition ${stamp}` }).click();
    await page.getByLabel('Name').fill(`Gateway ${stamp}`);
    const update = page.waitForRequest((request) => request.method() === 'PUT' && new URL(request.url()).pathname.startsWith('/api/tags/'));
    await page.getByRole('button', { name: 'Save tag' }).click();
    expect((await update).postDataJSON()).toEqual({ name: `Gateway ${stamp}`, color: pastel(`Gateway ${stamp}`).toUpperCase() });
    await expect(page.getByText(`Gateway ${stamp}`).first()).toBeVisible();
  });

  test('explains retained references before deleting, closes with Escape, and removes an orphan with the current version', async ({ page }) => {
    const tag = await createTag(page.request, `Doomed ${Date.now()}`);
    const article = await createArticle(page.request, { title: 'Orphan Guide', tagIds: [tag.id] });
    await page.goto('/?view=tags');
    const opener = page.getByRole('button', { name: `Delete ${tag.name}` });
    await opener.click();
    let dialog = page.getByRole('alertdialog', { name: `Delete “${tag.name}”?` });
    await expect(dialog).toContainText(/keep their references to it until a Moderator removes them/i);
    // A11Y-2: the page does not scroll behind the dialog, and Escape closes it and returns focus.
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
    await opener.click();
    dialog = page.getByRole('alertdialog', { name: `Delete “${tag.name}”?` });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(opener).toBeFocused();
    await opener.click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete tag' }).click();
    await expect(page.getByRole('button', { name: `Delete ${tag.name}` })).toHaveCount(0);

    const orphan = page.locator('li', { hasText: tag.id });
    await expect(orphan).toBeVisible();
    const removal = page.waitForRequest((request) => request.method() === 'DELETE' && request.url().includes('/orphan-tags/'));
    await orphan.getByRole('button', { name: 'Remove reference' }).click();
    const url = new URL((await removal).url());
    expect(url.pathname).toBe(`/api/articles/${article.id}/orphan-tags/${tag.id}`);
    expect(url.searchParams.get('version')).toBe(String(article.version));
    await expect(page.locator('li', { hasText: tag.id })).toHaveCount(0);
  });
});

test('sends Editors home and visitors who are not signed in to sign-in', async ({ browser, page }) => {
  await page.goto('/?view=tags');
  await expect(page).toHaveURL(/view=login/);
  const context = await browser.newContext({ storageState: auth.editor });
  const editorPage = await context.newPage();
  await editorPage.goto('/?view=tags');
  await expect(editorPage).toHaveURL(/127\.0\.0\.1:\d+\/$/);
  await context.close();
});

test.describe('the tag picker', () => {
  test.use({ storageState: auth.moderator });

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: auth.moderator });
    const existing = await (await context.request.get('/api/member/tags?search=Pick')).json() as Array<{ name: string }>;
    for (let index = 1; index <= 13; index += 1) {
      const name = `Pick ${String(index).padStart(2, '0')}`;
      if (!existing.some((tag) => tag.name === name)) await createTag(context.request, name);
    }
    await context.close();
  });

  test('shows ten matches initially and reveals more in batches', async ({ page }) => {
    await page.goto('/?view=new');
    const input = page.getByRole('combobox', { name: 'Tags' });
    await input.fill('Pick');
    const options = page.getByRole('listbox', { name: 'Available tags' }).getByRole('option');
    await expect(options).toHaveCount(10);
    await page.getByRole('button', { name: 'Show more' }).click();
    await expect(options).toHaveCount(13);
  });

  test('never turns free text into a selected value, and selects with the keyboard into removable chips', async ({ page }) => {
    await page.goto('/?view=new');
    const input = page.getByRole('combobox', { name: 'Tags' });
    await input.fill('not a canonical tag');
    await input.press('Enter');
    await expect(page.getByText('Tags selected: 0 of 12.')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Selected tags' })).toHaveCount(0);
    await input.fill('Pick 13');
    await input.press('Enter');
    await expect(page.getByText('Tags selected: 1 of 12.')).toBeVisible();
    const chip = page.getByRole('list', { name: 'Selected tags' }).getByText('Pick 13');
    const color = await chip.evaluate((element) => [element.style.color, element.style.border, element.style.backgroundColor]);
    expect(color[0]).toMatch(/^rgb\(/);
    expect(color[1]).toBe(`1px solid ${color[0]}`);
    expect(color[2]).toBe(color[0].replace('rgb(', 'rgba(').replace(')', ', 0.1)'));
    await input.press('Escape');
    await page.getByRole('button', { name: 'Remove Pick 13' }).click();
    await expect(page.getByText('Tags selected: 0 of 12.')).toBeVisible();
  });

  test('enforces the twelve-tag limit until a selection is removed', async ({ page }) => {
    await page.goto('/?view=new');
    const input = page.getByRole('combobox', { name: 'Tags' });
    for (let index = 1; index <= 12; index += 1) {
      await input.fill(`Pick ${String(index).padStart(2, '0')}`);
      await input.press('Enter');
    }
    await expect(page.getByText('Tags selected: 12 of 12.')).toBeVisible();
    await input.fill('Pick 13');
    await expect(page.getByRole('option', { name: /Pick 13/ })).toBeDisabled();
    await input.press('Escape');
    await page.getByRole('button', { name: 'Remove Pick 01' }).click();
    await input.fill('Pick 13');
    await expect(page.getByRole('option', { name: /Pick 13/ })).toBeEnabled();
  });
});

test('the stored tag colors and the API agree', async ({ browser }) => {
  const context = await browser.newContext({ storageState: auth.moderator });
  const tag = await createTag(context.request, `Colored ${Date.now()}`, '#B5C3B7');
  expect(tag.color).toBe('#B5C3B7');
  const removed = await context.request.delete(`/api/tags/${tag.id}`, { headers: csrf });
  expect(removed.status()).toBe(204);
  await context.close();
});
