// @ts-check
// Consumer commands: init, list, add, update, outdated, diff, remove.
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { hash, hashFile, readLock, writeLock } from "./lock.js"
import { readProject, targetPath, transformImports, writeProject } from "./project.js"
import { createRegistry, parseSpec, splitId } from "./remote.js"
import { resolve } from "./resolve.js"
import { compare, majorOf, maxSatisfying, splitPackage } from "./semver.js"

/** @typedef {import("./project.js").Project} Project */
/** @typedef {import("./source.js").Item} Item */
/** @typedef {import("./lock.js").LockEntry} LockEntry */
/** @typedef {(msg: string) => void} Log */
/** @typedef {{ cwd: string, log?: Log, env?: NodeJS.ProcessEnv }} Common */

/**
 * Adds a versioned registry to components.json, so both `npx shadcn add @ns/item` and cscl-reg
 * can use it.
 * @param {Common & { registry?: string, namespace?: string }} opts
 */
export async function init({ cwd, registry, namespace = "@cscl", log = console.log }) {
  if (!registry) throw new Error("Usage: cscl-reg init --registry <base url of r/> [--namespace @cscl]")
  const project = await readProject(cwd)
  const url = registry.endsWith("{name}.json") ? registry : `${registry.replace(/\/$/, "")}/{name}.json`
  project.raw.registries = { ...project.raw.registries, [namespace]: url }
  await writeProject(project)
  log(`added ${namespace} → ${url} to components.json`)
}

/** @param {Common & { namespace?: string }} opts */
export async function list({ cwd, namespace, log = console.log, env }) {
  const project = await readProject(cwd)
  const registry = createRegistry(project, env)
  const namespaces = namespace ? [namespace] : Object.keys(project.registries)
  for (const ns of namespaces) {
    const index = await registry.index(ns)
    for (const item of index.items) {
      log(`${`${ns}/${item.name}`.padEnd(28)} ${String(item.meta?.version ?? "").padEnd(9)} ${item.description ?? ""}`)
    }
  }
}

/**
 * Installs items (`button`, `@ns/button@^1`, `button@1.2.0`) and the registry dependencies they
 * need. An installed item given with a version is moved to it, like `update --to`.
 * @param {string[]} specs
 * @param {Common & { overwrite?: boolean, dryRun?: boolean, install?: boolean, major?: boolean }} opts
 */
export async function add(specs, opts) {
  if (!specs.length) throw new Error("Usage: cscl-reg add <item[@version]...>")
  const project = await readProject(opts.cwd)
  const lock = await readLock(opts.cwd)
  const requests = []
  for (const spec of specs) {
    const { id, range } = parseSpec(spec, project)
    if (lock.items[id] && !range) {
      ;(opts.log ?? console.log)(`${id} is already installed (${lock.items[id].version}); use \`cscl-reg update ${id}\``)
      continue
    }
    requests.push({ id, range })
  }
  return sync(project, lock, requests, { ...opts, direct: true, resolverMajor: true })
}

/**
 * Moves installed items to the newest version in their major (or `--major`, or `--to <version>`),
 * and moves their dependencies along. Downgrades work the same way.
 * @param {string[]} specs empty means every installed item
 * @param {Common & { to?: string, major?: boolean, dryRun?: boolean, install?: boolean }} opts
 */
export async function update(specs, opts) {
  const project = await readProject(opts.cwd)
  const lock = await readLock(opts.cwd)
  const ids = specs.length ? specs : Object.keys(lock.items)
  if (!ids.length) throw new Error("Nothing installed yet. Use `cscl-reg add` first.")
  if (opts.to && ids.length !== 1) throw new Error("--to needs exactly one item")
  const requests = ids.map((spec) => {
    const { id, range } = parseSpec(spec, project)
    if (!lock.items[id]) throw new Error(`${id} is not installed`)
    return { id, range: opts.to ?? range }
  })
  return sync(project, lock, requests, opts)
}

