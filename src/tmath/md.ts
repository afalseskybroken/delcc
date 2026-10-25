// src/tmath/md.ts — About-pane Markdown subset (account "Giới thiệu" card).
// Doctrine: escape FIRST, then emit only our own tags. Q01: every href/src the
// renderer emits passes an explicit scheme allow-list — another user's About text
// can never plant javascript:/data:/file: navigation through here. Explicit video
// embeds stay narrow: authored <iframe> or ![](…), YouTube embed origins only
// (F29: the authored-iframe form matches the ESCAPED quote, so real embeds render).

// mirrors ui.ts esc — kept local so this module stays dependency-free (testable solo)
const esc = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// the only URL classes that may become href/src (Q01); embeds are stricter still
export const safeUrl = (u: string): boolean => /^https?:\/\//i.test(u);
export const embedOk = (u: string): boolean =>
  /^https:\/\/(www\.)?(youtube|youtube-nocookie)\.com\/embed\/[A-Za-z0-9_-]+/.test(u);

// Raw-HTML subset prepass (pass #22): the web client's About accepts inline HTML next to
// markdown; mdInline escapes first, so real tags must become markdown BEFORE escaping.
// Only exact allowlisted shapes rewrite — attributes beyond src/href are never captured,
// unmatched tags stay as text and get escaped by mdInline. URLs are still gated at emission.
const htmlPass = (s: string): string => s
  .replace(/<br\s*\/?>/gi, "\n")
  .replace(/<(?:b|strong)>([^<]*)<\/(?:b|strong)>/gi, "**$1**")
  .replace(/<(?:i|em)>([^<]*)<\/(?:i|em)>/gi, "*$1*")
  .replace(/<code>([^<]*)<\/code>/gi, "`$1`")
  .replace(/<img\s[^>]*?src=["']([^"']+)["'][^>]*>/gi, (m, src) => src && !/\s/.test(src) ? `![](${src})` : m)
  .replace(/<a\s[^>]*?href=["']([^"']+)["'][^>]*>([^<]*)<\/a>/gi, (m, href, txt) => href && !/\s/.test(href) ? `[${txt || href}](${href})` : m)
  .replace(/<iframe\s[^>]*?src=["']([^"']+)["'][^>]*>\s*<\/iframe>/gi, (m, src) =>
    embedOk(src) ? `<iframe src="${src}"></iframe>` : m);

export function mdInline(s: string): string {
  // sentinel control chars are ours alone (audit B2): strip any that arrive in raw
  // input so crafted \u0000N\u0000 / \u0001N\u0001 text can never ride the restore
  // passes — restored content is always re-rendered anyway (no injection; this
  // closes the duplication / silent-swallow confusion)
  const src = s.replace(/[\u0000\u0001]/g, "");
  // <center> blocks (audit pass #25, @tungtungtungsahur's profile): no markdown
  // equivalent, so the RAW inner text is shelved behind a \u0001 sentinel before
  // escaping and re-rendered through this same pipeline on restore — inline tags
  // inside the block keep working and nothing inside ever reaches the output raw.
  const centered: string[] = [];
  const preEscaped = htmlPass(src).replace(/<center>([\s\S]*?)<\/center>/gi,
    (_m, inner: string) => `\u0001${centered.push(inner) - 1}\u0001`);
  let h = esc(preEscaped);
  h = h.replace(/&lt;iframe\b[^&]*?src=&quot;([^&]*)&quot;[\s\S]*?&gt;\s*&lt;\/iframe&gt;/gi,
    (m, url) => embedOk(url) ? `<iframe class="tm-md-embed" src="${url}" title="embed" loading="lazy" allowfullscreen></iframe>` : m);
  // nested image inside a link FIRST (banner SVGs wrapped in a youtu.be link — what the
  // web client renders and the official client butchers). A construct that fails the
  // allow-list is consumed into a sentinel so the later plain passes cannot partially
  // render its inner image/link — the whole thing stays escaped text.
  const shelved: string[] = [];
  const shelve = (text: string) => `\u0000${shelved.push(text) - 1}\u0000`;
  h = h.replace(/\[!\[([^\]]*)\]\(([^)\s]+)\)\]\(([^)\s]+)\)/g, (m, alt, img, url) =>
    safeUrl(img) && safeUrl(url)
      ? `<a href="${url}" target="_blank" rel="noopener noreferrer"><img alt="${alt}" src="${img}" class="tm-md-img tm-md-img-link" loading="lazy"></a>`
      : shelve(m));
  h = h.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) =>
    embedOk(url) ? `<iframe class="tm-md-embed" src="${url}" title="${alt || "embed"}" loading="lazy" allowfullscreen></iframe>`
    : safeUrl(url) ? `<img alt="${alt}" src="${url}" class="tm-md-img" loading="lazy">` : m);
  h = h.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (m, txt, url) =>
    safeUrl(url) ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${txt || url}</a>` : m);
  h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>").replace(/`([^`]+)`/g, "<code>$1</code>");
  // restore shelved (rejected) constructs as the escaped text they already are
  h = h.replace(/\u0000(\d+)\u0000/g, (_m, i) => shelved[Number(i)] ?? "");
  // unwrap centered blocks: their payload already ran the full pipeline (nested
  // recursion terminates — every level consumes at least one <center> pair)
  h = h.replace(/\u0001(\d+)\u0001/g, (_m, i) => `<div class="tm-md-center">${mdInline(centered[Number(i)] ?? "")}</div>`);
  return h.replace(/\r?\n/g, "<br>");
}
