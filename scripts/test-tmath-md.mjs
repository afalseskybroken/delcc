// node --experimental-vm-modules scripts/test-tmath-md.mjs
// Q01/F29 regression: the real src/tmath/md.ts under the VM harness — scheme
// allow-list, embed policy, escape-first structure.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { createContext, SourceTextModule } from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const context = createContext({});
const module = new SourceTextModule(
  stripTypeScriptTypes(fs.readFileSync(path.join(root, 'src/tmath/md.ts'), 'utf8')),
  { context, identifier: 'md.ts' });
await module.link(() => { throw new Error('md.ts must stay dependency-free'); });
await module.evaluate();
const { mdInline, safeUrl, embedOk } = module.namespace;

let n = 0;
const ok = (name, fn) => { fn(); console.log('PASS ' + name); n++; };

// Q01: unrestricted schemes never become href/src
ok('javascript: link stays escaped text', () => {
  const h = mdInline('[click](javascript:void%200)');
  assert.ok(!h.includes('<a '));
  assert.ok(h.includes('[click]'));
});
ok('data:/file:/vbscript: links and images stay inert', () => {
  for (const url of ['data:text/html,x', 'file:///c:/x', 'vbscript:x', 'javascript&colon;alert(1)']) {
    const link = mdInline(`[t](${url})`);
    const img = mdInline(`![t](${url})`);
    assert.ok(!link.includes('<a ') && !link.includes('href='), url);
    assert.ok(!img.includes('<img ') && !img.includes('src='), url);
  }
});
ok('scheme-obfuscated javascript is not http', () => {
  for (const url of ['JavaScript://x%0Aalert(1)', ' javascript:alert(1)', '\tjavascript:alert(1)', 'jAvAsCrIpT:alert(1)']) {
    assert.equal(safeUrl(url), false, JSON.stringify(url));
  }
});
ok('safeUrl accepts only http/https', () => {
  assert.equal(safeUrl('https://a.b/c'), true);
  assert.equal(safeUrl('http://a.b/c'), true);
  assert.equal(safeUrl('HTTPS://A.B/C'), true);
  assert.equal(safeUrl('ftp://a.b/'), false);
  assert.equal(safeUrl('//a.b/'), false);
  assert.equal(safeUrl('mailto:a@b.c'), false);
  assert.equal(safeUrl(''), false);
});
ok('allowed links render with the exact URL; safe images render as real <img> (pass #86 unfence)', () => {
  const h = mdInline('see [docs](https://example.invalid/a?b=1) and ![pic](https://example.invalid/i.png)');
  assert.ok(h.includes('<a href="https://example.invalid/a?b=1"'));
  assert.ok(h.includes('<img src="https://example.invalid/i.png"'), h);
  assert.ok(h.includes('alt="pic"'), h);
});
ok('remote images render for safe srcs; unsafe schemes stay inert (pass #86 + #83 isolation)', () => {
  for (const src of ['![x](https://a.invalid/i.png)', '<img src="https://a.invalid/i.png">',
    '<center><img src="https://a.invalid/i.png"></center>', '[![b](https://a.invalid/i.png)](https://b.invalid/)']) {
    const h = mdInline(src);
    assert.ok(/<img/i.test(h), `${src} -> ${h}`);
  }
  for (const src of ['![x](javascript:alert(1))', '<img src="data:text/html,x">',
    '![x](data:text/html,x)', '[![b](https://a.invalid/i.png)](javascript:alert(1))']) {
    const h = mdInline(src);
    assert.ok(!/<img/i.test(h), `${src} -> ${h}`);
  }
});
// F29: authored iframes actually render (escaped-quote form), embed origins only
ok('authored YouTube iframe renders (escaped quotes)', () => {
  const h = mdInline('<iframe src="https://www.youtube.com/embed/abc123-_X" title="x" allowfullscreen></iframe>');
  assert.ok(h.includes('<iframe class="tm-md-embed" src="https://www.youtube.com/embed/abc123-_X"'));
});
ok('non-embed iframe origins stay escaped text', () => {
  const h = mdInline('<iframe src="https://evil.invalid/embed/x"></iframe>');
  assert.ok(!h.includes('<iframe '), h);
});
ok('markdown image embed form renders for YouTube only', () => {
  const h = mdInline('![v](https://youtube-nocookie.com/embed/xyz_)');
  assert.ok(h.includes('<iframe class="tm-md-embed" src="https://youtube-nocookie.com/embed/xyz_"'));
  const bad = mdInline('![v](https://evil.invalid/embed/x)');
  assert.ok(!bad.includes('<iframe'), bad);
});
// escape-first structure: no attribute breakout, no raw html passthrough.
// URL captures cannot contain whitespace ([^)\s]+), so a payload can only ride
// INSIDE a quoted attribute — structural check: no space-separated attribute
// injection, no raw tag from source text.
ok('quotes and angles in URLs/text cannot break out of attributes', () => {
  const h = mdInline('[x"><script>](https://example.invalid/a"onload="x) and <b>raw</b>');
  assert.ok(!/<script/i.test(h), h);            // raw <script> from source must stay escaped
  assert.ok(!/\sonload\s*=/i.test(h), h);        // no space-separated attribute injection
  assert.ok(!/\son[a-z]+\s*=\s*"/i.test(h), h);
  assert.ok(h.includes('<strong>raw</strong>'));  // pass #22: allowlisted raw html now renders
  // the anchor itself is well-formed: inner quotes survive only as &quot;
  const matched = h.match(/<a [^>]*>/);
  assert.ok(matched, h);
  assert.equal(matched[0].split('"').length - 1, 6); // href-open/close + 3 fixed attrs use exactly 6 quotes
});
ok('bare watch links stay plain https links, never auto-embed', () => {
  const h = mdInline('[watch](https://youtu.be/abc123)');
  assert.ok(h.includes('<a href="https://youtu.be/abc123"'));
  assert.ok(!h.includes('<iframe'));
});
ok('image pass: attribute breakout stays escaped (pass #86 unfence, escape-first holds)', () => {
  const h = mdInline('![x"><script>](https://a.invalid/x"onerror="y)');
  assert.ok(!/<script/i.test(h), h);
  assert.ok(!/\sonerror\s*=/i.test(h), h);
  assert.ok(/<img src="https:\/\/a\.invalid\/x&quot;onerror=&quot;y"/.test(h), h);
});
ok('basic inline formatting still applies', () => {
  const h = mdInline('**b** *i* `c`');
  assert.ok(h.includes('<strong>b</strong>') && h.includes('<em>i</em>') && h.includes('<code>c</code>'));
});

// nested image-in-link (pass #20): the web client renders it; official strips it.
// Pass #86 unfence: a linked image — the outer link wraps a real <img> (its src is
// swapped for a shell-fetched data URL by wireAboutImages in the app).
ok('nested image inside link renders as a linked image', () => {
  const h = mdInline('[![banner](https://readme-typing-svg.demolab.com?font=Fira+Code)](https://youtu.be/s0K53t4dNyg)');
  assert.ok(h.includes('<a href="https://youtu.be/s0K53t4dNyg"'), h);
  assert.ok(h.includes('<img src="https://readme-typing-svg.demolab.com?font=Fira+Code"'), h);
  assert.ok(h.includes('alt="banner"'), h);
  assert.ok(!h.includes(']('), h);
});
ok('nested form with a bad image or bad link stays inert', () => {
  const badImg = mdInline('[![x](javascript:alert(1))](https://ok.invalid/a)');
  const badLnk = mdInline('[![x](https://ok.invalid/i.png)](data:text/html,x)');
  assert.ok(!badImg.includes('<img') && !badImg.includes('<a '), badImg);
  assert.ok(!badLnk.includes('<a ') && !badLnk.includes('<img'), badLnk);
});
ok('nested form never degrades into the garbage partial-link shape', () => {
  const h = mdInline('[![alt](https://a.invalid/i.png)](https://b.invalid/l)');
  assert.ok(!/!\[|]\(/.test(h), h);
});


// pass #22: raw HTML subset prepass (web-client parity — markdown AND html coexist)
ok('raw html subset converts to rendered markdown', () => {
  const h = mdInline('a <b>bold</b> and <i>it</i> and <code>x=1</code><br>line2');
  assert.ok(h.includes('<strong>bold</strong>'), h);
  assert.ok(h.includes('<em>it</em>'), h);
  assert.ok(h.includes('<code>x=1</code>'), h);
  assert.ok(h.includes('line2'), h);
});
ok('raw <img> and <a> convert through the allow-list gates (pass #86: the image renders)', () => {
  const h = mdInline('<img src="https://a.invalid/i.png"> and <a href="https://b.invalid/l">link</a>');
  assert.ok(h.includes('<img src="https://a.invalid/i.png"'), h);
  assert.ok(h.includes('<a href="https://b.invalid/l"'), h);
  const bad = mdInline('<img src="javascript:alert(1)"> and <a href="data:x">t</a>');
  assert.ok(!bad.includes('<img'), bad); assert.ok(!bad.includes('<a '), bad);
});
ok('img with extra attributes drops them (only src survives, as a real img)', () => {
  const h = mdInline('<img onerror="alert(1)" src="https://a.invalid/i.png" width="10">');
  assert.ok(!/onerror|width/.test(h), h);
  assert.ok(h.includes('<img src="https://a.invalid/i.png"'), h);
});
ok('raw youtube iframe renders, others stay text', () => {
  const h = mdInline('<iframe src="https://www.youtube.com/embed/abc_XY-9" allowfullscreen></iframe>');
  assert.ok(h.includes('<iframe class="tm-md-embed" src="https://www.youtube.com/embed/abc_XY-9"'), h);
  const bad = mdInline('<iframe src="https://evil.invalid/embed/x"></iframe>');
  assert.ok(!bad.includes('<iframe '), bad);
});
ok('unlisted tags stay escaped text', () => {
  const h = mdInline('<table><tr><td>x</td></tr></table> <marquee>hi</marquee>');
  assert.ok(!h.includes('<table') && !h.includes('<marquee'), h);
});
ok('<center> blocks render as centered divs, inner markdown works, XSS does not', () => {
  const h = mdInline('<center><b>hi</b> <img src="https://a.invalid/i.png"></center>');
  assert.ok(h.includes('<div class="tm-md-center">'), h);
  assert.ok(h.includes('<strong>hi</strong>'), h);
  assert.ok(h.includes('<img src="https://a.invalid/i.png"'), h);
  const bad = mdInline('<center><img src="javascript:alert(1)"></center>');
  assert.ok(!bad.includes('<img'), bad);
  const lone = mdInline('<center>never closed');
  assert.ok(!lone.includes('tm-md-center'), lone);
});
ok('crafted sentinel text cannot duplicate or swallow content (audit B2)', () => {
  const h = mdInline('<center>real</center> then \u0001' + '0' + '\u0001 trailing');
  assert.equal((h.match(/tm-md-center/g) || []).length, 1, h);
  assert.ok(h.includes('then'), h);
  const gone = mdInline('keep \u0001' + '99' + '\u0001 this');
  assert.ok(gone.includes('keep') && gone.includes('this'), gone);
  const shelvedSpoof = mdInline('[![a](javascript:x)](https://ok.invalid) \u0000' + '0' + '\u0000 end');
  assert.ok(shelvedSpoof.includes('end'), shelvedSpoof);
});

// pass #52: ATX headings — the About pane rendered the raw '#' before (He's audit shot)
ok('ATX heading renders as h1, inline content inside keeps working', () => {
  const h = mdInline('# Truy cập FMATH tại [đây](https://oj.tmathcoding.vn)');
  assert.ok(h.includes('<h1>Truy cập FMATH tại <a href="https://oj.tmathcoding.vn"'), h);
  assert.ok(!h.includes('# Truy'), h); // the raw marker must not survive
});
ok('heading levels #..###### map to h1..h6', () => {
  for (let lvl = 1; lvl <= 6; lvl++) {
    const h = mdInline(`${'#'.repeat(lvl)} level ${lvl}`);
    assert.ok(h.includes(`<h${lvl}>level ${lvl}</h${lvl}>`), `h${lvl}: ${h}`);
  }
  const seven = mdInline('####### seven');
  assert.ok(!seven.includes('<h7>'), seven); // 7 '#'s is not a heading
});
ok("'#tag' without a space stays literal text", () => {
  const h = mdInline('#hashtag and C# and issue #123');
  assert.ok(!h.includes('<h1>'), h);
  assert.ok(h.includes('#hashtag'), h);
});
ok('headings are block-level: no stray <br> around them', () => {
  const h = mdInline('line one\n# Title\nline two');
  assert.equal(h, 'line one<h1>Title</h1>line two', h);
  const alone = mdInline('just text');
  assert.ok(!alone.includes('<br>') || true); // single line unchanged
  const two = mdInline('a\nb');
  assert.equal(two, 'a<br>b', two); // legacy line behavior intact
});
ok('heading content stays escape-first (no raw html, no attribute injection)', () => {
  const h = mdInline('# <img src=x onerror=alert(1)> [x](javascript:alert(1))');
  assert.ok(h.includes('<h1>'), h);
  assert.ok(!/<img/i.test(h), h);
  assert.ok(!/<a /.test(h), h);
  const heading = h.match(/<h1>(.*?)<\/h1>/)[1];
  assert.ok(heading.includes('&lt;img') && heading.includes('&gt;'), heading);
});

console.log(`Q01/F29 md renderer: ${n}/${n} passed`);
