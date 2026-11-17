import { expect, test } from '@playwright/test';
import { auth, editor, moderator } from './fixtures';

/**
 * The public knowledge base (TEST-6): the article list's filters and cursor
 * paging, article cards, Markdown rendering (SEC-12, SEC-13), the page chrome
 * (UI-7, API-14), and member sign-in (FE-3).
 */

test.describe('article list', () => {
  test('loads the visibility, pin and verification filters from the address and sends them', async ({ page }) => {
    const request = page.waitForRequest((candidate) => new URL(candidate.url()).pathname === '/api/articles');
    await page.goto('/?visibility=public&pinned=pinned&verification=verified');
    const query = new URL((await request).url()).searchParams;
    expect([query.get('visibility'), query.get('pinned'), query.get('verification')]).toEqual(['public', 'pinned', 'verified']);
    await expect(page.getByRole('combobox', { name: 'Pin status' })).toHaveValue('pinned');
    await expect(page.getByRole('combobox', { name: 'Visibility' })).toHaveValue('public');
    await expect(page.getByRole('combobox', { name: 'Verified' })).toHaveValue('verified');
  });

  test('defaults the verification filter to all articles, and loads a numeric AGT visibility filter', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('combobox', { name: 'Verified' })).toHaveValue('all');
    const request = page.waitForRequest((candidate) => new URL(candidate.url()).pathname === '/api/articles');
    await page.goto('/?visibility=0');
    expect(new URL((await request).url()).searchParams.get('visibility')).toBe('0');
    await expect(page.getByRole('combobox', { name: 'Visibility' })).toHaveValue('0');
  });

  test('shows the total, and loads the next page with the cursor (API-8)', async ({ page }) => {
    // Other specs add articles too; the thirteen seeded waypoints are found by their word.
    await page.goto('/?search=Waypoint');
    await expect(page.getByText('Results: 13 · shown: 12')).toBeVisible();
    const next = page.waitForRequest((candidate) => new URL(candidate.url()).searchParams.has('cursor'));
    await page.getByRole('button', { name: 'Load more' }).click();
    const query = new URL((await next).url()).searchParams;
    expect(query.get('limit')).toBe('12');
    await expect(page.getByText('Results: 13 · shown: 13')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Load more' })).toBeHidden();
  });
});

test.describe('as a moderator', () => {
  test.use({ storageState: auth.moderator });

  test('filters by a canonical tag ID instead of free text', async ({ page }) => {
    await page.goto('/');
    const tagFilter = page.getByRole('combobox', { name: 'Tag' });
    await expect(tagFilter).toBeEnabled();
    const request = page.waitForRequest((candidate) => new URL(candidate.url()).searchParams.has('tagId'));
    await tagFilter.selectOption({ label: 'portal' });
    expect(new URL((await request).url()).searchParams.get('tagId')).toMatch(/^[0-9a-f-]{36}$/);
    await expect(page.locator('.article-card')).toHaveCount(1);
  });

  test('shows the status indicators between the title and the excerpt, and labels numeric visibility', async ({ page }) => {
    await page.goto('/?search=Portal&pinned=pinned');
    const card = page.locator('.article-card', { has: page.getByRole('heading', { name: 'Portal Guide', exact: true }) });
    await expect(card.getByText('Internal')).toHaveClass(/visibility-internal/);
    await expect(card.locator('.visibility-eye-icon')).toHaveCount(1);
    await expect(card.getByText('Verified', { exact: true })).toHaveClass(/verified/);
    await expect(card.getByText('Pinned', { exact: true })).toHaveClass(/pinned/);
    await expect(card.getByText('Protected', { exact: true })).toHaveClass(/protected/);
    const order = await card.evaluate((element) => {
      const status = element.querySelector('.article-card-status');
      return [status?.previousElementSibling?.className, status?.nextElementSibling?.className, status?.nextElementSibling?.nextElementSibling?.className];
    });
    expect(order[0]).toContain('article-card-heading');
    expect(order[1]).toContain('excerpt');
    expect(order[2]).toContain('tag-list');
    await page.goto('/?search=Secret');
    await expect(page.locator('.article-card', { hasText: 'Secret Plans' }).getByText('Top Secret')).toHaveClass(/visibility-top-secret/);
  });

  test('shows the Tags link and the Moderator badge', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Manage tags' })).toHaveAttribute('href', '/?view=tags');
    await expect(page.locator('.identity-badge', { hasText: `${moderator.displayName} · Moderator` })).toHaveClass(/moderator/);
  });
});

test.describe('as an editor', () => {
  test.use({ storageState: auth.editor });

  test('hides tag management and the Moderator badge', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.identity-badge', { hasText: `${editor.displayName} · Editor` })).not.toHaveClass(/moderator/);
    await expect(page.getByRole('link', { name: /tags/i })).toHaveCount(0);
  });
});

