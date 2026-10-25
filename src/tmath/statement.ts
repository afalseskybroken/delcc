import DOMPurify from "dompurify";
import katex from "katex";
import "katex/dist/katex.min.css";
// Monaco 0.47.0 already ships this MIT-licensed Markdown parser. Keep the
// dependency local and pinned with Monaco; its internal module has no .d.ts.
// @ts-expect-error Monaco's bundled marked module has no declaration file.
import { parse } from "monaco-editor/esm/vs/base/common/marked/marked.js";
import { t } from "../i18n";
import "./statement.css";

export interface StatementSample { input: string; output: string }
export interface StatementOptions { rawMath?: boolean }
export interface StatementResult { samples: StatementSample[]; dispose: () => void }

interface Formula { raw: string; tex: string; display: boolean }
const MATH_SIZE_LIMIT = 200_000;
const MATH_COUNT_LIMIT = 500;
const MATH_EXPRESSION_LIMIT = 8_000;
const MATH_LOOKAHEAD_LIMIT = 32_000;
const SAMPLE_CLASSES = new Set([
  "tmath-samples", "tmath-sample", "tmath-sample-input", "tmath-sample-output",
]);
const activeRenders = new WeakMap<HTMLElement, () => void>();
let sequence = 0;

function escapedAt(source: string, offset: number): boolean {
  let backslashes = 0;
  while (offset > 0 && source[--offset] === "\\") backslashes++;
  return backslashes % 2 === 1;
}

/** Preserve TeX before Markdown can consume backslashes, underscores or '<'.
 * Code fences, code spans, raw HTML code and HTML attributes are kept verbatim.
 * Placeholders contain no Markdown syntax and are restored only as DOM nodes.
 */
function protectMath(source: string): { markdown: string; prefix: string; formulas: Formula[] } {
  let prefix = `TMATHMATH${++sequence}TOKEN`;
  while (source.includes(prefix)) prefix += "X";
  const formulas: Formula[] = [];
  const chunks: string[] = [];
  const token = /^[ \t]{0,3}(?:`{3,}|~{3,})[^\n]*(?:\n|$)|<(?:pre|code)\b[^>]*>|<!--[\s\S]*?-->|<\/?[A-Za-z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>|`+|\$\$|\\\[|\\\(|\$/gim;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = token.exec(source))) {
    const start = match.index;
    const value = match[0];
    chunks.push(source.slice(cursor, start));
    let end = token.lastIndex;
    if (/^[ \t]{0,3}(?:`{3,}|~{3,})/.test(value) && (start === 0 || source[start - 1] === "\n")) {
      const fence = value.trimStart().match(/^(`+|~+)/)![0];
      const close = new RegExp(`^[ \\t]{0,3}${fence[0]}{${fence.length},}[ \\t]*(?:\\n|$)`, "gm");
      close.lastIndex = end;
      const closing = close.exec(source);
      end = closing ? close.lastIndex : source.length;
    } else if (/^<(?:pre|code)\b/i.test(value)) {
      const name = value.match(/^<(pre|code)/i)![1];
      const close = new RegExp(`</${name}\\s*>`, "gi");
      close.lastIndex = end;
      const closing = close.exec(source);
      end = closing ? close.lastIndex : source.length;
    } else if (value[0] === "`") {
      const close = new RegExp(`(?<!\x60)\x60{${value.length}}(?!\x60)`, "g");
      close.lastIndex = end;
      const closing = close.exec(source);
      if (closing) end = close.lastIndex;
    } else if (value[0] !== "<" && !escapedAt(source, start)) {
      const right = value === "\\[" ? "\\]" : value === "\\(" ? "\\)" : value;
      const searchEnd = Math.min(source.length, end + MATH_LOOKAHEAD_LIMIT);
      let depth = 0;
      let closing = -1;
      for (let i = end; i < searchEnd; i++) {
        if (depth <= 0 && source.startsWith(right, i) && !escapedAt(source, i)) {
          closing = i;
          break;
        }
        if (source[i] === "\\") i++;
        else if (source[i] === "{") depth++;
        else if (source[i] === "}") depth--;
      }
      if (closing !== -1) {
        end = closing + right.length;
        const index = formulas.push({
          raw: source.slice(start, end),
          tex: source.slice(start + value.length, closing),
          display: value === "$$" || value === "\\[",
        }) - 1;
        chunks.push(`${prefix}${index}END`);
        cursor = end;
        token.lastIndex = end;
        continue;
      }
    }
    chunks.push(source.slice(start, end));
    cursor = end;
    token.lastIndex = end;
  }
  chunks.push(source.slice(cursor));
  return { markdown: chunks.join(""), prefix, formulas };
}

