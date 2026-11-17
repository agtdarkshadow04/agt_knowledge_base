import { expect, test } from '@playwright/test';
import { admin, auth, moderator } from './fixtures';

/**
 * The reader's preferences (FE-3, I18N-4, A11Y-6): the settings dialog of the
 * knowledge base, the one `agt_knowledge_base_settings` object, the 1.x keys it
 * replaces, the language switch, and the admin API reference in the reader's
 * language (I18N-3, I18N-5).
 */

test('shows the account fallbacks to visitors who are not signed in', async ({ page }) => {
  await page.goto('/');
  const opener = page.getByRole('button', { name: 'Settings', exact: true });
  await expect(opener).toHaveAttribute('title', 'Settings');
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(opener).toHaveAttribute('aria-expanded', 'true');
  await expect(dialog.getByText('Not signed in')).toBeVisible();
  await expect(dialog.getByText('N/A')).toHaveCount(2);
  await expect(dialog.getByRole('combobox', { name: 'Article downloads' })).toHaveCount(0);
});

test.describe('signed in', () => {
  test.use({ storageState: auth.moderator });

  test('shows the account, and stores every preference in one agt_knowledge_base_settings object', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await expect(dialog.getByText(moderator.username, { exact: true })).toBeVisible();
    await expect(dialog.getByText('Moderator', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('heading', { level: 3 })).toHaveText(['Language and display', 'Articles', 'Account']);
    await expect(dialog.getByRole('combobox', { name: 'Search results' })).toHaveValue('cards');
    await expect(dialog.getByRole('combobox', { name: 'Article downloads' })).toHaveValue('false');
    const scale = dialog.getByRole('combobox', { name: 'Text size' });
    expect(await scale.locator('option').evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value))).toEqual(['1', '1.25', '1.5', '1.75', '2']);
    await dialog.getByRole('combobox', { name: 'Search results' }).selectOption('rows');
    await dialog.getByRole('combobox', { name: 'Article downloads' }).selectOption('true');
    await scale.selectOption('1.5');
    await expect(page.locator('html')).toHaveAttribute('data-font-scale', '1.5');
    expect(JSON.parse(await page.evaluate(() => localStorage.getItem('agt_knowledge_base_settings') ?? '{}'))).toMatchObject({ searchResults: 'rows', allowDownloads: true, fontScale: '1.5' });
    expect(await page.evaluate(() => Object.keys(localStorage))).toEqual(['agt_knowledge_base_settings']);
  });

  test('switches the whole interface and <html lang> to the chosen language (I18N-3, I18N-4)', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('combobox', { name: 'Language' }).selectOption('fr');
    await expect(page.getByRole('dialog', { name: 'Paramètres' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await page.getByRole('combobox', { name: 'Langue' }).selectOption('pt');
    await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
  });
});

test('moves the 1.x preferences into the settings object once (FE-3, A11Y-6)', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('agt-font-size', 'large');
    localStorage.setItem('agt-search-results', 'rows');
    localStorage.setItem('agt-local-auth-token', 'old-bearer-token');
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-font-scale', '1.25');
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual(['agt_knowledge_base_settings']);
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem('agt_knowledge_base_settings') ?? '{}'))).toMatchObject({ fontScale: '1.25', searchResults: 'rows' });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Text size').selectOption('2');
  await expect(page.locator('html')).toHaveAttribute('data-font-scale', '2');
});

test('words the API reference\'s schema limits in the reader\'s language (I18N-3, I18N-5)', async ({ page }) => {
  await page.goto('/admin');
  await page.getByLabel('Username').fill(admin.username);
  await page.getByLabel('Password').fill(admin.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('tab', { name: 'API' }).click();
  const panel = page.getByRole('tabpanel', { name: 'API' });
  // The setup username is at most 64 characters (AdminSetupBody), worded from the schema's maxLength.
  await expect(panel.getByText('at most 64 characters').first()).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('combobox', { name: 'Language' }).selectOption('fr');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tabpanel', { name: 'API' }).getByText('au plus 64 caractères').first()).toBeVisible();
});
