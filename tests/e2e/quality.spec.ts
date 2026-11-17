import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  admin,
  auth,
  createArticle,
  expectAccessible,
  expectDialogBehaviour,
  expectNoHorizontalScroll,
  preferences,
  violations,
  watchViolations,
} from './fixtures';

/**
 * TEST-6's checks across the app: both entries load without console errors
 * or CSP violations (SEC-1), the PDF export only trips html2canvas's probes
 * (#48 §2), every page passes axe's WCAG 2.2 AA rules (A11Y-1, A11Y-3,
 * A11Y-5), no page scrolls sideways at the UI-12 widths or at 300 px with the
 * 2× text size (A11Y-6) and in long-word and non-Latin languages (I18N-3),
 * every dialog keeps the keyboard (A11Y-2), and status messages are announced
 * (A11Y-4).
 */

let articleId = '';

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ storageState: auth.moderator });
  articleId = (await createArticle(context.request, {
    title: 'Quality Guide',
    content: '# Quality Guide\n\nSafe portal navigation instructions for every traveller.\n\n## Steps\n\n- Step one\n- Step two',
  })).id;
  await context.close();
});

async function adminPage(browser: Browser, options: { width?: number } = {}) {
  const context = await browser.newContext(options.width ? { viewport: { width: options.width, height: 800 } } : {});
  const page = await context.newPage();
  await page.goto('/admin');
  await page.getByLabel('Username').fill(admin.username);
  await page.getByLabel('Password').fill(admin.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('tablist')).toBeVisible();
  return { context, page };
}

/** The member pages a Moderator sees, by URL. */
const memberPages = () => ['/', `/?article=${articleId}`, `/?article=${articleId}&view=history`, '/?view=new', `/?article=${articleId}&view=edit`, '/?view=tags'];
const adminTabs = ['Users', 'Data', 'Settings', 'Server log', 'Audit log', 'Backup & restore', 'Account', 'API'];

async function settle(page: Page) {
  await expect(page.locator('main')).toBeVisible();
  await page.waitForLoadState('networkidle');
}

