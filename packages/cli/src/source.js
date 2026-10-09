// @ts-check
// The registry side: reads registry.json and the committed releases, plans version bumps from
// changesets and dependency changes, applies them (`version`) and writes the served files (`build`).
import { existsSync } from "node:fs"
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import { deleteChangesets, readChangesets } from "./changeset.js"
import { bump, compare, diffLevel, maxLevel, npmMajor, satisfies, splitPackage, validRange, VERSION_RE } from "./semver.js"

/** @typedef {import("./semver.js").Level} Level */
/** @typedef {import("./changeset.js").Changeset} Changeset */
/**
 * @typedef {{ path: string, type: string, target?: string, content?: string }} ItemFile
 * @typedef {{ name: string, type: string, title?: string, description?: string,
 *   dependencies?: string[], devDependencies?: string[], registryDependencies?: string[],
 *   files: ItemFile[], cssVars?: unknown, css?: unknown, envVars?: unknown, font?: unknown,
 *   docs?: string, categories?: string[], meta?: Record<string, any> }} Item
 * @typedef {{ name: string, from?: string, to: string, level?: Level, reasons: string[],
 *   changeset?: boolean }} PlanEntry
 * @typedef {{ root: string, manifest: string, releasesDir: string, baseUrl: string,
 *   registry: { name: string, homepage?: string, items: Item[] } }} Source
 */

export const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const ITEM_SCHEMA = "https://ui.shadcn.com/schema/registry-item.json"
export const REGISTRY_SCHEMA = "https://ui.shadcn.com/schema/registry.json"
const INSTALLABLE = ["type", "devDependencies", "cssVars", "css", "envVars", "font"]
const TOOL_META = ["internal", "exposes"]

/**
 * Reads registry.json, registry.config.json (`baseUrl`) and resolves file contents.
 * @param {string} root registry repo root
 * @returns {Promise<Source>}
 */
export async function readSource(root) {
  const manifest = path.join(root, "registry.json")
  const registry = JSON.parse(await readFile(manifest, "utf8"))
  const configFile = path.join(root, "registry.config.json")
  const config = existsSync(configFile) ? JSON.parse(await readFile(configFile, "utf8")) : {}
  const baseUrl = String(process.env.REGISTRY_BASE_URL ?? config.baseUrl ?? "").replace(/\/$/, "")
  if (!baseUrl) throw new Error("Set baseUrl in registry.config.json (the public URL of the built r/ folder)")
  const errors = []
  for (const item of registry.items ?? []) {
    for (const file of item.files ?? []) {
      try {
        file.content = await readFile(path.join(root, file.path), "utf8")
      } catch {
        errors.push(`${item.name}: file not found: ${file.path}`)
      }
    }
  }
  errors.push(...validate(registry.items ?? []))
  if (errors.length) throw invalid(errors)
  return { root, manifest, releasesDir: path.join(root, "releases"), baseUrl, registry }
}

/** @param {Item[]} items */
function validate(items) {
  const errors = []
  const names = new Set()
  for (const item of items) {
    if (!NAME_RE.test(item.name ?? "")) errors.push(`invalid name: ${JSON.stringify(item.name)}`)
    if (names.has(item.name)) errors.push(`duplicate name: ${item.name}`)
    names.add(item.name)
    if (!/^registry:[a-z]+$/.test(item.type ?? "")) errors.push(`${item.name}: type must look like registry:ui`)
    const version = item.meta?.version
    if (!VERSION_RE.test(version ?? "")) {
      errors.push(`${item.name}: meta.version must look like 1.2.3, got ${JSON.stringify(version)}`)
    }
    if (!item.files?.length) errors.push(`${item.name}: no files`)
    for (const file of item.files ?? []) {
      if (path.isAbsolute(file.path) || file.path.split(/[\\/]/).includes("..")) {
        errors.push(`${item.name}: file path must stay inside the repo: ${file.path}`)
      }
    }
    for (const [dep, range] of Object.entries(item.meta?.requires ?? {})) {
      if (!validRange(String(range))) errors.push(`${item.name}: meta.requires.${dep} is not a range: ${range}`)
    }
  }
  for (const item of items) {
    for (const dep of localDeps(item, names)) {
      if (dep === item.name) errors.push(`${item.name}: depends on itself`)
    }
  }
  return errors
}

