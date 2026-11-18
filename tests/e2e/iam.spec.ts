import { expect, test, type Browser, type Page } from '@playwright/test';
import { auth, expectAccessible, expectNoHorizontalScroll } from './fixtures';

/**
 * AGT sign-in (issue #30) against the fake AGT IAM (`fake-iam.ts`): the Admin
 * switches `iam.enabled` on in the Settings tab, a traveller signs in with
 * their AGT account, the Admin sees them as an AGT member, and switching the
 * setting off signs them out. The tests run in order and leave the setting
 * off, as every other spec expects.
 */

const traveller = { name: 'Vega Ranger', password: 'Vega "Star", +1\\' };

test.describe.configure({ mode: 'serial' });

async function adminPage(browser: Browser) {
  const context = await browser.newContext({ storageState: auth.admin });
  const page = await context.newPage();
  await page.goto('/admin');
  await expect(page.getByRole('tablist')).toBeVisible();
  return page;
}

async function setAgtSignIn(browser: Browser, on: boolean) {
  const page = await adminPage(browser);
  await page.getByRole('tab', { name: 'Settings' }).click();
  const checkbox = page.getByLabel('Let members sign in with their AGT account (AGT IAM)');
  await expect(page.getByText('AGT IAM is configured.')).toBeVisible();
  await checkbox.setChecked(on);
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'The settings were saved.' })).toBeVisible();
  await page.context().close();
}

async function chooseAgt(page: Page) {
  const tabs = page.getByRole('tablist', { name: 'Sign-in method' });
  await expect(tabs.getByRole('tab')).toHaveText(['Local account', 'AGT account']);
  await expect(tabs.getByRole('tab', { name: 'Local account' })).toHaveAttribute('aria-selected', 'true');
  // The arrow keys move between the methods (A11Y-4).
  await tabs.getByRole('tab', { name: 'Local account' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.getByRole('tab', { name: 'AGT account' })).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.getByRole('tab', { name: 'AGT account' })).toBeFocused();
}

test.afterAll(async ({ browser }) => {
  // Leave AGT sign-in off for the other specs, whatever happened above.
  const context = await browser.newContext({ storageState: auth.admin });
  await context.request.put('/api/admin/settings', { headers: { 'x-agt-request': '1' }, data: { values: { 'iam.enabled': null } } });
  await context.close();
});

test('shows only the local sign-in while AGT sign-in is off', async ({ page }) => {
  await page.goto('/?view=login');
  await expect(page.getByLabel('Username or email')).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(0);
});

test('signs a traveller in with their AGT account once the Admin switches it on', async ({ browser, page }) => {
  await setAgtSignIn(browser, true);
  await page.goto('/?view=login');
  await chooseAgt(page);
  await expect(page.getByText(/AGT IAM checks them/)).toBeVisible();
  await expectAccessible(page, 'AGT sign-in');
  await expectNoHorizontalScroll(page, 'AGT sign-in');

  // Field errors come from the shared validator before anything is sent.
  await page.getByLabel('Traveller Name').fill('A'.repeat(43));
  await page.getByLabel('Password').fill('x');
  await page.getByRole('main').getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Traveller Name must be at most 42 characters.')).toBeVisible();

  await page.getByLabel('Traveller Name').fill(traveller.name);
  await page.getByLabel('Password').fill('wrong');
  await page.getByRole('main').getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('The username or password is wrong.');

  await page.getByLabel('Password').fill(traveller.password);
  await page.getByRole('main').getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog.getByText(traveller.name, { exact: true })).toBeVisible();
  await expect(dialog.getByText('AGT account', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Moderator', { exact: true })).toBeVisible();
});

test('tells a traveller whose AGT account has no access to the Knowledge Base', async ({ page }) => {
  await page.goto('/?view=login');
  await chooseAgt(page);
  await page.getByLabel('Traveller Name').fill('Locked Out');
  await page.getByLabel('Password').fill('Locked-Out-1');
  await page.getByRole('main').getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Your AGT account is not authorized for the Knowledge Base. Ask an AGT administrator for access.');
});

test('shows the AGT member to the Admin with only activation and deletion', async ({ browser }) => {
  const page = await adminPage(browser);
  await page.getByLabel('Search', { exact: true }).fill('Vega');
  const card = page.locator('details.admin-user-card', { hasText: traveller.name });
  await card.locator('summary').click();
  await expect(card.getByText('AGT account · Moderator')).toBeVisible();
  await expect(card.getByText('AGT-E2E-1')).toBeVisible();
  await expect(card.getByLabel('Username')).toHaveCount(0);
  await expect(card.getByLabel('New password')).toHaveCount(0);
  await expect(card.getByRole('checkbox', { name: 'Active' })).toBeChecked();
  await expectAccessible(page, 'AGT member in the Users tab');
  await page.context().close();
});

test('signs every AGT member out when the Admin switches AGT sign-in off', async ({ browser, page }) => {
  await page.goto('/?view=login');
  await chooseAgt(page);
  await page.getByLabel('Traveller Name').fill(traveller.name);
  await page.getByLabel('Password').fill(traveller.password);
  await page.getByRole('main').getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

  await setAgtSignIn(browser, false);
  await page.goto('/?view=login');
  await expect(page.getByLabel('Username or email')).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
});
