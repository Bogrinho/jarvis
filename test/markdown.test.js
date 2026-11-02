import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../public/markdown.js';

// Tiny fake DOM builder: nodes are plain objects, text stays plain strings.
const h = (tag, props, ...children) => ({ tag, props: props ?? {}, children: children.filter((c) => c != null) });
const nodes = (list) => list.flatMap((n) => (typeof n === 'string' ? [] : [n, ...nodes(n.children)]));
const textOf = (n) => (typeof n === 'string' ? n : n.children.map(textOf).join(''));
const allText = (list) => list.map(textOf).join('');
const tags = (list) => nodes(list).map((n) => n.tag);

test('script tags stay text', () => {
  const out = renderMarkdown('<script>alert(1)</script> και <img src=x onerror=alert(1)>', h);
  assert.ok(!tags(out).includes('script'));
  assert.ok(!tags(out).includes('img'));
  assert.ok(allText(out).includes('<script>alert(1)</script>'));
  assert.ok(allText(out).includes('<img src=x onerror=alert(1)>'));
  // no prop ever carries raw HTML
  assert.ok(nodes(out).every((n) => !('innerHTML' in n.props) && !('html' in n.props)));
});

test('javascript: link becomes plain text', () => {
  const out = renderMarkdown('δες [εδώ](javascript:alert(1)) και [site](https://example.com/a?b=1) και [x](data:text/html,hi)', h);
  const links = nodes(out).filter((n) => n.tag === 'a');
  assert.equal(links.length, 1);
  assert.deepEqual(links[0].props, { href: 'https://example.com/a?b=1', target: '_blank', rel: 'noopener noreferrer' });
  assert.equal(textOf(links[0]), 'site');
  const text = allText(out);
  assert.ok(text.includes('εδώ'));
  assert.ok(text.includes('x'));
  assert.ok(!nodes(out).some((n) => String(n.props.href ?? '').startsWith('javascript')));
});

test('bold/code/list/code block structure', () => {
  const md = [
    'Το **SiteWatch** είναι *σχεδόν* έτοιμο, τρέξε `npm test`.',
    'δεύτερη γραμμή',
    '',
    '- πρώτο',
    '- δεύτερο **σημαντικό**',
    '',
    '1. ένα',
    '2. δύο',
    '',
    '```js',
    'if (a < b) { **not bold** }',
    '',
    '```',
    'τέλος',
  ].join('\n');
  const out = renderMarkdown(md, h);
  assert.deepEqual(out.map((n) => n.tag), ['p', 'ul', 'ol', 'pre', 'p']);

  const [p, ul, ol, pre, last] = out;
  assert.equal(p.children.find((c) => c.tag === 'b')?.children[0], 'SiteWatch');
  assert.equal(p.children.find((c) => c.tag === 'i')?.children[0], 'σχεδόν');
  assert.equal(p.children.find((c) => c.tag === 'code')?.children[0], 'npm test');
  assert.ok(p.children.some((c) => c.tag === 'br'), 'single newline is a line break inside the paragraph');

  assert.deepEqual(ul.children.map((li) => li.tag), ['li', 'li']);
  assert.equal(textOf(ul.children[1]), 'δεύτερο σημαντικό');
  assert.ok(nodes([ul.children[1]]).some((n) => n.tag === 'b'));
  assert.deepEqual(ol.children.map(textOf), ['ένα', 'δύο']);

  const code = pre.children[0];
  assert.equal(code.tag, 'code');
  assert.equal(code.children.join(''), 'if (a < b) { **not bold** }\n');
  assert.ok(!nodes([pre]).some((n) => n.tag === 'b'), 'no markdown inside code blocks');
  assert.equal(textOf(last), 'τέλος');
});

test('unclosed fence still renders as code (streaming)', () => {
  const out = renderMarkdown('κοίτα:\n```\nconst x = 1;', h);
  assert.deepEqual(out.map((n) => n.tag), ['p', 'pre']);
  assert.equal(textOf(out[1]), 'const x = 1;');
});

test('Greek text intact', () => {
  const s = 'Γειά σου! Ναι — ξεκινάω από τα «screenshots»; ΆΈΉΊΌΎΏ ϊΐ ϋΰ ς';
  const out = renderMarkdown(s, h);
  assert.equal(out.length, 1);
  assert.equal(allText(out), s);
});

test('empty and non-string input give no nodes', () => {
  assert.deepEqual(renderMarkdown('', h), []);
  assert.deepEqual(renderMarkdown(undefined, h), []);
});