/** @param {string[]} errors */
function invalid(errors) {
  return new Error(`Invalid registry:\n  - ${errors.join("\n  - ")}`)
}

/**
 * Registry dependencies that are items of this registry (bare names). Anything else (URLs,
 * `@namespace/item`, items of the default shadcn registry) is passed through unversioned.
 * @param {Item} item @param {Set<string>} names
 */
export function localDeps(item, names) {
  return (item.registryDependencies ?? []).filter((dep) => names.has(dep))
}

/** @param {Source} source @param {string} name @returns {Promise<Item[]>} oldest first */
export async function readReleases(source, name) {
  const dir = path.join(source.releasesDir, name)
  if (!existsSync(dir)) return []
  const versions = (await readdir(dir))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .filter((v) => VERSION_RE.test(v))
    .sort(compare)
  return Promise.all(versions.map(async (v) => JSON.parse(await readFile(path.join(dir, `${v}.json`), "utf8"))))
}

/**
 * Everything that changes what lands in a consumer's project, except npm versions and the
 * versions of registry dependencies, which are compared separately to decide the bump level.
 * @param {Item} item
 */
function ownKey(item) {
  const pick = Object.fromEntries(INSTALLABLE.map((k) => [k, /** @type {any} */ (item)[k] ?? null]))
  return JSON.stringify({
    ...pick,
    devDependencies: (item.devDependencies ?? []).map((d) => splitPackage(d).name),
    dependencies: (item.dependencies ?? []).map((d) => splitPackage(d).name),
    registryDependencies: item.registryDependencies ?? [],
    files: item.files.map(({ path, type, target, content }) => ({ path, type, target: target ?? null, content })),
  })
}

/**
 * Bump level implied by npm version changes. A new major is breaking for consumers unless the item
 * lists the package in `meta.internal` (the dependency does not show in the item's API).
 * @param {Item} released @param {Item} item
 * @returns {{ level?: Level, reasons: string[] }}
 */
function npmChange(released, item) {
  const internal = new Set(item.meta?.internal ?? [])
  /** @type {Level | undefined} */
  let level
  const reasons = []
  for (const field of /** @type {const} */ (["dependencies", "devDependencies"])) {
    const before = new Map((released[field] ?? []).map((d) => [splitPackage(d).name, splitPackage(d).version]))
    for (const spec of item[field] ?? []) {
      const { name, version } = splitPackage(spec)
      if (!before.has(name) || before.get(name) === version) continue
      const was = before.get(name)
      const a = npmMajor(was)
      const b = npmMajor(version)
      const major = field === "dependencies" && a !== undefined && b !== undefined && b > a
      const l = major ? (internal.has(name) ? "minor" : "major") : "patch"
      level = maxLevel(level, l)
      reasons.push(`${name} ${was ?? "(any)"} → ${version ?? "(any)"}${major && l === "minor" ? " (internal)" : ""}`)
    }
  }
  return { level, reasons }
}

/**
 * True when one of the item's files re-exports a dependency's module, so the dependency's API is
 * part of the item's API. `meta.exposes` can say so explicitly.
 * @param {Item} item @param {Item} dep
 */
function exposes(item, dep) {
  if ((item.meta?.exposes ?? []).includes(dep.name)) return true
  const modules = new Set(dep.files.map((f) => path.basename(f.path).replace(/\.[^.]+$/, "")))
  const re = /export\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+["']([^"']+)["']/g
  for (const file of item.files) {
    for (const m of (file.content ?? "").matchAll(re)) {
      if (modules.has(m[1].split("/").at(-1) ?? "")) return true
    }
  }
  return false
}

