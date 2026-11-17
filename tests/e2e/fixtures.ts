import AxeBuilder from '@axe-core/playwright';
import { expect, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Shared names and helpers of the browser tests (TEST-6). The setup project
 * (`setup.spec.ts`) creates the Admin, two members and the sample content
 * once, and saves the signed-in states under `tests/e2e/.auth/`.
 */

export const auth = {
  admin: 'tests/e2e/.auth/admin.json',
  moderator: 'tests/e2e/.auth/moderator.json',
  editor: 'tests/e2e/.auth/editor.json',
};

export const admin = { username: 'keeper', password: 'Admin-Password-1!' };
export const moderator = { username: 'apollo', displayName: 'Apollo', password: 'Moderator-Pass-1!' };
export const editor = { username: 'hermes', displayName: 'Hermes', password: 'Editor-Password-1!' };

export const csrf = { 'x-agt-request': '1' };

/** Collects CSP violations from the first script on every page. */
export async function watchViolations(page: Page) {
  await page.addInitScript(() => {
    const violations: { directive: string; blocked: string }[] = [];
    (window as unknown as { violations: typeof violations }).violations = violations;
    document.addEventListener('securitypolicyviolation', (event) => {
      violations.push({ directive: event.effectiveDirective, blocked: event.blockedURI });
    });
  });
}

export async function violations(page: Page): Promise<{ directive: string; blocked: string }[]> {
  return page.evaluate(() => (window as unknown as { violations: { directive: string; blocked: string }[] }).violations.slice());
}

/** Stores browser preferences before the app reads them (FE-3). */
export async function preferences(page: Page, values: Record<string, unknown>) {
  await page.addInitScript((stored) => localStorage.setItem('agt_knowledge_base_settings', JSON.stringify(stored)), values);
}

/** No WCAG 2.2 AA violation on the page (A11Y-1, A11Y-3, A11Y-5). */
export async function expectAccessible(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`), label).toEqual([]);
}

/** No horizontal page scroll (UI-12). */
export async function expectNoHorizontalScroll(page: Page, label: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, label).toBeLessThanOrEqual(0);
}

/** Opens `opener` from the keyboard, checks that Tab stays inside the dialog, Escape closes it and focus returns (A11Y-2). */
export async function expectDialogBehaviour(page: Page, opener: ReturnType<Page['getByRole']>, name: string | RegExp) {
  await opener.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name });
  await expect(dialog).toBeVisible();
  for (let step = 0; step < 15; step += 1) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((element) => element.contains(document.activeElement)), `Tab ${step + 1} stays in the dialog`).toBe(true);
  }
  await page.keyboard.press('Shift+Tab');
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
}

export interface CreatedArticle {
  id: string;
  title: string;
  version: number;
}

/** Creates an article through the API with the signed-in member's cookie. */
export async function createArticle(request: APIRequestContext, input: { title: string; content?: string; visibility?: string | number; tagIds?: string[] }): Promise<CreatedArticle> {
  const response = await request.post('/api/articles', {
    headers: csrf,
    data: {
      title: input.title,
      content: input.content ?? `${input.title}: field-tested guidance for every traveller of the Alliance.`,
      tagIds: input.tagIds ?? [],
      visibility: input.visibility ?? 'Public',
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return response.json() as Promise<CreatedArticle>;
}

export async function createTag(request: APIRequestContext, name: string, color = '#B5C3B7') {
  const response = await request.post('/api/tags', { headers: csrf, data: { name, color } });
  expect(response.status(), await response.text()).toBe(201);
  return response.json() as Promise<{ id: string; name: string; color: string }>;
}