test.describe('Markdown (SEC-12, SEC-13)', () => {
  test.use({ storageState: auth.moderator });

  test('shows raw HTML as text, drops unsafe URLs, and gives headings the table of contents ids', async ({ page }) => {
    await page.route(/\/api\/member\/articles\/[0-9a-f-]{36}$/, async (route) => {
      const response = await route.fetch();
      const article = await response.json() as Record<string, unknown>;
      article.content = [
        '# Portal Guide', '', 'Hello <b onclick="x()">bold</b>', '', '<script>alert(1)</script>', '',
        '[bad](javascript:alert(1)) ![pixel](data:image/png;base64,AAAA)', '',
        '[out](https://example.org) [in](#steps)', '', '![Portal map](https://example.org/map.png)', '',
        '## Steps', '', '## Steps',
      ].join('\n');
      await route.fulfill({ response, json: article });
    });
    await page.route('https://example.org/map.png', (route) => route.abort());
    await page.goto('/');
    await page.getByRole('link', { name: 'Portal Guide' }).first().click();
    const body = page.locator('.article-body');
    await expect(body).toContainText('<b onclick="x()">bold</b>');
    await expect(body).toContainText('<script>alert(1)</script>');
    expect(await body.locator('b, script').count()).toBe(0);
    expect(await body.getByRole('link', { name: 'bad' }).getAttribute('href') ?? '').toBe('');
    await expect(body.locator('img[src^="data:"]')).toHaveCount(0);
    const external = body.getByRole('link', { name: 'out' });
    await expect(external).toHaveAttribute('target', '_blank');
    await expect(external).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(body.getByRole('link', { name: 'in' })).not.toHaveAttribute('target');
    await expect(body.getByRole('img', { name: 'Portal map' })).toHaveText('[Image: Portal map]');
    expect(await body.locator('h1, h2').evaluateAll((headings) => headings.map((heading) => heading.id))).toEqual(['portal-guide', 'steps', 'steps-2']);
  });

  test('loads external images lazily without a referrer', async ({ page }) => {
    await page.route(/\/api\/member\/articles\/[0-9a-f-]{36}$/, async (route) => {
      const response = await route.fetch();
      const article = await response.json() as Record<string, unknown>;
      article.content = '# Map\n\n![Portal map](https://example.org/map.png)';
      await route.fulfill({ response, json: article });
    });
    await page.route('https://example.org/map.png', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
    await page.goto('/');
    await page.getByRole('link', { name: 'Portal Guide' }).first().click();
    const image = page.locator('img[alt="Portal map"]');
    await expect(image).toHaveAttribute('loading', 'lazy');
    await expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
  });
});

test.describe('page chrome (UI-7)', () => {
  test('shows the brand lockup, a support link, and labelled icon buttons', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.brand-name')).toHaveText('Alliance of Galactic Travellers');
    await expect(page.locator('img.brand-logo')).toHaveAttribute('src', '/AgtOfficialLogo.webp');
    await expect(page.locator('img.brand-logo')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.getByRole('link', { name: 'Support' })).toHaveAttribute('href', 'https://www.nms-agt.com/support');
    for (const button of await page.locator('.header-actions .button-icon').all()) {
      const label = await button.getAttribute('aria-label');
      expect(label).toBeTruthy();
      expect(await button.getAttribute('title')).toBe(label);
    }
  });

  for (const [who, state] of [['visitors', undefined], ['editors', auth.editor], ['moderators', auth.moderator]] as const) {
    test(`never links ${who} to the admin panel or an API reference (API-14)`, async ({ browser }) => {
      const context = await browser.newContext(state ? { storageState: state } : {});
      const page = await context.newPage();
      await page.goto('/');
      await expect(page.locator('main')).toBeVisible();
      await expect(page.locator('a[href^="/admin"]')).toHaveCount(0);
      await expect(page.locator('a[href^="/api"]')).toHaveCount(0);
      await expect(page.getByRole('link', { name: /API reference|admin/i })).toHaveCount(0);
      await context.close();
    });
  }
});

test.describe('member sign-in (FE-3)', () => {
  test('describes local credentials, signs in, returns to the requested page, and keeps nothing in localStorage', async ({ page }) => {
    await page.goto(`/?view=login&next=${encodeURIComponent('/?view=new')}`);
    await expect(page.getByText(/AGT Knowledge Base account/)).toBeVisible();
    await expect(page.getByText(/cognito/i)).toHaveCount(0);
    await page.getByLabel('Username or email').fill(editor.username);
    await page.getByLabel('Password').fill(editor.password);
    await page.getByRole('main').getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/\?view=new$/);
    expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key !== 'agt_knowledge_base_settings'))).toEqual([]);
    // The session is the HttpOnly cookie, which survives a reload.
    await page.reload();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
  });

  test('never returns to another site after signing in', async ({ page }) => {
    await page.goto(`/?view=login&next=${encodeURIComponent('https://evil.example/')}`);
    await expect(page).toHaveURL(/\/\?view=login$/);
    await page.getByLabel('Username or email').fill(editor.username);
    await page.getByLabel('Password').fill(editor.password);
    await page.getByRole('main').getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
  });

  test('shows the sign-in error and stays on the page', async ({ page }) => {
    await page.goto('/?view=login');
    await page.getByLabel('Username or email').fill(editor.username);
    await page.getByLabel('Password').fill('Wrong-password-1!');
    await page.getByRole('main').getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toHaveText('The username or password is wrong.');
    await expect(page.getByRole('main').getByRole('button', { name: 'Sign in' })).toBeEnabled();
    await expect(page).toHaveURL(/view=login/);
  });

  test('signs out locally even when the logout request fails', async ({ browser }) => {
    const context = await browser.newContext({ storageState: auth.editor });
    const page = await context.newPage();
    await page.route('**/api/member/logout', (route) => route.abort());
    await page.goto('/');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
    await context.close();
  });
});