/** Local items ordered dependencies first. @param {Item[]} items */
function topoOrder(items) {
  const names = new Set(items.map((i) => i.name))
  const byName = new Map(items.map((i) => [i.name, i]))
  /** @type {Item[]} */
  const order = []
  const state = new Map()
  /** @param {Item} item @param {string[]} trail */
  function visit(item, trail) {
    if (state.get(item.name) === "done") return
    if (state.get(item.name) === "visiting") {
      throw new Error(`Circular registry dependency: ${[...trail, item.name].join(" → ")}`)
    }
    state.set(item.name, "visiting")
    for (const dep of localDeps(item, names)) visit(/** @type {Item} */ (byName.get(dep)), [...trail, item.name])
    state.set(item.name, "done")
    order.push(item)
  }
  for (const item of items) visit(item, [])
  return order
}

/**
 * Works out the next version of every item.
 * - Own changes (files, dependency lists, css...) need a changeset or a manual `meta.version` bump.
 * - npm version changes bump by themselves: a new major is major (minor when `meta.internal`),
 *   anything else is a patch.
 * - When a registry dependency gets a new version, dependents follow: a new major makes them minor,
 *   or major when they re-export it; a minor or patch makes them a patch (their pin changes).
 * @param {Source} source
 * @param {Changeset[]} changesets
 * @returns {Promise<{ plan: PlanEntry[], errors: string[], versions: Map<string, string> }>}
 */
export async function planVersions(source, changesets) {
  const items = source.registry.items
  const names = new Set(items.map((i) => i.name))
  const byName = new Map(items.map((i) => [i.name, i]))
  const errors = []

  /** @type {Map<string, { level: Level, summaries: string[] }>} */
  const explicit = new Map()
  for (const c of changesets) {
    for (const [name, level] of Object.entries(c.bumps)) {
      if (!names.has(name)) {
        errors.push(`${c.file}: unknown item ${name}`)
        continue
      }
      const e = explicit.get(name) ?? { level, summaries: [] }
      e.level = /** @type {Level} */ (maxLevel(e.level, level))
      if (c.summary) e.summaries.push(c.summary)
      explicit.set(name, e)
    }
  }

  /** @type {Map<string, string>} */
  const versions = new Map()
  /** @type {Map<string, Item | undefined>} */
  const latest = new Map()
  for (const item of items) latest.set(item.name, (await readReleases(source, item.name)).at(-1))

  /** @type {PlanEntry[]} */
  const plan = []
  for (const item of topoOrder(items)) {
    const released = latest.get(item.name)
    const current = item.meta?.version
    if (!released) {
      versions.set(item.name, current)
      plan.push({ name: item.name, to: current, reasons: ["first release"] })
      continue
    }
    if (compare(current, released.meta?.version) < 0) {
      errors.push(`${item.name}: meta.version ${current} is lower than the released ${released.meta?.version}`)
    }
    const e = explicit.get(item.name)
    const manual = compare(current, released.meta?.version) > 0
    /** @type {Level | undefined} */
    let level = e?.level
    const reasons = [...(e?.summaries ?? [])]
    if (ownKey(item) !== ownKey(released) && !e && !manual) {
      errors.push(`${item.name} changed since ${released.meta?.version} but has no changeset; run \`cscl-reg changeset ${item.name}:<patch|minor|major> -m "..."\``)
    }
    const npm = npmChange(released, item)
    level = maxLevel(level, npm.level)
    if (npm.reasons.length) reasons.push(`Dependencies: ${npm.reasons.join(", ")}`)

    const pins = released.meta?.pins ?? {}
    for (const dep of localDeps(item, names)) {
      const was = pins[dep]
      const now = /** @type {string} */ (versions.get(dep))
      if (!was || was === now) continue
      const change = compare(now, was) > 0 ? diffLevel(was, now) : "major"
      const depItem = /** @type {Item} */ (byName.get(dep))
      const follow = change === "major" ? (exposes(item, depItem) ? "major" : "minor") : "patch"
      level = maxLevel(level, follow)
      reasons.push(`Updated ${dep} ${was} → ${now}`)
    }

    const next = level ? bump(released.meta?.version, level) : released.meta?.version
    const to = compare(current, next) > 0 ? current : next
    versions.set(item.name, to)
    if (to !== released.meta?.version) {
      plan.push({ name: item.name, from: released.meta?.version, to, level: diffLevel(released.meta?.version, to), reasons, changeset: !!e })
    }
  }

  for (const item of items) {
    const deps = localDeps(item, names)
    for (const [dep, range] of Object.entries(item.meta?.requires ?? {})) {
      const v = versions.get(dep)
      if (!v || !deps.includes(dep)) errors.push(`${item.name}: meta.requires names ${dep}, which is not a registry dependency`)
      else if (!satisfies(v, String(range))) errors.push(`${item.name}: requires ${dep}@${range} but ${dep} is at ${v}`)
    }
  }
  return { plan, errors, versions }
}

