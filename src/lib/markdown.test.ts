import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSlugger, extractHeadings, isExternal, remarkHtmlAsText, safeUrl } from './markdown.js';

describe('Markdown rendering rules (SEC-12, SEC-13)', () => {
  it('keeps only http(s) and same-site URLs', () => {
    assert.equal(safeUrl('https://example.org/a'), 'https://example.org/a');
    assert.equal(safeUrl('HTTP://example.org'), 'HTTP://example.org');
    assert.equal(safeUrl('#heading'), '#heading');
    assert.equal(safeUrl('/articles/1'), '/articles/1');
    for (const url of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,x', 'vbscript:x', 'mailto:a@b.c', '//evil.example/x']) {
      assert.equal(safeUrl(url), '', url);
    }
  });

  it('treats only http(s) links as external', () => {
    assert.equal(isExternal('https://example.org'), true);
    assert.equal(isExternal('#section'), false);
    assert.equal(isExternal('/?article=1'), false);
    assert.equal(isExternal(undefined), false);
  });

  it('turns raw HTML nodes into text', () => {
    const tree = { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'html', value: '<b>bold</b>' }] }, { type: 'html', value: '<script>x</script>' }] };
    remarkHtmlAsText()(tree);
    assert.deepEqual(JSON.stringify(tree).match(/"type":"html"/g), null);
    assert.equal(tree.children[1].type, 'text');
  });

  it('gives headings unique ids, outside code fences, as the table of contents links them', () => {
    assert.deepEqual(extractHeadings('# Portal Guide\n\n## Steps\n\n## Steps').map((heading) => heading.id), ['portal-guide', 'steps', 'steps-2']);
    assert.deepEqual(extractHeadings('```\n# not a heading\n```\n### **Bold** [link]').map((heading) => [heading.depth, heading.text]), [[3, 'Bold link']]);
    const slug = createSlugger();
    assert.deepEqual([slug('Ünïcode é'), slug('!!!')], ['ünïcode-é', 'section']);
  });
});
