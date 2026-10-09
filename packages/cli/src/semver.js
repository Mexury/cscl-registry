// @ts-check
// The small part of semver this tool needs: exact versions, bumps and ^ ~ x ranges.

export const VERSION_RE = /^\d+\.\d+\.\d+$/

/** @typedef {"patch" | "minor" | "major"} Level */
export const LEVELS = /** @type {const} */ (["patch", "minor", "major"])

/** @param {string} version @returns {[number, number, number]} */
export function parse(version) {
  if (!VERSION_RE.test(version)) throw new Error(`Not a version: ${JSON.stringify(version)}`)
  const [major, minor, patch] = version.split(".").map(Number)
  return [major, minor, patch]
}

/** @param {string} a @param {string} b */
export function compare(a, b) {
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
  return 0
}

/** @param {string} version */
export function majorOf(version) {
  return parse(version)[0]
}

/** @param {string} version @param {Level} level */
export function bump(version, level) {
  const [major, minor, patch] = parse(version)
  if (level === "major") return `${major + 1}.0.0`
  if (level === "minor") return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

/** @param {Level | undefined} a @param {Level | undefined} b @returns {Level | undefined} */
export function maxLevel(a, b) {
  if (!a) return b
  if (!b) return a
  return LEVELS.indexOf(a) >= LEVELS.indexOf(b) ? a : b
}

/** The level of the change from one version to a higher one. @param {string} from @param {string} to @returns {Level | undefined} */
export function diffLevel(from, to) {
  const a = parse(from)
  const b = parse(to)
  if (b[0] !== a[0]) return "major"
  if (b[1] !== a[1]) return "minor"
  if (b[2] !== a[2]) return "patch"
  return undefined
}

/**
 * Turns a range into [min, maxExclusive) bounds. Supports `1.2.3`, `^1.2.3`, `~1.2.3`, `1`, `1.2`,
 * `1.x`, `1.2.x`, `*` and `latest`.
 * @param {string} range
 * @returns {{ min: string, max?: string }}
 */
function bounds(range) {
  const r = range.trim()
  if (r === "*" || r === "latest" || r === "x" || r === "") return { min: "0.0.0" }
  const m = /^([\^~]?)(\d+)(?:\.(\d+|x))?(?:\.(\d+|x))?$/.exec(r)
  if (!m) throw new Error(`Unsupported version range: ${JSON.stringify(range)}`)
  const [, op, majorS, minorS, patchS] = m
  const major = Number(majorS)
  const minor = minorS === undefined || minorS === "x" ? undefined : Number(minorS)
  const patch = patchS === undefined || patchS === "x" ? undefined : Number(patchS)
  const min = `${major}.${minor ?? 0}.${patch ?? 0}`
  if (op === "^") {
    if (major > 0 || minor === undefined) return { min, max: `${major + 1}.0.0` }
    if (minor > 0 || patch === undefined) return { min, max: `0.${minor + 1}.0` }
    return { min, max: `0.0.${patch + 1}` }
  }
  if (op === "~") {
    if (minor === undefined) return { min, max: `${major + 1}.0.0` }
    return { min, max: `${major}.${minor + 1}.0` }
  }
  if (minor === undefined) return { min, max: `${major + 1}.0.0` }
  if (patch === undefined) return { min, max: `${major}.${minor + 1}.0` }
  return { min, max: bump(min, "patch") }
}

/** @param {string} range */
export function validRange(range) {
  try {
    bounds(range)
    return true
  } catch {
    return false
  }
}

/** @param {string} version @param {string} range */
export function satisfies(version, range) {
  const { min, max } = bounds(range)
  return compare(version, min) >= 0 && (max === undefined || compare(version, max) < 0)
}

/** @param {string[]} versions @param {string[]} ranges @returns {string | undefined} */
export function maxSatisfying(versions, ranges) {
  return [...versions]
    .sort(compare)
    .reverse()
    .find((v) => ranges.every((r) => satisfies(v, r)))
}

/**
 * Splits an npm dependency like `react-day-picker@^9.4.0` or `@radix-ui/react-slot@1.1.0`.
 * @param {string} spec
 * @returns {{ name: string, version?: string }}
 */
export function splitPackage(spec) {
  const at = spec.lastIndexOf("@")
  if (at <= 0) return { name: spec }
  return { name: spec.slice(0, at), version: spec.slice(at + 1) }
}

/** The lowest major an npm version or range allows, or undefined for tags and urls. @param {string | undefined} spec */
export function npmMajor(spec) {
  const m = spec && /^[\^~>=v ]*(\d+)/.exec(spec)
  return m ? Number(m[1]) : undefined
}