/**
 * `cscl-reg version`: applies the plan to registry.json, writes changelog entries and deletes the
 * changesets it used.
 * @param {string} root
 * @param {{ log?: (msg: string) => void }} [opts]
 */
export async function applyVersions(root, { log = console.log } = {}) {
  const source = await readSource(root)
  const changesets = await readChangesets(root)
  const { plan, errors } = await planVersions(source, changesets)
  if (errors.length) throw invalid(errors)
  const raw = JSON.parse(await readFile(source.manifest, "utf8"))
  const date = new Date().toISOString().slice(0, 10)
  for (const entry of plan) {
    const item = raw.items.find((/** @type {Item} */ i) => i.name === entry.name)
    // Already applied by an earlier run (or a first release): nothing new to record.
    if (item.meta.version === entry.to && !entry.changeset) continue
    item.meta.version = entry.to
    await addChangelog(source, entry.name, entry.to, entry.reasons, `${date}${entry.level ? `, ${entry.level}` : ""}`)
    log(`${entry.name}: ${entry.from ?? "new"} → ${entry.to}${entry.level ? ` (${entry.level})` : ""}`)
  }
  await writeFile(source.manifest, JSON.stringify(raw, null, 2) + "\n")
  await deleteChangesets(root, changesets)
  if (!plan.some((e) => e.from)) log("nothing to version")
  return plan
}

/**
 * Appends a `## <version>` section to releases/<name>/CHANGELOG.md unless it is already there.
 * @param {Source} source @param {string} name @param {string} version @param {string[]} lines @param {string} note
 */
async function addChangelog(source, name, version, lines, note) {
  const file = path.join(source.releasesDir, name, "CHANGELOG.md")
  await mkdir(path.dirname(file), { recursive: true })
  if (!existsSync(file)) await writeFile(file, `# ${name}\n`)
  if ((await readChangelog(file)).has(version)) return
  const body = (lines.length ? lines : ["Version bump."]).map((l) => `- ${l.replace(/\s*\n+\s*/g, " ")}`).join("\n")
  await appendFile(file, `\n## ${version}\n\n_${note}_\n\n${body}\n`)
}

/**
 * The release snapshot committed to releases/<name>/<version>.json. Registry dependencies stay
 * names here and are pinned in `meta.pins`, so snapshots do not depend on where they are hosted.
 * @param {Item} item @param {Map<string, string>} versions @param {Set<string>} names
 */
function snapshot(item, versions, names) {
  const deps = localDeps(item, names)
  const meta = Object.fromEntries(Object.entries(item.meta ?? {}).filter(([k]) => !TOOL_META.includes(k)))
  const pins = Object.fromEntries(deps.map((d) => [d, versions.get(d)]))
  const requires = Object.fromEntries(deps.map((d) => [d, item.meta?.requires?.[d] ?? `^${versions.get(d)}`]))
  return {
    ...item,
    meta: { ...meta, version: item.meta?.version, ...(deps.length && { pins, requires }), releasedAt: new Date().toISOString() },
  }
}

/** Same release content? (ignores releasedAt) @param {Item} a @param {Item} b */
function sameRelease(a, b) {
  const strip = (/** @type {Item} */ i) => JSON.stringify({ ...i, title: null, description: null, docs: null, categories: null, meta: { ...i.meta, releasedAt: null } })
  return strip(a) === strip(b)
}