/**
 * Resolves versions, then writes every item whose version changes: untouched files are replaced,
 * edited files get a three-way merge (installed version → your file → new version).
 * @param {Project} project
 * @param {import("./lock.js").Lock} lock
 * @param {import("./resolve.js").Request[]} requests
 * Moving an installed item to another major needs `major`, unless the item was asked for with an
 * explicit version or range.
 * @param {Common & { major?: boolean, resolverMajor?: boolean, dryRun?: boolean, install?: boolean,
 *   overwrite?: boolean, direct?: boolean }} opts
 */
async function sync(project, lock, requests, { cwd, log = console.log, env, major = false, resolverMajor = major, dryRun = false, install = true, overwrite = false, direct = false }) {
  const registry = createRegistry(project, env)
  const installed = new Map(Object.entries(lock.items).map(([id, e]) => [id, e.version]))
  const chosen = await resolve({ installed, requests, major: resolverMajor, registry })
  const requested = new Set(requests.map((r) => r.id))
  const explicit = new Set(requests.filter((r) => r.range).map((r) => r.id))

  const changes = await dependenciesFirst([...chosen].filter(([id, v]) => installed.get(id) !== v), registry)
  const crossing = changes.filter(([id, v]) => {
    const was = installed.get(id)
    return was && majorOf(was) !== majorOf(v) && !explicit.has(id)
  })
  if (crossing.length && !major) {
    const lines = crossing.map(([id, v]) => `${id} ${installed.get(id)} → ${v}`)
    throw new Error(`This moves to a new major version:\n  ${lines.join("\n  ")}\nRerun with --major to accept, or --dry-run to see the whole plan.`)
  }
  if (!changes.length) {
    for (const r of requests) log(`${r.id} is up to date (${installed.get(r.id)})`)
    return { changes: [], conflicts: [] }
  }
  for (const [id, v] of changes) {
    const was = installed.get(id)
    const why = requested.has(id) ? "" : was ? " (to keep its dependents working)" : " (dependency)"
    log(`${dryRun ? "[dry run] " : ""}${id} ${was ? `${was} → ${v}` : v}${why}`)
  }
  if (dryRun) return { changes, conflicts: [] }

  /** @type {string[]} */
  const conflicts = []
  /** @type {Set<string>} */
  const npmAdd = new Set()
  /** @type {Set<string>} */
  const npmGone = new Set()
  for (const [id, version] of changes) {
    const next = await registry.release(id, version)
    const entry = lock.items[id]
    const base = entry ? await registry.release(id, entry.version) : undefined
    log(`${id}: ${entry ? `${entry.version} → ` : "installing "}${version}`)
    const files = await writeItem(project, id, next, base, entry, { overwrite, log, conflicts })
    if (next.cssVars || next.css) log(`note: ${id} has CSS (cssVars/css) that cscl-reg does not apply; see its docs`)
    const ns = splitId(id).ns
    lock.items[id] = {
      version,
      ...((entry?.direct || (direct && requested.has(id))) && { direct: true }),
      ...(next.dependencies?.length && { dependencies: next.dependencies }),
      ...(next.meta?.requires && {
        requires: Object.fromEntries(Object.entries(next.meta.requires).map(([n, r]) => [`${ns}/${n}`, r])),
      }),
      files,
    }
    const before = new Set(entry?.dependencies ?? [])
    for (const dep of next.dependencies ?? []) if (!before.has(dep)) npmAdd.add(dep)
    const now = new Set((next.dependencies ?? []).map((d) => splitPackage(d).name))
    for (const dep of before) if (!now.has(splitPackage(dep).name)) npmGone.add(splitPackage(dep).name)
  }
  await writeLock(cwd, lock)
  installDependencies(cwd, [...npmAdd], { install, log })
  if (npmGone.size) log(`npm packages that may now be unused: ${[...npmGone].join(" ")}`)
  if (conflicts.length) log(`resolve the conflict markers in: ${conflicts.join(", ")}`)
  return { changes, conflicts }
}

