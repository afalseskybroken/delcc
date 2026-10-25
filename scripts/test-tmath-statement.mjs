// Local browser regression checks; no API credentials or external requests.
// Run: node scripts/test-tmath-statement.mjs
// Set PLAYWRIGHT_MODULE to an installed Playwright directory when not in node_modules.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const server = await createServer({ server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
server.middlewares.use("/__tmath_statement_test__", (_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end('<!doctype html><html><head><meta charset="utf-8"></head><body><main id="host"></main></body></html>');
});
await server.listen();
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    return url.hostname === "127.0.0.1" ? route.continue() : route.abort();
  });
  await page.goto(`${server.resolvedUrls.local[0]}__tmath_statement_test__`);
  await page.evaluate(async () => {
    window.statement = await import("/src/tmath/statement.ts");
    window.locale = await import("/src/i18n/index.ts");
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async text => { window.copiedText = text; } } });
  });
  const render = (source, options = {}) => page.evaluate(({ source, options }) => {
    window.rendered = window.statement.renderStatement(document.getElementById("host"), source, options);
    return window.rendered.samples;
  }, { source, options });

  await render("# Statement\n\n**Bold** and \\(a_i + b_i\\) before $$c_i^2$$ after $z_1$.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```cpp\ncout << \\\"$x$\\\";\n```");
  assert.equal(await page.locator("h1").textContent(), "Statement");
  assert.equal(await page.locator("strong").textContent(), "Bold");
  assert.equal(await page.locator(".katex").count(), 3, "mixed inline/display math survives Markdown");
  assert.equal(await page.locator(".tm-statement-table table").count(), 1);
  assert.equal(await page.locator("pre .katex").count(), 0, "code is never typeset");
  await page.locator(".tm-code-copy-button").click();
  assert.match(await page.evaluate(() => window.copiedText), /\$x\$/);
  assert.equal(await page.locator(".tm-code-copy-button").textContent(), "Copied!");

  const row = (index, input, output) => `<div class="tmath-sample" data-sample-index="${index}"><div class="tmath-sample-input"><pre><code>${input}</code></pre></div><div class="tmath-sample-output"><pre><code>${output}</code></pre></div></div>`;
  const samples = `<div class="tmath-samples" data-tmath-component="samples" data-tmath-version="1">${row(0, "2 3\n", "5\n")}${row(1, " 7 8\n", "15\n")}</div>`;
  assert.deepEqual(await render(samples), [{ input: "2 3\n", output: "5\n" }, { input: " 7 8\n", output: "15\n" }]);
  assert.equal(await page.getByRole("tab").count(), 2);
  assert.equal(await page.getByRole("tabpanel").count(), 1, "only active sample is visible");
  await page.getByRole("tab").first().focus();
  await page.keyboard.press("End");
  assert.equal(await page.getByRole("tab").last().getAttribute("aria-selected"), "true");
  await page.keyboard.press("Home");
  assert.equal(await page.getByRole("tab").first().getAttribute("aria-selected"), "true");
  await page.getByRole("tab").last().click();
  await page.getByRole("tabpanel").locator(".tm-code-copy-button").first().click();
  assert.equal(await page.evaluate(() => window.copiedText), " 7 8\n");
  assert.deepEqual(await render(samples.replace('data-tmath-version="1"', 'data-tmath-version="2"')), []);
  assert.equal(await page.getByRole("tab").count(), 0);
  assert.deepEqual(await render(samples.replace('data-sample-index="1"', 'data-sample-index="7"')), []);

  await render('<script>window.attacked=true</script><img src="https://invalid.example/x" onerror="window.attacked=true"><a href="javascript:alert(1)">link</a><div onclick="alert(1)" style="display:none" class="rogue">Text</div> $\\href{javascript:alert(1)}{x}$');
  assert.equal(await page.locator("#host script, #host img, #host a, #host [onclick], #host [style], #host .rogue").count(), 0);
  assert.equal(await page.evaluate(() => !!window.attacked), false);

  await render("\\(a_i < b_i\\) and $$x^2$$", { rawMath: true });
  assert.equal(await page.locator(".katex").count(), 0);
  assert.equal(await page.locator(".tm-formula").first().textContent(), "\\(a_i < b_i\\)");
  await render("<p>\\(a &lt; b\\)</p>");
  assert.equal(await page.locator(".katex").count(), 1, "HTML-encoded formula is decoded");
  assert.equal(await page.locator(".katex-error").count(), 0);
  await render("`$code$` and <code>\\(raw\\)</code> and $math$");
  assert.equal(await page.locator(".katex").count(), 1);
  assert.equal(await page.locator("code").first().textContent(), "$code$");
  await render("x ".repeat(100_001) + "\\(a+b\\)");
  assert.equal(await page.locator(".katex").count(), 0);
  assert.equal(await page.locator(".tm-statement-notice").count(), 1);

  await page.evaluate(() => window.locale.setLocale("vi-VN"));
  await render(samples);
  assert.equal(await page.getByRole("tab").first().textContent(), "Ví dụ 1");
  await page.evaluate(() => {
    const old = window.rendered;
    window.rendered = window.statement.renderStatement(document.getElementById("host"), "New render");
    old.dispose();
  });
  assert.equal(await page.locator("#host").textContent(), "New render\n", "old cleanup cannot remove new content");
  await page.evaluate(() => { window.rendered.dispose(); window.rendered.dispose(); });
  assert.equal(await page.locator("#host").textContent(), "");
  console.log("TMATH statement: Markdown, math, sanitization, samples, keyboard, copy, locale, limits and cleanup passed.");
} finally {
  await browser?.close();
  await server.close();
}
