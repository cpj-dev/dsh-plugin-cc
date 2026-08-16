/**
 * SemVer 2.0.0 precedence, for the release-version guard in CI.
 *
 * Repo tooling, not shipped plugin code — nothing under `plugins/` imports it.
 * Zero dependencies like everything else here.
 *
 * The rule that matters and is easy to get wrong (§11): the numeric triple
 * decides first, and when it ties, a version WITHOUT a prerelease outranks one
 * with it. Dropping the suffix before comparing makes `1.2.0-rc.1` and `1.2.0`
 * look identical, which rejects the most ordinary release bump there is.
 *
 * Usage as a CLI: `node scripts/semver.mjs gt <base> <head>` exits 0 when head
 * has higher precedence than base, 1 otherwise (or on an unparseable version).
 */

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** @returns `{ major, minor, patch, prerelease }`, or null when unparseable. */
export function parseSemver(value) {
  const match = SEMVER.exec(String(value ?? "").trim());
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    // Build metadata is deliberately dropped: §10 says it is ignored for precedence.
    prerelease: match[4] === undefined ? [] : match[4].split(".")
  };
}

function isNumericIdentifier(identifier) {
  return /^\d+$/.test(identifier);
}

/** SemVer §11.4 precedence over dot-separated prerelease identifiers. */
function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) {
    return 0;
  }
  // A version with no prerelease outranks one that has any.
  if (a.length === 0) {
    return 1;
  }
  if (b.length === 0) {
    return -1;
  }
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === right) {
      continue;
    }
    const leftNumeric = isNumericIdentifier(left);
    const rightNumeric = isNumericIdentifier(right);
    if (leftNumeric && rightNumeric) {
      return Number(left) < Number(right) ? -1 : 1;
    }
    // Numeric identifiers always rank lower than alphanumeric ones.
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }
    return left < right ? -1 : 1;
  }
  // A longer identifier list wins when every shared field is equal.
  if (a.length === b.length) {
    return 0;
  }
  return a.length < b.length ? -1 : 1;
}

/**
 * @returns -1, 0, or 1 by SemVer precedence.
 * @throws {TypeError} when either side is not a valid version.
 */
export function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a) {
    throw new TypeError(`not a semver version: ${JSON.stringify(left)}`);
  }
  if (!b) {
    throw new TypeError(`not a semver version: ${JSON.stringify(right)}`);
  }
  for (const field of ["major", "minor", "patch"]) {
    if (a[field] !== b[field]) {
      return a[field] < b[field] ? -1 : 1;
    }
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

/** True when `head` ships after `base`. */
export function isVersionIncrease(base, head) {
  return compareSemver(head, base) > 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  const [command, base, head] = process.argv.slice(2);
  if (command !== "gt" || base === undefined || head === undefined) {
    console.error("usage: node scripts/semver.mjs gt <base-version> <head-version>");
    process.exit(2);
  }
  try {
    if (isVersionIncrease(base, head)) {
      process.exit(0);
    }
    console.error(`::error::Version ${head} does not sort above the base version ${base}.`);
  } catch (error) {
    console.error(`::error::${error.message}`);
  }
  process.exit(1);
}
