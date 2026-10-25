// tools/reveal-jsdom.mjs — mechanical check: does the built CSS switch the reveal glyph
// when aria-pressed flips? (jsdom selector + computed content check)
import fs from "node:fs";
import { JSDOM } from "jsdom";

const cssName = fs.readdirSync("dist/assets").filter(f => f.startsWith("index-") && f.endsWith(".css"))
  .map(f => ({ f, len: fs.statSync(`dist/assets/${f}`).size }))
  .sort((a, b) => b.len - a.len)[0].f;
console.log("css bundle:", cssName);
const css = fs.readFileSync(`dist/assets/${cssName}`, "utf8");

const dom = new JSDOM(`<div id="app"><span class="tm-pw-wrap"><button class="tm-reveal" aria-pressed="false"></button></span></div>`);
const { window } = dom;
const style = window.document.createElement("style");
style.textContent = css;
window.document.head.appendChild(style);

const b = window.document.querySelector(".tm-reveal");
const cp = () => {
  const c = window.getComputedStyle(b, "::before").content;
  if (!c || c.length < 3) return String(c);
  return "U+" + c.codePointAt(1).toString(16).toUpperCase();
};
console.log("hidden state  (pressed=false):", cp());
b.setAttribute("aria-pressed", "true");
console.log("visible state (pressed=true) :", cp());
// does the button inherit the icon font? (blanket check)
const fam = window.getComputedStyle(b, "::before").fontFamily;
console.log("before font-family:", fam.slice(0, 60));