/**
 * A release as served: shadcn registry-item JSON with registry dependencies pinned to exact
 * versioned URLs, so a plain `npx shadcn add <url>` is reproducible.
 * @param {Item} release @param {string} baseUrl
 */
export function render(release, baseUrl) {
  const pins = release.meta?.pins ?? {}
  return {
    $schema: ITEM_SCHEMA,
    ...release,
    registryDependencies: release.registryDependencies?.map((d) => (pins[d] ? `${baseUrl}/${d}/${pins[d]}.json` : d)),
  }
}

/**
 * `cscl-reg build`: checks that every change is versioned, snapshots new versions into releases/
 * and writes the served registry to outDir.
 * @param {string} root
 * @param {{ outDir: string, log?: (msg: string) => void }} opts
 */
export async function build(root, { outDir, log = console.log }) {
  const source = await readSource(root)
  const { errors, versions } = await planVersions(source, [])
  const items = source.registry.items
  const names = new Set(items.map((i) => i.name))
  for (const item of items) {
    const v = versions.get(item.name)
    if (v && v !== item.meta?.version) errors.push(`${item.name}: needs version ${v} (run \`cscl-reg version\`)`)
  }
  if (errors.length) throw invalid(errors)

  for (const item of items) {
    const released = await readReleases(source, item.name)
    const snap = snapshot(item, versions, names)
    const same = released.find((r) => r.meta?.version === item.meta?.version)
    if (same) {
      if (!sameRelease(same, snap)) errors.push(`${item.name}: changed since ${same.meta?.version} was released; run \`cscl-reg version\``)
      continue
    }
    await writeJson(path.join(source.releasesDir, item.name, `${item.meta?.version}.json`), snap)
    const first = released.length === 0
    await addChangelog(source, item.name, item.meta?.version, [first ? "First release." : "Released without changeset notes."], new Date().toISOString().slice(0, 10))
    log(`released ${item.name}@${item.meta?.version}`)
  }
  if (errors.length) throw invalid(errors)

  await mkdir(outDir, { recursive: true })
  const index = []
  for (const name of existsSync(source.releasesDir) ? (await readdir(source.releasesDir)).sort() : []) {
    if (!NAME_RE.test(name)) continue
    const released = await readReleases(source, name)
    if (!released.length) continue
    const notes = await readChangelog(path.join(source.releasesDir, name, "CHANGELOG.md"))
    for (const r of released) await writeJson(path.join(outDir, name, `${r.meta?.version}.json`), render(r, source.baseUrl))
    const top = /** @type {Item} */ (released.at(-1))
    await writeJson(path.join(outDir, name, "versions.json"), {
      name,
      latest: top.meta?.version,
      versions: released.map((r) => ({
        version: r.meta?.version,
        releasedAt: r.meta?.releasedAt,
        requires: r.meta?.requires,
        dependencies: r.dependencies,
        notes: notes.get(r.meta?.version),
      })),
    })
    if (!names.has(name)) continue
    await writeJson(path.join(outDir, `${name}.json`), render(top, source.baseUrl))
    const { files, ...rest } = render(top, source.baseUrl)
    index.push({ ...rest, $schema: undefined, files: files.map(({ content, ...f }) => f) })
  }
  await writeJson(path.join(outDir, "registry.json"), {
    $schema: REGISTRY_SCHEMA,
    name: source.registry.name,
    homepage: source.registry.homepage,
    items: index,
  })
  log(`built ${index.length} item(s) to ${path.relative(root, outDir) || outDir}`)
  return index
}

/** @param {string} file @returns {Promise<Map<string, string>>} version → notes */
async function readChangelog(file) {
  const notes = new Map()
  if (!existsSync(file)) return notes
  const text = await readFile(file, "utf8")
  for (const part of text.split(/^## /m).slice(1)) {
    const [head, ...body] = part.split("\n")
    notes.set(head.trim(), body.join("\n").trim())
  }
  return notes
}

/** @param {string} file @param {unknown} data */
async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(data, null, 2) + "\n")
}