test.describe('both entries (SEC-1)', () => {
  test('load without console errors or CSP violations', async ({ page }) => {
    await watchViolations(page);
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

  test('the PDF export finishes; only html2canvas probes are blocked, and only while exporting (#48 §2)', async ({ browser }) => {
    const context = await browser.newContext({ storageState: auth.moderator });
    const page = await context.newPage();
    await watchViolations(page);
    await preferences(page, { allowDownloads: true });
    await page.goto(`/?article=${articleId}`);
    await expect(page.locator('.article-header h1')).toHaveText('Quality Guide');
    expect(await violations(page)).toEqual([]);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download PDF' }).click();
    expect((await download).suggestedFilename()).toBe('Quality Guide.pdf');
    for (const violation of await violations(page)) {
      const probe = (violation.directive.startsWith('style-src') && violation.blocked === 'inline') || (violation.directive === 'img-src' && violation.blocked === 'data');
      expect(probe, JSON.stringify(violation)).toBe(true);
    }
    await context.close();
  });
});

test.describe('accessibility (A11Y-1, A11Y-3, A11Y-5)', () => {
  test('every public page passes axe WCAG 2.2 AA', async ({ page }) => {
    for (const url of ['/', `/?article=${articleId}`, '/?view=login']) {
      await page.goto(url);
      await settle(page);
      await expectAccessible(page, url);
    }
  });

  test('every member page passes axe WCAG 2.2 AA', async ({ browser }) => {
    const context = await browser.newContext({ storageState: auth.moderator });
    const page = await context.newPage();
    for (const url of memberPages()) {
      await page.goto(url);
      await settle(page);
      await expectAccessible(page, url);
    }
    await page.goto('/');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expectAccessible(page, 'settings dialog');
    await context.close();
  });

  test('the admin sign-in and every admin tab pass axe WCAG 2.2 AA', async ({ browser, page }) => {
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Admin sign-in' })).toBeVisible();
    await expectAccessible(page, 'admin sign-in');
    const signedIn = await adminPage(browser);
    for (const tab of adminTabs) {
      await signedIn.page.getByRole('tab', { name: tab }).click();
      await expect(signedIn.page.getByRole('tabpanel', { name: tab })).toBeVisible();
      await signedIn.page.waitForLoadState('networkidle');
      await expectAccessible(signedIn.page, `admin ${tab}`);
    }
    await signedIn.context.close();
  });

  test('every button and input has an accessible name', async ({ browser }) => {
    const context = await browser.newContext({ storageState: auth.moderator });
    const page = await context.newPage();
    for (const url of memberPages()) {
      await page.goto(url);
      await settle(page);
      const unnamed = await page.locator('button:visible, input:visible, select:visible, textarea:visible, [role="combobox"]:visible').evaluateAll((elements) => elements
        .filter((element) => !(element as HTMLElement).closest('.mdxeditor'))
        .filter((element) => {
          const labelled = element.getAttribute('aria-label') || element.getAttribute('aria-labelledby') || element.getAttribute('title');
          const id = element.getAttribute('id');
          const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
          return !labelled && !label && !element.closest('label') && !(element as HTMLElement).innerText?.trim() && element.getAttribute('type') !== 'hidden';
        })
        .map((element) => element.outerHTML.slice(0, 120)));
      expect(unnamed, url).toEqual([]);
    }
    await context.close();
  });
});

test.describe('layout (UI-12, A11Y-6, I18N-3)', () => {
  for (const width of [300, 520, 640, 760, 1180]) {
    test(`no page scrolls sideways at ${width} px`, async ({ browser }) => {
      const context = await browser.newContext({ storageState: auth.moderator, viewport: { width, height: 800 } });
      const page = await context.newPage();
      for (const url of [...memberPages(), '/?view=login']) {
        await page.goto(url);
        await settle(page);
        await expectNoHorizontalScroll(page, `${width} px ${url}`);
      }
      await context.close();
      const signedIn = await adminPage(browser, { width });
      for (const tab of adminTabs) {
        await signedIn.page.getByRole('tab', { name: tab }).click();
        await signedIn.page.waitForLoadState('networkidle');
        await expectNoHorizontalScroll(signedIn.page, `${width} px admin ${tab}`);
      }
      await signedIn.context.close();
    });
  }

  test('no page scrolls sideways at 300 px with the 2× text size', async ({ browser }) => {
    const context = await browser.newContext({ storageState: auth.moderator, viewport: { width: 300, height: 800 } });
    const page = await context.newPage();
    await preferences(page, { fontScale: '2' });
    for (const url of memberPages()) {
      await page.goto(url);
      await settle(page);
      await expect(page.locator('html')).toHaveAttribute('data-font-scale', '2');
      await expectNoHorizontalScroll(page, `2× ${url}`);
    }
    await context.close();
  });

  for (const language of ['de', 'th', 'hi']) {
    test(`no page scrolls sideways at 300 px in ${language}, with <html lang> set`, async ({ browser }) => {
      const context = await browser.newContext({ storageState: auth.moderator, viewport: { width: 300, height: 800 } });
      const page = await context.newPage();
      await preferences(page, { language });
      for (const url of [...memberPages(), '/admin']) {
        await page.goto(url);
        await settle(page);
        await expect(page.locator('html')).toHaveAttribute('lang', language);
        await expectNoHorizontalScroll(page, `${language} ${url}`);
      }
      await context.close();
    });
  }
});

test.describe('dialogs (A11Y-2) and status messages (A11Y-4)', () => {
  test('the settings dialog opens from the keyboard, keeps Tab inside, closes with Escape and returns focus', async ({ page }) => {
    await page.goto('/');
    await expectDialogBehaviour(page, page.getByRole('button', { name: 'Settings', exact: true }), 'Settings');
  });

  test('the member dialogs keep the keyboard', async ({ browser }) => {
    const context = await browser.newContext({ storageState: auth.moderator });
    const page = await context.newPage();
    await page.goto('/');
    await expectDialogBehaviour(page, page.getByRole('button', { name: 'Settings', exact: true }), 'Settings');
    // The save review dialog of the editor.
    await page.goto('/?view=new');
    await page.getByLabel('Title').fill('Dialog Guide');
    await page.getByRole('textbox', { name: /markdown source/i }).fill('# Dialog Guide\n\nKeyboard-only instructions for travellers.');
    await expectDialogBehaviour(page, page.getByRole('button', { name: 'Save article' }), 'Review changes before saving');
    // The confirmations of the revision history.
    await page.goto(`/?article=${articleId}&view=edit`);
    await page.getByRole('textbox', { name: /markdown source/i }).fill('# Quality Guide\n\nA second revision for the history.');
    await page.getByRole('button', { name: 'Save article' }).click();
    await page.getByRole('button', { name: 'Confirm save' }).click();
    await expect(page).toHaveURL(new RegExp(`article=${articleId}$`));
    await page.goto(`/?article=${articleId}&view=history`);
    await expectDialogBehaviour(page, page.getByRole('button', { name: /^Restore version \d+$/ }).first(), /^Restore version \d+\?$/, 'alertdialog');
    await context.close();
  });

  test('the admin dialogs keep the keyboard, and status messages are announced', async ({ browser }) => {
    const { context, page } = await adminPage(browser);
    await expectDialogBehaviour(page, page.getByRole('button', { name: 'Settings', exact: true }), 'Settings');
    await page.getByRole('tab', { name: 'Server log' }).click();
    await expectDialogBehaviour(page, page.getByRole('button', { name: 'Clear log' }), 'Clear the server log?', 'alertdialog');
    await page.getByRole('tab', { name: 'Users' }).click();
    await page.locator('.admin-user-card summary').first().click();
    const remove = page.getByRole('button', { name: 'Delete user' }).first();
    await expect(remove).toBeVisible();
    await expectDialogBehaviour(page, remove, /^Delete “.+”\?$/, 'alertdialog');
    // A11Y-4: a status change is announced in a live region.
    await page.getByRole('tab', { name: 'Server log' }).click();
    await page.getByRole('button', { name: 'Clear log' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Clear the server log' }).click();
    const status = page.locator('[role="status"], [aria-live]').filter({ hasText: 'The server log was cleared.' });
    await expect(status).toBeVisible();
    await context.close();
  });
});
