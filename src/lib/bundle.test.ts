import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/** The admin panel is a separate entry: the member bundle never imports it (API-14, UI-8). */

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === 'admin' ? [] : sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('bundle separation', () => {
  it('keeps admin panel code out of the member bundle', () => {
    const files = sources('src');
    assert.ok(files.length > 10);
    for (const path of files) {
      const source = readFileSync(path, 'utf8');
      assert.doesNotMatch(source, /from ['"][./]*admin\//, path);
      assert.doesNotMatch(source, /['"]\/admin['"]/, path);
    }
  });

  it('serves the admin panel from its own HTML entry', () => {
    assert.match(readFileSync('admin.html', 'utf8'), /\/src\/admin\/main\.tsx/);
    assert.doesNotMatch(readFileSync('index.html', 'utf8'), /admin/);
  });
});
