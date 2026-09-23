import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mdContent = readFileSync(resolve(root, "DESIGN.md"), "utf8");

const match = mdContent.match(/^---\n([\s\S]+?)\n---/);
const design = yaml.load(match[1]);

function resolveReferences(value, data) {
  if (typeof value !== "string") return value;
  return value.replace(/{([a-zA-Z0-9.-]+)}/g, (m, path) => {
    const parts = path.split(".");
    if (parts[0] === "colors") return `var(--color-${parts[1]})`;
    if (parts[0] === "rounded") return `var(--rounded-${parts[1]})`;
    if (parts[0] === "spacing") return `var(--spacing-${parts[1]})`;
    return m;
  });
}

function getTypographyRules(typoName, data) {
  const t = data.typography[typoName];
  if (!t) return "";
  let css = "";
  if (t.fontSize) css += `  font-size: var(--fs-${typoName});\n`;
  if (t.fontWeight) css += `  font-weight: var(--fw-${typoName});\n`;
  if (t.lineHeight) css += `  line-height: var(--lh-${typoName});\n`;
  if (t.letterSpacing) css += `  letter-spacing: var(--ls-${typoName});\n`;
  if (t.fontFamily) css += `  font-family: var(--ff-${typoName});\n`;
  return css;
}

let css = `/* AUTO-GENERATED from DESIGN.md components */\n\n`;

for (const [compName, props] of Object.entries(design.components || {})) {
  css += `.${compName} {\n`;
  
  if (props.backgroundColor) css += `  background-color: ${resolveReferences(props.backgroundColor, design)};\n`;
  if (props.textColor) css += `  color: ${resolveReferences(props.textColor, design)};\n`;
  if (props.border) css += `  border: ${resolveReferences(props.border, design)};\n`;
  if (props.padding) css += `  padding: ${resolveReferences(props.padding, design)};\n`;
  if (props.rounded) css += `  border-radius: ${resolveReferences(props.rounded, design)};\n`;
  if (props.height) css += `  height: ${props.height};\n`;
  
  if (props.typography) {
    const tMatch = props.typography.match(/{typography\.([a-zA-Z0-9.-]+)}/);
    if (tMatch) {
      css += getTypographyRules(tMatch[1], design);
    }
  }

  css += `}\n\n`;
}

// Add some global base rules for typography classes
css += `/* Typography Classes */\n`;
for (const [key] of Object.entries(design.typography || {})) {
  css += `.t-${key} {\n`;
  css += getTypographyRules(key, design);
  css += `}\n\n`;
}

writeFileSync(resolve(root, "public/styles/new-ui.css"), css);
console.log("Wrote public/styles/new-ui.css");