/**
 * Orders changes so registry dependencies are written before the items that use them.
 * @param {[string, string][]} changes @param {import("./remote.js").Registry} registry
 */
async function dependenciesFirst(changes, registry) {
  const ids = new Set(changes.map(([id]) => id))
  /** @type {Map<string, string[]>} */
  const deps = new Map()
  for (const [id, version] of changes) {
    const { ns } = splitId(id)
    const requires = (await registry.release(id, version)).meta?.requires ?? {}
    deps.set(id, Object.keys(requires).map((n) => `${ns}/${n}`).filter((d) => ids.has(d)))
  }
  /** @type {[string, string][]} */
  const ordered = []
  const done = new Set()
  const visit = (/** @type {[string, string]} */ change) => {
    if (done.has(change[0])) return
    done.add(change[0])
    for (const d of deps.get(change[0]) ?? []) visit(/** @type {[string, string]} */ (changes.find(([id]) => id === d)))
    ordered.push(change)
  }
  changes.forEach(visit)
  return ordered
}

/**
 * Writes one item version into the project.
 * @param {Project} project @param {string} id @param {Item} next @param {Item | undefined} base
 * @param {LockEntry | undefined} entry
 * @param {{ overwrite: boolean, log: Log, conflicts: string[] }} ctx
 * @returns {Promise<Record<string, string>>} file → hash of what this version writes
 */
async function writeItem(project, id, next, base, entry, { overwrite, log, conflicts }) {
  const { cwd, aliases } = project
  /** @type {Map<string, string>} */
  const baseContent = new Map()
  for (const file of base?.files ?? []) {
    baseContent.set(targetPath(project, file, id), transformImports(file.content ?? "", aliases))
  }
  /** @type {Record<string, string>} */
  const files = {}
  for (const file of next.files) {
    const rel = targetPath(project, file, id)
    const abs = path.join(cwd, rel)
    const content = transformImports(file.content ?? "", aliases)
    files[rel] = hash(content)
    const local = existsSync(abs) ? await readFile(abs, "utf8") : undefined
    const untouched = local === undefined || (entry ? hash(local) === entry.files[rel] : overwrite)
    if (local === content) continue
    if (untouched) {
      await mkdir(path.dirname(abs), { recursive: true })
      await writeFile(abs, content)
      log(`  wrote ${rel}`)
      continue
    }
    if (!entry) {
      log(`  skipped ${rel}: it already exists (use --overwrite to replace it)`)
      continue
    }
    const ancestor = baseContent.get(rel)
    const merged = ancestor === undefined ? null : mergeFile(local, ancestor, content, ["yours", `${id}@${entry.version}`, `${id}@${next.meta?.version}`])
    if (!merged) {
      await writeFile(`${abs}.new`, content)
      conflicts.push(rel)
      log(`  kept your ${rel}; the new version is in ${rel}.new`)
    } else {
      await writeFile(abs, merged.content)
      if (merged.conflicts) conflicts.push(rel)
      log(merged.conflicts ? `  merged ${rel} with conflicts` : `  merged ${rel} (kept your edits)`)
    }
  }
  for (const [rel, lockedHash] of Object.entries(entry?.files ?? {})) {
    if (rel in files) continue
    const abs = insideProject(cwd, rel)
    if ((await hashFile(abs)) === lockedHash) {
      await unlink(abs)
      log(`  removed ${rel} (no longer part of ${id})`)
    } else if (existsSync(abs)) {
      log(`  kept ${rel}: edited, and no longer part of ${id}`)
    }
  }
  return files
}

/**
 * Lists installed items: installed, newest in the same major, newest overall, and local edits.
 * @param {Common} opts
 */