/** TMATH samples v1 is deliberately strict: do not reinterpret arbitrary HTML
 * as executable UI or feed malformed server data into local test cases.
 */
function readSamples(component: HTMLElement): StatementSample[] | null {
  if (component.dataset.tmathVersion !== "1" || !component.children.length) return null;
  const samples: StatementSample[] = [];
  for (const [index, row] of Array.from(component.children).entries()) {
    if (!row.classList.contains("tmath-sample") || (row as HTMLElement).dataset.sampleIndex !== String(index)
      || row.children.length !== 2
      || !row.children[0].matches(".tmath-sample-input")
      || !row.children[1].matches(".tmath-sample-output")) return null;
    const input = row.children[0].querySelector(":scope > pre > code");
    const output = row.children[1].querySelector(":scope > pre > code");
    if (!input || !output) return null;
    samples.push({ input: input.textContent ?? "", output: output.textContent ?? "" });
  }
  return samples;
}

export function renderStatement(host: HTMLElement, source: string, options: StatementOptions = {}): StatementResult {
  activeRenders.get(host)?.();
  host.classList.add("tm-statement");
  const protectedMath = protectMath(source);
  const parseMarkdown = parse as (text: string, options: Record<string, unknown>) => string;
  const html = parseMarkdown(protectedMath.markdown, {
    gfm: true, breaks: false, headerIds: false, mangle: false,
  });
  // Same content boundary as the official client: no scripts, event handlers,
  // embedded frames, styles, URL attributes or remote image loading.
  host.innerHTML = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ["p", "br", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "b", "i", "s", "del", "hr", "ul", "ol", "li", "pre", "code", "table", "thead", "tbody", "tr", "td", "th", "blockquote", "sub", "sup", "span", "div"],
    ALLOWED_ATTR: ["class", "data-tmath-component", "data-tmath-version", "data-sample-index"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
  for (const element of host.querySelectorAll<HTMLElement>("[class]")) {
    const classes = Array.from(element.classList).filter(name => SAMPLE_CLASSES.has(name));
    if (classes.length) element.className = classes.join(" ");
    else element.removeAttribute("class");
  }

  const cleanups: Array<() => void> = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const samples: StatementSample[] = [];
  let disposed = false;
  const on = <K extends keyof HTMLElementEventMap>(element: HTMLElement, event: K, listener: (event: HTMLElementEventMap[K]) => void) => {
    element.addEventListener(event, listener);
    cleanups.push(() => element.removeEventListener(event, listener));
  };

  for (const component of host.querySelectorAll<HTMLElement>('[data-tmath-component="samples"]')) {
    const parsed = readSamples(component);
    if (!parsed) continue;
    samples.push(...parsed);
    component.classList.add("tm-samples");
    const rows = Array.from(component.children) as HTMLElement[];
    const tabs: HTMLButtonElement[] = [];
    const id = `tm-samples-${++sequence}`;
    const tablist = document.createElement("div");
    tablist.className = "tm-sample-tabs";
    tablist.setAttribute("role", "tablist");
    tablist.setAttribute("aria-label", t("problem.samples"));
    const select = (selected: number) => {
      rows.forEach((row, index) => {
        row.hidden = index !== selected;
        tabs[index]?.setAttribute("aria-selected", String(index === selected));
        if (tabs[index]) tabs[index].tabIndex = index === selected ? 0 : -1;
      });
    };
    rows.forEach((row, index) => {
      row.classList.add("tm-sample-panel");
      Array.from(row.children).forEach((cell, cellIndex) => {
        const label = document.createElement("div");
        label.className = "tm-sample-label";
        label.textContent = t(cellIndex === 0 ? "problem.input" : "problem.output");
        cell.prepend(label);
      });
      if (rows.length === 1) return;
      row.id = `${id}-panel-${index}`;
      row.setAttribute("role", "tabpanel");
      row.setAttribute("aria-labelledby", `${id}-tab-${index}`);
      row.tabIndex = 0;
      const button = document.createElement("button");
      button.type = "button";
      button.id = `${id}-tab-${index}`;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-controls", row.id);
      button.textContent = t("problem.sample", { number: index + 1 });
      on(button, "click", () => select(index));
      on(button, "keydown", event => {
        const selected = event.key === "ArrowRight" ? (index + 1) % rows.length
          : event.key === "ArrowLeft" ? (index + rows.length - 1) % rows.length
          : event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : -1;
        if (selected < 0) return;
        event.preventDefault();
        select(selected);
        tabs[selected].focus();
      });
      tabs.push(button);
      tablist.append(button);
    });
    if (tabs.length) { component.prepend(tablist); select(0); }
  }

  const limited = source.length > MATH_SIZE_LIMIT || protectedMath.formulas.length > MATH_COUNT_LIMIT;
  const rawMath = options.rawMath || limited;
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  // Official statements arrive as HTML, so TeX may contain &lt; or &#92;.
  // A detached textarea decodes character references as text, never as markup.
  const decoder = document.createElement("textarea");
  const decodeEntities = (value: string) => { decoder.innerHTML = value; return decoder.value; };
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.textContent?.includes(protectedMath.prefix)) textNodes.push(node as Text);
  }
  for (const text of textNodes) {
    const value = text.data;
    const fragment = document.createDocumentFragment();
    const pattern = new RegExp(`${protectedMath.prefix}(\\d+)END`, "g");
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(value))) {
      fragment.append(value.slice(cursor, match.index));
      const formula = protectedMath.formulas[Number(match[1])];
      if (!formula) { fragment.append(match[0]); cursor = pattern.lastIndex; continue; }
      const raw = decodeEntities(formula.raw);
      const tex = decodeEntities(formula.tex);
      const span = document.createElement("span");
      span.className = `tm-formula${formula.display ? " tm-formula-display" : ""}`;
      span.title = raw;
      span.textContent = raw;
      if (!rawMath && formula.tex.length <= MATH_EXPRESSION_LIMIT && !text.parentElement?.closest("pre, code")) {
        try {
          katex.render(tex, span, {
            displayMode: formula.display, trust: false, throwOnError: false,
            strict: (code: string) => code === "unknownSymbol" || code === "unicodeTextInMathMode" ? "ignore" : "error",
            maxExpand: 200, maxSize: 10, output: "html",
          });
        } catch { span.textContent = raw; }
      }
      fragment.append(span);
      cursor = pattern.lastIndex;
    }
    fragment.append(value.slice(cursor));
    text.replaceWith(fragment);
  }
  if (limited && !options.rawMath && protectedMath.formulas.length) {
    const notice = document.createElement("p");
    notice.className = "tm-statement-notice";
    notice.setAttribute("role", "status");
    notice.textContent = t("problem.mathLimited");
    host.prepend(notice);
  }

  for (const [index, table] of Array.from(host.querySelectorAll("table")).entries()) {
    const wrapper = document.createElement("div");
    wrapper.className = "tm-statement-table";
    wrapper.tabIndex = 0;
    wrapper.setAttribute("role", "region");
    wrapper.setAttribute("aria-label", t("problem.table", { number: index + 1 }));
    table.before(wrapper);
    wrapper.append(table);
  }
  for (const pre of host.querySelectorAll("pre")) {
    const wrapper = document.createElement("div");
    wrapper.className = "tm-code-copy-wrapper tm-code-copy";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tm-copy-button tm-code-copy-button";
    button.textContent = t("common.copy");
    button.setAttribute("aria-label", t("common.copy"));
    button.setAttribute("aria-live", "polite");
    on(button, "click", async () => {
      button.disabled = true;
      try {
        await navigator.clipboard.writeText(pre.textContent ?? "");
        if (disposed) return;
        button.textContent = t("common.copied");
      } catch {
        if (disposed) return;
        button.textContent = t("common.copyFailed");
      }
      const timer = setTimeout(() => {
        button.disabled = false;
        button.textContent = t("common.copy");
        timers.delete(timer);
      }, 1000);
      timers.add(timer);
    });
    pre.before(wrapper);
    wrapper.append(pre, button);
  }

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cleanups.forEach(cleanup => cleanup());
    timers.forEach(timer => clearTimeout(timer));
    timers.clear();
    if (activeRenders.get(host) === dispose) {
      activeRenders.delete(host);
      host.replaceChildren();
    }
  };
  activeRenders.set(host, dispose);
  return { samples, dispose };
}
