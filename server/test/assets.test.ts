import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/**
 * UI-15, UI-16: the AGT logo, fonts, licence files and base stylesheet are
 * copies of the spec repository's `assets/` at v6.0.1, byte for byte. The
 * hashes are those `assets/README.md` lists at that tag.
 */
const assets: Record<string, string> = {
  'public/AgtOfficialLogo.webp': '8bed1e5481a7ca2fc47728d67cebaa7a0e86412499b886d5755ed99bc9456674',
  'public/NMSFuturaProBook_Kerned.ttf': '08ad168f7fe58780fcb11c9369c9762ab83f30356fe4192ed60050a216a9798b',
  'public/fonts/TwemojiCountryFlags.woff2': '9f04f14429bb6a9f415c7a4dd902a918d7e81a4f7526c415496fdb063954e3b8',
  'public/fonts/NMSFuturaProBook-OFL.txt': 'e77bd97ea16773878878adbf0ac357fe1b355bdf50ca2042580240e0e0eba68c',
  'public/fonts/TwemojiCountryFlags-LICENSE.md': 'f12e4dfd8d656f0134ae2d54ff9683a0fdb15dd9e7814352ff3cad80d1e28c3d',
  'src/agt-base.css': 'eded1c5ac13280c1d752b05291766e5de1fbd8918ef6731a2b8e69d0a19cabf8',
};

describe('AGT assets (UI-15, UI-16)', () => {
  for (const [path, sha256] of Object.entries(assets)) {
    it(`${path} is the unmodified spec asset`, () => {
      assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), sha256);
    });
  }

  it('imports the base stylesheet first, and the admin stylesheet after the public one (UI-1, UI-16)', () => {
    const styles = readFileSync('src/styles.css', 'utf8');
    assert.match(styles, /^(?:\/\*[\s\S]*?\*\/\s*)?@import '\.\/agt-base\.css';/);
    const admin = readFileSync('src/admin/main.tsx', 'utf8');
    assert.ok(admin.indexOf("'../styles.css'") >= 0 && admin.indexOf("'../styles.css'") < admin.indexOf("'./admin.css'"));
  });

  it('never redefines a base token or restyles a UI-9 class (UI-16)', () => {
    const base = readFileSync('src/agt-base.css', 'utf8');
    const tokens = [...base.matchAll(/^\s*(--[a-z-]+):/gm)].map((match) => match[1]);
    const uiClasses = ['.button', '.button-primary', '.button-secondary', '.button-icon', '.field', '.field-help', '.field-error',
      '.modal-backdrop', '.modal-header', '.modal-close', '.modal-scroll-region', '.modal-toast', '.error-note', '.success-note', '.admin-notice', '.sr-only'];
    for (const file of ['src/styles.css', 'src/admin/admin.css']) {
      const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const token of tokens) assert.doesNotMatch(css, new RegExp(`${token}\\s*:`), `${file} redefines ${token}`);
      for (const rule of css.matchAll(/([^{}]+)\{/g)) {
        for (const selector of rule[1].split(',').map((part) => part.trim())) {
          // A rule whose last compound selector is a UI-9 class (with or without a state, in any context) restyles it;
          // a modifier class on the same element (.button.compact) and the class's descendants (.button .icon) do not.
          const last = selector.split(/\s+|>|\+|~/).filter(Boolean).at(-1) ?? '';
          const bare = last.replace(/:{1,2}[a-z-]+(\([^)]*\))?/g, '');
          assert.ok(!uiClasses.includes(bare), `${file} restyles ${bare} in "${selector}"`);
        }
      }
    }
  });
});
