// @ts-check
// Reads a versioned registry over HTTP(S) or from a local folder, through the namespaces in
// components.json (`"@cscl": "https://example.com/r/{name}.json"`).
import { readFile } from "node:fs/promises"
import path from "node:path"

import { NAME_RE } from "./source.js"
import { compare, VERSION_RE } from "./semver.js"

/** @typedef {import("./project.js").Project} Project */
/** @typedef {import("./source.js").Item} Item */
/**
 * @typedef {{ version: string, releasedAt?: string, requires?: Record<string, string>,
 *   dependencies?: string[], notes?: string }} VersionInfo
 * @typedef {{ name: string, latest: string, versions: VersionInfo[] }} Versions
 */

const NAMESPACE_RE = /^@[a-z0-9][\w-]*$/i

/**
 * Splits `@ns/button@^1.2`, `button@1.0.0` or `button` into namespace, name and version range.
 * Without a namespace, the project's only registry is used.
 * @param {string} spec @param {Project} project
 * @returns {{ id: string, ns: string, name: string, range?: string }}
 */
export function parseSpec(spec, project) {
  const m = /^(?:(@[^/@]+)\/)?([^@/]+)(?:@(.+))?$/.exec(spec)
  if (!m || !NAME_RE.test(m[2])) throw new Error(`Invalid item: ${JSON.stringify(spec)}`)
  let ns = m[1]
  if (!ns) {
    const all = Object.keys(project.registries)
    if (all.length !== 1) {
      throw new Error(`Say which registry ${m[2]} comes from, e.g. @ns/${m[2]} (configured: ${all.join(", ") || "none"})`)
    }
    ns = all[0]
  }
  if (!NAMESPACE_RE.test(ns)) throw new Error(`Invalid namespace: ${ns}`)
  return { id: `${ns}/${m[2]}`, ns, name: m[2], range: m[3] }
}

/**
 * @param {string} id e.g. "@cscl/button"; names can come from registry JSON, so they are checked
 * before they become part of a URL or path.
 */
export function splitId(id) {
  const at = id.indexOf("/")
  const ns = id.slice(0, at)
  const name = id.slice(at + 1)
  if (!NAMESPACE_RE.test(ns) || !NAME_RE.test(name)) throw new Error(`Invalid item: ${JSON.stringify(id)}`)
  return { ns, name }
}

/**
 * Fetches registry files for a project, caching each file for the run.
 * @param {Project} project
 * @param {NodeJS.ProcessEnv} [env]
 */
export function createRegistry(project, env = process.env) {
  /** @type {Map<string, Promise<any>>} */
  const cache = new Map()

  /** @param {string} ns */
  function endpoint(ns) {
    const entry = project.registries[ns]
    if (!entry) throw new Error(`No registry ${ns} in components.json; run \`cscl-reg init --registry <url> --namespace ${ns}\``)
    const { url, headers = {}, params = {} } = typeof entry === "string" ? { url: entry } : entry
    if (!url.endsWith("/{name}.json")) throw new Error(`Registry ${ns} must look like <base>/{name}.json to be versioned, got ${url}`)
    const expand = (/** @type {string} */ v) =>
      v.replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_, name, fallback) => {
        const value = env[name] ?? fallback
        if (value === undefined) throw new Error(`Registry ${ns} needs ${name}, which is not set`)
        return value
      })
    return {
      base: expand(url.slice(0, -"/{name}.json".length)),
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, expand(v)])),
      query: new URLSearchParams(Object.entries(params).map(([k, v]) => [k, expand(v)])).toString(),
    }
  }

  /** @param {string} ns @param {string} file */
  function get(ns, file) {
    const key = `${ns}:${file}`
    if (!cache.has(key)) cache.set(key, load(ns, file))
    return /** @type {Promise<any>} */ (cache.get(key))
  }

  /** @param {string} ns @param {string} file */
  async function load(ns, file) {
    const { base, headers, query } = endpoint(ns)
    if (/^https?:\/\//.test(base)) {
      const url = `${base}/${file}${query ? `?${query}` : ""}`
      const res = await fetch(url, { headers })
      if (!res.ok) throw new Error(`Could not fetch ${url} (${res.status})`)
      return res.json()
    }
    const full = path.resolve(project.cwd, base, file)
    try {
      return JSON.parse(await readFile(full, "utf8"))
    } catch {
      throw new Error(`Could not read ${full}`)
    }
  }

  return {
    /** @param {string} id @returns {Promise<Versions>} */
    async versions(id) {
      const { ns, name } = splitId(id)
      let data
      try {
        data = await get(ns, `${name}/versions.json`)
      } catch (error) {
        throw new Error(`${id} has no version list; is ${ns} a versioned registry and does ${name} exist? (${error.message})`)
      }
      data.versions = data.versions.filter((/** @type {VersionInfo} */ v) => VERSION_RE.test(v.version))
      data.versions.sort((/** @type {VersionInfo} */ a, /** @type {VersionInfo} */ b) => compare(a.version, b.version))
      return data
    },
    /** @param {string} id @param {string} version @returns {Promise<Item>} */
    async release(id, version) {
      if (!VERSION_RE.test(version)) throw new Error(`Invalid version ${version} for ${id}`)
      const { ns, name } = splitId(id)
      const item = await get(ns, `${name}/${version}.json`)
      if (item.name !== name || item.meta?.version !== version) throw new Error(`${id}@${version}: registry returned a different item`)
      return item
    },
    /** @param {string} ns */
    index(ns) {
      return get(ns, "registry.json")
    },
  }
}

/** @typedef {ReturnType<typeof createRegistry>} Registry */
