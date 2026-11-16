import { expect, type Page, test } from '@playwright/test';

/**
 * Issue #48 §2: the rich Markdown editor (MDXEditor) and the PDF export
 * (html2pdf.js) work under the unchanged production CSP (SEC-1). The editor
 * loads and edits without a CSP violation (its select's scroll lock is the one
 * documented exception); the export finishes, and the only violations it may
 * cause are html2canvas's feature probes (an inline <style> and data: images),
 * and only while exporting. The API is answered here, so no database is needed.
 */

const articleId = '00000000-0000-4000-8000-0000000000e2';
const tag = { id: '10000000-0000-4000-8000-0000000000e2', name: 'portal', color: '#B5C3B7' };
const article = {
  id: articleId,
  title: 'Portal Guide',
  excerpt: 'Safe portal navigation.',
  content: '# Portal Guide\n\nSafe portal navigation instructions for every traveller.\n\n- Step one\n- Step two',
  tags: [tag],
  visibility: 'Internal',
  isPinned: false,
  isProtected: false,
  isVerified: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'member',
  createdByName: 'Apollo',
  modifiedAt: '2026-01-02T00:00:00.000Z',
  modifiedBy: 'member',
  modifiedByName: 'Apollo',
  version: 1,
};

type Violation = { directive: string; blocked: string };

async function prepare(page: Page) {
  await page.addInitScript(() => {
    const violations: { directive: string; blocked: string }[] = [];
    (window as unknown as { violations: typeof violations }).violations = violations;
    document.addEventListener('securitypolicyviolation', (event) => {
      violations.push({ directive: event.effectiveDirective, blocked: event.blockedURI });
    });
    localStorage.setItem('agt_knowledge_base_allow_downloads', 'true');
  });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/settings/public') {
      return json({
        site: { title: 'AGT Knowledge Base', subtitle: 'Field-tested guides.', supportUrl: 'https://www.nms-agt.com/support' },
        articles: { defaultVisibility: 'Internal' },
        access: { allowPublicBrowsing: true },
      });
    }
    if (path === '/api/member/session') return json({ sub: 'member', username: 'apollo', displayName: 'Apollo', role: 'Moderator' });
    if (path === '/api/member/tags') return json([tag]);
    if (path === `/api/member/articles/${articleId}`) return json(article);
    if (path === '/api/member/articles' || path === '/api/articles') return json({ items: [], nextCursor: null, total: 0 });
    if (path === '/api/tags') return json([tag]);
    if (path === '/api/setup/status') return json({ adminExists: true, setupPasswordConfigured: false, required: false });
    if (path === '/api/admin/session') return json({ error: 'unauthorized', message: 'Sign in.' }, 401);
    return json({ error: 'not_found', message: 'Route not found.' }, 404);
  });
}

async function violations(page: Page): Promise<Violation[]> {
  return page.evaluate(() => (window as unknown as { violations: Violation[] }).violations.slice());
}

test('the rich editor works under the CSP and its popovers return focus', async ({ page }) => {
  await prepare(page);
  const response = await page.goto('/?view=new');
  expect(response?.headers()['content-security-policy']).toContain("style-src 'self'");

  await page.getByRole('button', { name: 'Visual Markdown' }).click();
  const editor = page.locator('.rich-editor-content[contenteditable="true"]');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.type('Portal travel notes for the archive.');
  await expect(editor).toContainText('Portal travel notes');
  // Loading the editor and typing raise no violation at all.
  expect(await violations(page)).toEqual([]);

  // The block-type select: opens from the keyboard, closes with Escape, focus returns.
  const blockType = page.getByRole('combobox', { name: 'Block type' });
  await blockType.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toBeHidden();
  await expect(blockType).toBeFocused();

  // The link dialog.
  await editor.click();
  await page.getByRole('button', { name: 'Create link' }).click();
  await expect(page.locator('.mdxeditor-popup-container input').first()).toBeVisible();
  await page.keyboard.press('Escape');

  // The one exception: opening the Radix select makes react-remove-scroll add a
  // scroll-lock <style> element, which the CSP blocks. The select still works;
  // only the page does not stop scrolling while it is open (AGENTS.md, MDXEditor row).
  for (const violation of await violations(page)) {
    expect(violation, JSON.stringify(violation)).toEqual({ directive: 'style-src-elem', blocked: 'inline' });
  }
});

test('the PDF export finishes; only html2canvas probes are blocked, and only while exporting', async ({ page }) => {
  await prepare(page);
  await page.goto(`/?article=${articleId}`);
  await expect(page.locator('.article-header h1')).toHaveText('Portal Guide');
  expect(await violations(page)).toEqual([]);

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PDF' }).click();
  expect((await download).suggestedFilename()).toBe('Portal Guide.pdf');

  for (const violation of await violations(page)) {
    const probe = (violation.directive.startsWith('style-src') && violation.blocked === 'inline')
      || (violation.directive === 'img-src' && violation.blocked === 'data');
    expect(probe, JSON.stringify(violation)).toBe(true);
  }
});

test('both entries load without CSP violations or console errors', async ({ page }) => {
  await prepare(page);
  const errors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error' && !/status of 401/.test(message.text())) errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => { if (response.status() === 404) errors.push(`404 ${response.url()}`); });

  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Browse articles' })).toBeVisible();
  await expect(page.locator('img.brand-logo')).toHaveJSProperty('complete', true);
  expect(await page.evaluate(() => document.fonts.check('1rem "NMS Futura"'))).toBe(true);
  expect(await violations(page)).toEqual([]);

  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Admin sign-in' })).toBeVisible();
  expect(await violations(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('pages fit 300 px without horizontal scrolling (UI-12)', async ({ page }) => {
  await prepare(page);
  await page.setViewportSize({ width: 300, height: 700 });
  for (const url of ['/', `/?article=${articleId}`, '/?view=new', '/admin']) {
    await page.goto(url);
    await expect(page.locator('main')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, url).toBe(0);
  }
});