export async function outdated({ cwd, log = console.log, env }) {
  const project = await readProject(cwd)
  const registry = createRegistry(project, env)
  const lock = await readLock(cwd)
  const rows = []
  for (const [id, entry] of Object.entries(lock.items)) {
    const versions = (await registry.versions(id)).versions.map((v) => v.version)
    const wanted = maxSatisfying(versions, [String(majorOf(entry.version))]) ?? entry.version
    const latest = versions.at(-1) ?? entry.version
    const edited = (await editedFiles(cwd, entry)).length > 0
    rows.push({ id, installed: entry.version, wanted, latest, edited })
  }
  log(`${"item".padEnd(28)} ${"installed".padEnd(10)} ${"wanted".padEnd(10)} ${"latest".padEnd(10)} notes`)
  for (const r of rows) {
    const notes = [
      compare(r.wanted, r.installed) > 0 ? "update available" : "",
      r.latest !== r.wanted ? "new major (update --major)" : "",
      r.edited ? "edited locally" : "",
    ].filter(Boolean)
    log(`${r.id.padEnd(28)} ${r.installed.padEnd(10)} ${r.wanted.padEnd(10)} ${r.latest.padEnd(10)} ${notes.join(", ")}`)
  }
  return rows
}

/**
 * Shows your edits (installed version → your files), or with `upstream` what changed in the
 * registry (installed version → latest or `--to`).
 * @param {string} spec
 * @param {Common & { upstream?: boolean, to?: string }} opts
 */
export async function diff(spec, { cwd, upstream = false, to, log = console.log, env }) {
  const project = await readProject(cwd)
  const registry = createRegistry(project, env)
  const lock = await readLock(cwd)
  const { id } = parseSpec(spec, project)
  const entry = lock.items[id]
  if (!entry) throw new Error(`${id} is not installed`)
  const contents = async (/** @type {string} */ version) => {
    const item = await registry.release(id, version)
    return new Map(item.files.map((f) => [targetPath(project, f, id), transformImports(f.content ?? "", project.aliases)]))
  }
  const left = await contents(entry.version)
  let right
  let labels
  if (upstream) {
    const target = to ?? (await registry.versions(id)).latest
    right = await contents(target)
    labels = [`${id}@${entry.version}`, `${id}@${target}`]
  } else {
    right = new Map()
    for (const rel of left.keys()) {
      const abs = path.join(cwd, rel)
      if (existsSync(abs)) right.set(rel, await readFile(abs, "utf8"))
    }
    labels = [`${id}@${entry.version}`, "yours"]
  }
  const out = gitDiff(left, right, labels)
  log(out || "no differences")
  return out
}

/**
 * Deletes installed items whose files are untouched (`force` for edited ones) and that nothing
 * else installed depends on.
 * @param {string[]} specs
 * @param {Common & { force?: boolean }} opts
 */
export async function remove(specs, { cwd, force = false, log = console.log }) {
  if (!specs.length) throw new Error("Usage: cscl-reg remove <item...> [--force]")
  const project = await readProject(cwd)
  const lock = await readLock(cwd)
  const ids = specs.map((s) => parseSpec(s, project).id)
  for (const id of ids) {
    const entry = lock.items[id]
    if (!entry) throw new Error(`${id} is not installed`)
    const users = Object.entries(lock.items)
      .filter(([other, e]) => !ids.includes(other) && e.requires && id in e.requires)
      .map(([other]) => other)
    if (users.length) throw new Error(`${id} is used by ${users.join(", ")}; remove those first`)
    const edited = await editedFiles(cwd, entry)
    if (edited.length && !force) throw new Error(`${id} was edited (${edited.join(", ")}); use --force to delete it anyway`)
  }
  const deps = new Set()
  for (const id of ids) {
    for (const rel of Object.keys(lock.items[id].files)) {
      const abs = insideProject(cwd, rel)
      if (!existsSync(abs)) continue
      await unlink(abs)
      log(`removed ${rel}`)
    }
    for (const dep of lock.items[id].dependencies ?? []) deps.add(splitPackage(dep).name)
    delete lock.items[id]
  }
  await writeLock(cwd, lock)
  if (deps.size) log(`npm packages that may now be unused: ${[...deps].join(" ")}`)
}

