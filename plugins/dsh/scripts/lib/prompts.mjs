/** Prompt-template loading and `{{NAME}}` interpolation. */

import fs from "node:fs";
import path from "node:path";

/** Load `prompts/<name>.md` from the plugin root. Throws when missing. */
export function loadPromptTemplate(rootDir, name) {
  const file = path.join(rootDir, "prompts", `${name}.md`);
  return fs.readFileSync(file, "utf8");
}

/** Replace each `{{KEY}}` with vars[KEY]; unknown keys become "". */
export function interpolateTemplate(template, vars = {}) {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key) => {
    const value = vars[key];
    return value === undefined || value === null ? "" : String(value);
  });
}
