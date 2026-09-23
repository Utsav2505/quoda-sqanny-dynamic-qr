// Compiles DESIGN.md -> public/styles/tokens.css
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mdContent = readFileSync(resolve(root, "DESIGN.md"), "utf8");

// Extract YAML frontmatter
const match = mdContent.match(/^---\n([\s\S]+?)\n---/);
if (!match) {
  throw new Error("Could not find YAML frontmatter in DESIGN.md");
}

const design = yaml.load(match[1]);

// Resolve references like {colors.brand-green}
function resolveReferences(value, data) {
  if (typeof value !== "string") return value;
  return value.replace(/{([a-zA-Z0-9.-]+)}/g, (match, path) => {
    const parts = path.split(".");
    let current = data;
    for (const part of parts) {
      if (current[part] === undefined) return match;
      current = current[part];
    }
    return current;
  });
}

// Ensure all string values in the design object have references resolved
function recursivelyResolve(obj, rootData) {
  for (const key in obj) {
    if (typeof obj[key] === "string") {
      obj[key] = resolveReferences(obj[key], rootData);
    } else if (typeof obj[key] === "object" && obj[key] !== null) {
      recursivelyResolve(obj[key], rootData);
    }
  }
}
recursivelyResolve(design, design);

// Build CSS
let css = `/* AUTO-GENERATED from DESIGN.md by scripts/build-tokens.mjs. */\n\n:root {\n  color-scheme: light;\n\n`;

// Colors
css += `  /* Colors */\n`;
for (const [key, val] of Object.entries(design.colors || {})) {
  css += `  --color-${key}: ${val};\n`;
}

// Rounded
css += `\n  /* Rounded */\n`;
for (const [key, val] of Object.entries(design.rounded || {})) {
  css += `  --rounded-${key}: ${val};\n`;
}

// Spacing
css += `\n  /* Spacing */\n`;
for (const [key, val] of Object.entries(design.spacing || {})) {
  css += `  --spacing-${key}: ${val};\n`;
}

// Typography
css += `\n  /* Typography */\n`;
for (const [key, styles] of Object.entries(design.typography || {})) {
  if (styles.fontSize) css += `  --fs-${key}: ${styles.fontSize};\n`;
  if (styles.fontWeight) css += `  --fw-${key}: ${styles.fontWeight};\n`;
  if (styles.lineHeight) css += `  --lh-${key}: ${styles.lineHeight};\n`;
  if (styles.letterSpacing) css += `  --ls-${key}: ${styles.letterSpacing};\n`;
  if (styles.fontFamily) css += `  --ff-${key}: '${styles.fontFamily}', 'Inter', -apple-system, sans-serif;\n`;
}

// Add a default font family
css += `\n  --font-sans: 'Euclid Circular A', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;\n`;
css += `  --font-mono: 'Source Code Pro', 'SF Mono', Menlo, Consolas, monospace;\n`;

// Adding backward compatible or fixed tokens expected by some components if they are not yet rewritten,
// but we will rewrite everything, so these are just for basic layout logic if needed.
css += `\n  /* Legacy/Fallbacks */\n`;
css += `  --color-surface-0: var(--color-canvas);\n`;
css += `  --color-surface-1: var(--color-canvas);\n`;
css += `  --color-text-primary: var(--color-ink);\n`;
css += `  --color-text-secondary: var(--color-slate);\n`;
css += `  --color-accent: var(--color-brand-green);\n`;
css += `  --color-border: var(--color-hairline);\n`;

css += `}\n`;

const out = resolve(root, "public/styles/tokens.css");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, css);
console.log(`tokens.css written (${css.length} bytes) -> public/styles/tokens.css`);
