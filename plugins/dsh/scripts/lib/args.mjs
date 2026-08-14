/**
 * Minimal argv parsing for the bridge subcommands.
 *
 * `parseArgs` understands `--flag`, `--key value`, `--key=value`, and short
 * aliases; everything else is a positional. Unknown options are collected
 * (never thrown) so slash-command markdown can forward raw user text safely.
 */

/**
 * Split one raw argument string the way a POSIX shell would tokenize it,
 * honoring single/double quotes. Claude Code hands `$ARGUMENTS` to the bridge
 * as a single string, so `review "$ARGUMENTS"` arrives as one argv entry.
 */
export function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let quote = null;
  let hasToken = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken || current) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken || current) {
    tokens.push(current);
  }
  return tokens;
}

/**
 * Parse argv into `{ options, positionals, unknown }`.
 *
 * config:
 * - valueOptions: names that consume the next token (or `=value`)
 * - booleanOptions: names that are flags
 * - aliasMap: short → long name mapping
 * - unknownMode: "collect" (default) or "positional"
 */
export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const unknownMode = config.unknownMode ?? "collect";

  const options = {};
  const positionals = [];
  const unknown = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    let name = token.replace(/^--?/, "");
    let inlineValue = null;
    const eq = name.indexOf("=");
    if (eq !== -1) {
      inlineValue = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    if (aliasMap[name]) {
      name = aliasMap[name];
    }

    if (booleanOptions.has(name)) {
      options[name] = true;
      continue;
    }
    if (valueOptions.has(name)) {
      if (inlineValue !== null) {
        options[name] = inlineValue;
      } else {
        options[name] = argv[i + 1];
        i += 1;
      }
      continue;
    }
    if (unknownMode === "positional") {
      positionals.push(token);
    } else {
      unknown.push(token);
    }
  }

  return { options, positionals, unknown };
}