/** @param {string} cwd @param {LockEntry} entry */
async function editedFiles(cwd, entry) {
  const edited = []
  for (const [rel, lockedHash] of Object.entries(entry.files)) {
    const current = await hashFile(insideProject(cwd, rel))
    if (current !== undefined && current !== lockedHash) edited.push(rel)
  }
  return edited
}

/** @param {string} cwd @param {string} rel */
function insideProject(cwd, rel) {
  const abs = path.resolve(cwd, rel)
  if (!abs.startsWith(cwd + path.sep)) throw new Error(`components.lock.json points outside the project: ${rel}`)
  return abs
}

/**
 * Three-way merge with `git merge-file`; null when git is not available.
 * @param {string} local @param {string} ancestor @param {string} incoming @param {string[]} labels
 * @returns {{ content: string, conflicts: number } | null}
 */
function mergeFile(local, ancestor, incoming, labels) {
  const dir = tempDir()
  try {
    const files = ["local", "base", "next"].map((f) => path.join(dir, f))
    ;[local, ancestor, incoming].forEach((content, i) => writeFileSync(files[i], content))
    const result = spawnSync("git", ["merge-file", "-p", ...labels.flatMap((l) => ["-L", l]), ...files], { encoding: "utf8" })
    if (result.error || result.status === null || result.status < 0 || result.status > 127) return null
    return { content: result.stdout, conflicts: result.status }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Unified diff of two file sets with `git diff --no-index`.
 * @param {Map<string, string>} left @param {Map<string, string>} right @param {string[]} labels
 */
function gitDiff(left, right, labels) {
  const dir = tempDir()
  try {
    const [a, b] = ["a", "b"].map((side) => path.join(dir, side))
    for (const [side, files] of /** @type {const} */ ([[a, left], [b, right]])) {
      mkdirSync(side, { recursive: true })
      for (const [rel, content] of files) {
        mkdirSync(path.dirname(path.join(side, rel)), { recursive: true })
        writeFileSync(path.join(side, rel), content)
      }
    }
    const result = spawnSync("git", ["diff", "--no-index", "--no-color", `--src-prefix=${labels[0]}/`, `--dst-prefix=${labels[1]}/`, "a", "b"], {
      cwd: dir,
      encoding: "utf8",
    })
    if (result.error || (result.status ?? 2) > 1) throw new Error(`diff needs git on your PATH${result.stderr ? `: ${result.stderr}` : ""}`)
    return result.stdout.split(`${labels[0]}/a/`).join(`${labels[0]}/`).split(`${labels[1]}/b/`).join(`${labels[1]}/`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), "cscl-reg-"))
}

/**
 * @param {string} cwd @param {string[]} deps exact npm specs from the release
 * @param {{ install: boolean, log: Log }} opts
 */
export function installDependencies(cwd, deps, { install, log }) {
  if (!deps.length) return
  const [cmd, ...args] = installCommand(cwd, deps)
  if (!install) {
    log(`npm packages to install: ${[cmd, ...args].join(" ")}`)
    return
  }
  log(`installing ${deps.join(" ")}`)
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" })
  if (result.status !== 0) throw new Error(`Dependency install failed: ${cmd} ${args.join(" ")}`)
}

/** @param {string} cwd @param {string[]} deps */
function installCommand(cwd, deps) {
  // Exact, because the registry pins exact versions and a range would drift from the release.
  if (existsSync(path.join(cwd, "pnpm-lock.yaml"))) return ["pnpm", "add", "--save-exact", ...deps]
  if (existsSync(path.join(cwd, "yarn.lock"))) return ["yarn", "add", "--exact", ...deps]
  if (existsSync(path.join(cwd, "bun.lock")) || existsSync(path.join(cwd, "bun.lockb"))) return ["bun", "add", "--exact", ...deps]
  return ["npm", "install", "--save-exact", ...deps]
}
