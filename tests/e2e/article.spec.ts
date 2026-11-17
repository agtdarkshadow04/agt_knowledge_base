import { readFileSync } from 'node:fs';
import { expect, test, type Browser } from '@playwright/test';
import { auth, createArticle, preferences, type CreatedArticle } from './fixtures';

/**
 * The article page (TEST-6): the downloads the reader's preference allows,
 * the Markdown source and the PDF export, and the Moderator's pin and verify
 * actions, each on an article of its own.
 */

const content = '# Portal Guide\n\nSafe portal navigation instructions.\n\n- Step one\n- Step two';

async function newArticle(browser: Browser, title: string): Promise<CreatedArticle> {
  const context = await browser.newContext({ storageState: auth.moderator });
  const article = await createArticle(context.request, { title, content });
  await context.close();
  return article;
}

test.describe('downloads', () => {
  test('are hidden from Editors by default, and offered when enabled', async ({ browser }) => {
    const article = await newArticle(browser, 'Download Guide');
    const context = await browser.newContext({ storageState: auth.editor });
    const page = await context.newPage();
    await page.goto(`/?article=${article.id}`);
    await expect(page.getByText('Created by')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download Markdown source' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Download PDF' })).toHaveCount(0);
    // A preference change applies without reloading the article.
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('combobox', { name: 'Article downloads' }).selectOption('true');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Download Markdown source' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download PDF' })).toBeVisible();
    await context.close();
  });

  test('are never offered to visitors who are not signed in', async ({ browser, page }) => {
    const article = await newArticle(browser, 'Public Download Guide');
    await preferences(page, { allowDownloads: true });
    await page.goto(`/?article=${article.id}`);
    await expect(page.getByText('Created by')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download Markdown source' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Download PDF' })).toHaveCount(0);
  });

  test('download the unmodified Markdown source, and the PDF at 1× even with a larger text size', async ({ browser }) => {
    const article = await newArticle(browser, 'Portal Guide Export');
    const context = await browser.newContext({ storageState: auth.editor });
    const page = await context.newPage();
    await preferences(page, { allowDownloads: true, fontScale: '2' });
    await page.goto(`/?article=${article.id}`);

    const markdown = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download Markdown source' }).click();
    const file = await markdown;
    expect(file.suggestedFilename()).toBe('Portal Guide Export.md');
    expect(readFileSync(await file.path(), 'utf8')).toBe(content);

    const pdf = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download PDF' }).click();
    const exported = await pdf;
    expect(exported.suggestedFilename()).toBe('Portal Guide Export.pdf');
    expect(readFileSync(await exported.path()).subarray(0, 5).toString()).toBe('%PDF-');
    // The PDF source is built off the page and removed again; the page keeps its own text size.
    await expect(page.locator('.pdf-export')).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-font-scale', '2');
    await expect(page.getByRole('button', { name: 'Download PDF' })).toBeEnabled();
    await context.close();
  });
});

test.describe('moderation', () => {
  test.use({ storageState: auth.moderator });

  test('a Moderator pins and verifies an article', async ({ browser, page }) => {
    const article = await newArticle(browser, 'Moderated Guide');
    await page.goto(`/?article=${article.id}`);
    await expect(page.locator('.article-header').getByText('Public')).toHaveClass(/visibility-public/);
    await page.getByRole('button', { name: 'Pin', exact: true }).click();
    await expect(page.getByText('Pinned', { exact: true })).toHaveClass(/pinned/);
    await expect(page.getByRole('button', { name: 'Unpin' })).toBeVisible();
    await page.getByRole('button', { name: 'Verify', exact: true }).click();
    await expect(page.getByText('Verified', { exact: true })).toHaveClass(/verified/);
    await expect(page.getByRole('button', { name: 'Unverify' })).toBeVisible();
    // The changes are stored, with the version advanced each time (optimistic concurrency).
    const stored = await (await page.request.get(`/api/member/articles/${article.id}`)).json() as { isPinned: boolean; isVerified: boolean; version: number };
    expect(stored).toMatchObject({ isPinned: true, isVerified: true, version: article.version + 2 });
  });
});
