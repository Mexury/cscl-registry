// @ts-check
// Picks one version per item for a project. Items are copied to fixed paths, so a project can hold
// only one version of each; the resolver moves dependencies (and, when needed, dependents) until
// every item's `meta.requires` ranges hold, or explains the conflict.
import { compare, majorOf, maxSatisfying, satisfies } from "./semver.js"
import { splitId } from "./remote.js"

/** @typedef {import("./remote.js").Registry} Registry */
/**
 * @typedef {{ id: string, range?: string, exact?: boolean }} Request
 *   `range` empty means "latest" (within the installed major unless `major` is set)
 */

/**
 * @param {{ installed: Map<string, string>, requests: Request[], major?: boolean, registry: Registry }} input
 * @returns {Promise<Map<string, string>>} id → version for every item the project will have
 */
export async function resolve({ installed, requests, major = false, registry }) {
  const chosen = new Map(installed)
  /** @type {Map<string, string>} */
  const pinned = new Map()

  for (const req of requests) {
    const list = (await registry.versions(req.id)).versions.map((v) => v.version)
    const current = installed.get(req.id)
    let target
    if (req.range) {
      target = maxSatisfying(list, [req.range])
      if (!target) throw new Error(`${req.id}: no version matches ${req.range} (available: ${list.join(", ")})`)
    } else if (current && !major) {
      target = maxSatisfying(list, [String(majorOf(current))]) ?? current
    } else {
      target = list.at(-1)
    }
    if (!target) throw new Error(`${req.id}: the registry lists no versions`)
    chosen.set(req.id, target)
    pinned.set(req.id, target)
  }

  /** @param {string} id @param {string} version @returns {Promise<Record<string, string>>} dep id → range */
  async function requiresOf(id, version) {
    const { ns } = splitId(id)
    const info = (await registry.versions(id)).versions.find((v) => v.version === version)
    const requires = info?.requires ?? (await registry.release(id, version)).meta?.requires ?? {}
    // splitId checks the name, which comes from registry JSON.
    return Object.fromEntries(Object.entries(requires).map(([name, range]) => [`${ns}/${splitId(`${ns}/${name}`).name}`, range]))
  }

  /**
   * Moves a dependent to the highest version (in its current major unless `major`) whose
   * requirement on `dep` accepts `depVersion`.
   * @param {string} id @param {string} dep @param {string} depVersion
   */
  async function moveDependent(id, dep, depVersion) {
    if (pinned.has(id)) return false
    const now = /** @type {string} */ (chosen.get(id))
    const list = (await registry.versions(id)).versions.map((v) => v.version).sort(compare).reverse()
    for (const v of list) {
      if (!major && majorOf(v) !== majorOf(now)) continue
      const range = (await requiresOf(id, v))[dep]
      if (range === undefined || satisfies(depVersion, range)) {
        chosen.set(id, v)
        return true
      }
    }
    return false
  }

  for (let round = 0; round < 100; round++) {
    /** @type {Map<string, { from: string, range: string }[]>} */
    const wants = new Map()
    for (const [id, version] of chosen) {
      for (const [dep, range] of Object.entries(await requiresOf(id, version))) {
        wants.set(dep, [...(wants.get(dep) ?? []), { from: id, range }])
      }
    }
    let changed = false
    for (const [dep, list] of wants) {
      const current = chosen.get(dep)
      if (current && list.every((w) => satisfies(current, w.range))) continue
      changed = true
      const available = (await registry.versions(dep)).versions.map((v) => v.version)
      if (!pinned.has(dep)) {
        const best = maxSatisfying(available, list.map((w) => w.range))
        if (best) {
          chosen.set(dep, best)
          continue
        }
        const fixed = list.filter((w) => pinned.has(w.from)).map((w) => w.range)
        const pick = (current && fixed.every((r) => satisfies(current, r)) ? current : undefined) ?? maxSatisfying(available, fixed)
        if (!pick) throw conflict(dep, list, chosen)
        chosen.set(dep, pick)
      }
      const depVersion = /** @type {string} */ (chosen.get(dep))
      for (const w of list) {
        if (satisfies(depVersion, w.range)) continue
        if (!(await moveDependent(w.from, dep, depVersion))) throw conflict(dep, list, chosen, major)
      }
    }
    if (!changed) return chosen
  }
  throw new Error("Could not settle on versions (the requirements keep changing); try updating fewer items at once")
}

/**
 * @param {string} dep @param {{ from: string, range: string }[]} list @param {Map<string, string>} chosen
 * @param {boolean} [major]
 */
function conflict(dep, list, chosen, major) {
  const lines = list.map((w) => `${w.from}@${chosen.get(w.from)} needs ${dep}@${w.range}`)
  const hint = major ? "" : "\nIf a dependent has to change major, rerun with --major."
  return new Error(`No version of ${dep} works for everything installed:\n  ${lines.join("\n  ")}${hint}`)
}
