// delcc-app/src/lib/scheme.ts
// Presets = layout personas (He's doctrine): "original" is His sketch persona,
// "tmath" is the official client look, reconstructed from the carved 1.0.9
// stylesheet (v1.0.9-extract/assets__index-Sy2kLOLY.css — :root and :root.dark
// blocks lifted verbatim). A scheme is a flat token map applied as CSS custom
// properties on :root; dark mode comes from the same harvest, not invented.
// baseplate/wip stay unthemed — the default delcc palette keeps its own vars.

export type SchemeMode = "light" | "dark";

export interface Scheme {
  id: string;
  persona: string; // "original" | "tmath" for now; more personas later
  mode: SchemeMode;
  tokens: Record<string, string>;
}

// ---- tmath persona, straight from the official client's stylesheet ----

const TMATH_LIGHT: Record<string, string> = {
  "--tmath-secondary": "#edf2fa",
  "--tmath-secondary-foreground": "#29415d",
  "--tmath-muted": "#f1f5f9",
  "--tmath-muted-foreground": "#64748b",
  "--tmath-accent": "#eaf2ff",
  "--tmath-accent-foreground": "#155fe8",
  "--tmath-destructive": "#b42336",
  "--tmath-border": "#dfe7f1",
  "--tmath-input": "#d4deec",
  "--tmath-ring": "#7aa8f8",
  "--tmath-selected-background": "#f1f6ff",
  "--tmath-selected-border": "#bdd1f6",
  "--tmath-background": "#f5f7fb",
  "--tmath-foreground": "#142b43",
  "--tmath-card": "white",
  "--tmath-primary": "#155fe8",
  "--tmath-blue": "#155fe8",
  "--tmath-line": "#e4eaf2",
  "--tmath-radius-xs": "0.125rem",
  "--tmath-radius-md": "0.5rem",
  "--tmath-radius-xl": "0.75rem",
  "--tmath-font":
    '"Noto Sans Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  "--tmath-font-mono":
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
};

const TMATH_DARK: Record<string, string> = {
  "--tmath-secondary": "#243247",
  "--tmath-secondary-foreground": "#d5e2f5",
  "--tmath-muted": "#202e43",
  "--tmath-muted-foreground": "#a6b5ca",
  "--tmath-accent": "#223c60",
  "--tmath-accent-foreground": "#9ec5ff",
  "--tmath-destructive": "#fb7185",
  "--tmath-border": "#34445c",
  "--tmath-input": "#42546e",
  "--tmath-ring": "#7aa8f8",
  "--tmath-selected-background": "#223c60",
  "--tmath-selected-border": "#547db1",
  "--tmath-background": "#0f172a",
  "--tmath-foreground": "#e2e8f0",
  "--tmath-card": "#172235",
  "--tmath-primary": "#3979ed",
  "--tmath-blue": "#155fe8",
  "--tmath-line": "#34445c",
  "--tmath-radius-xs": TMATH_LIGHT["--tmath-radius-xs"],
  "--tmath-radius-md": TMATH_LIGHT["--tmath-radius-md"],
  "--tmath-radius-xl": TMATH_LIGHT["--tmath-radius-xl"],
  "--tmath-font": TMATH_LIGHT["--tmath-font"],
  "--tmath-font-mono": TMATH_LIGHT["--tmath-font-mono"],
};

// original persona: He's sketch family. JetBrains Mono for code per design note;
// shell colors pending His sketch pass — neutral starting point, adjusted later.
const ORIGINAL_LIGHT: Record<string, string> = {
  "--tmath-background": "#ffffff",
  "--tmath-foreground": "#000000",
  "--tmath-accent": "#7f7f7f",
  "--tmath-accent-foreground": "#000000",
  "--tmath-border": "#000000",
  "--tmath-card": "#ffffff",
  "--tmath-font": 'system-ui, "Segoe UI", sans-serif',
  "--tmath-font-mono": '"JetBrains Mono", ui-monospace, monospace',
};

const ORIGINAL_DARK: Record<string, string> = {
  ...ORIGINAL_LIGHT,
  "--tmath-background": "#000000",
  "--tmath-foreground": "#ffffff",
  "--tmath-border": "#ffffff",
  "--tmath-card": "#000000",
  "--tmath-accent-foreground": "#ffffff",
};

export const SCHEMES: Record<string, Scheme> = {
  "original-light": { id: "original-light", persona: "original", mode: "light", tokens: ORIGINAL_LIGHT },
  "original-dark": { id: "original-dark", persona: "original", mode: "dark", tokens: ORIGINAL_DARK },
  "tmath-light": { id: "tmath-light", persona: "tmath", mode: "light", tokens: TMATH_LIGHT },
  "tmath-dark": { id: "tmath-dark", persona: "tmath", mode: "dark", tokens: TMATH_DARK },
};

export function schemeFor(persona: string, mode: SchemeMode): Scheme {
  const id = `${persona}-${mode}`;
  return SCHEMES[id] ?? SCHEMES[`tmath-${mode}`];
}

// Applies the scheme by injecting a <style> on :root — leaves baseplate/wip
// untouched (their palette vars don't collide: tmath tokens are namespaced --tmath-*).
export function applyScheme(persona: string, mode: SchemeMode): void {
  const scheme = schemeFor(persona, mode);
  let el = document.getElementById("delcc-scheme") as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = "delcc-scheme";
    document.head.appendChild(el);
  }
  const body = Object.entries(scheme.tokens)
    .map(([k, v]) => `${k}:${v};`)
    .join("");
  el.textContent = `:root{${body}}`;
  // official convention: dark state is the class on :root, not a re-token set
  document.documentElement.classList.toggle("dark", scheme.mode === "dark");
}

export const PERSONAS = ["original", "tmath"] as const;
export type Persona = (typeof PERSONAS)[number];

export const DEFAULT_PERSONA: Persona = "tmath"; // kira's shell until His sketches are built out
