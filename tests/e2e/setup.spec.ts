import { expect, test } from '@playwright/test';
import { baseURL, setupPassword } from './environment';
import { admin, auth, createArticle, createTag, csrf, editor, moderator } from './fixtures';

/**
 * First run through the UI (AUTH-5, TEST-6): the setup project creates the
 * Admin with the setup password, creates two members (with their security
 * levels, #70) in the Users tab, signs
 * each of them in at /?view=login, and saves the signed-in states the other
 * projects use.
 */

test('first-run setup creates the Admin, and the Admin creates the members', async ({ page }) => {
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Create the Admin account' })).toBeVisible();
  await page.getByLabel('Setup password').fill(setupPassword);
  await page.getByLabel('Admin username').fill(admin.username);
  await page.getByLabel('New password', { exact: true }).fill(admin.password);
  await page.getByLabel('Confirm new password').fill(admin.password);
  await page.getByRole('button', { name: 'Complete setup' }).click();
  await expect(page.getByRole('tablist')).toBeVisible();
  // AUTH-6: the setup password is still set, so the dashboard reminds the Admin.
  await expect(page.getByText(/AGT_KNOWLEDGE_BASE_SETUP_PASSWORD is still set/)).toBeVisible();

  // The security level decides what each member reads (#70): the Moderator everything, the Editor up to Private.
  for (const [member, role, level] of [[moderator, 'Moderator', '5'], [editor, 'Editor', '1']] as const) {
    await page.getByLabel('Username', { exact: true }).first().fill(member.username);
    await page.getByLabel('Display name').first().fill(member.displayName);
    await page.getByLabel('Role').first().selectOption(role);
    await expect(page.getByLabel('Security level').first()).toHaveValue('0');
    await page.getByLabel('Security level').first().selectOption(level);
    await page.getByLabel('Initial password').fill(member.password);
    await page.getByRole('button', { name: 'Create user' }).click();
    await expect(page.getByRole('status').filter({ hasText: `“${member.username}”` })).toBeVisible();
  }
  await page.context().storageState({ path: auth.admin });
});

for (const [name, member] of [['moderator', moderator], ['editor', editor]] as const) {
  test(`the ${name} signs in to the knowledge base`, async ({ page }) => {
    await page.goto('/?view=login');
    await page.getByLabel('Username or email').fill(member.username);
    await page.getByLabel('Password').fill(member.password);
    await page.getByRole('main').getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await page.context().storageState({ path: auth[name] });
  });
}

test('the moderator writes the sample content', async ({ playwright }) => {
  const request = await playwright.request.newContext({ baseURL, storageState: auth.moderator });
  const tag = await createTag(request, 'portal', '#B5C3B7');
  // Thirteen public waypoints: one more than a page of the article list (API-8), found by their own word.
  for (let index = 1; index <= 13; index += 1) {
    await createArticle(request, { title: `Waypoint ${String(index).padStart(2, '0')}` });
  }
  const portal = await createArticle(request, {
    title: 'Portal Guide',
    content: '# Portal Guide\n\nSafe portal navigation instructions for every traveller.\n\n## Steps\n\n- Step one\n- Step two\n\n## Steps\n\n[out](https://example.org) [in](#steps)',
    visibility: 'Internal',
    tagIds: [tag.id],
  });
  let version = portal.version;
  for (const [flag, body] of [['pinning', { isPinned: true }], ['protection', { isProtected: true }], ['verification', { isVerified: true }]] as const) {
    const response = await request.patch(`/api/articles/${portal.id}/${flag}`, { headers: csrf, data: { ...body, version } });
    expect(response.status(), await response.text()).toBe(200);
    version = (await response.json() as { version: number }).version;
  }
  await createArticle(request, { title: 'Secret Plans', visibility: 3 });
  await request.dispose();
});
