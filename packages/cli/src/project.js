// @ts-check
// The consumer side's view of a project: components.json (aliases and registries), where each
// registry file lands, and the import rewriting shadcn does on install.
import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"

export const COMPONENTS_JSON = "components.json"

/**
 * @typedef {{ components: string, utils: string, ui: string, lib: string, hooks: string }} Aliases
 * @typedef {string | { url: string, headers?: Record<string, string>, params?: Record<string, string> }} RegistryEntry
 * @typedef {{ cwd: string, raw: Record<string, any>, aliases: Aliases, dirs: Aliases,
 *   registries: Record<string, RegistryEntry> }} Project
 */

/** @param {string} cwd @returns {Promise<Project>} */
export async function readProject(cwd) {
  const file = path.join(cwd, COMPONENTS_JSON)
  if (!existsSync(file)) {
    throw new Error(`No ${COMPONENTS_JSON} in ${cwd}. Run \`npx shadcn@latest init\` first; cscl-reg reads your aliases from it.`)
  }
  const raw = JSON.parse(await readFile(file, "utf8"))
  const a = raw.aliases ?? {}
  const components = trim(a.components ?? "@/components")
  /** @type {Aliases} */
  const aliases = {
    components,
    utils: trim(a.utils ?? "@/lib/utils"),
    ui: trim(a.ui ?? `${components}/ui`),
    lib: trim(a.lib ?? "@/lib"),
    hooks: trim(a.hooks ?? "@/hooks"),
  }
  const paths = await tsconfigPaths(cwd)
  const dirs = /** @type {Aliases} */ (
    Object.fromEntries(Object.entries(aliases).map(([k, v]) => [k, resolveAlias(cwd, v, paths)]))
  )
  return { cwd, raw, aliases, dirs, registries: raw.registries ?? {} }
}

/** @param {string} s */
function trim(s) {
  return s.replace(/\/+$/, "")
}

/** @param {Project} project */
export async function writeProject(project) {
  await writeFile(path.join(project.cwd, COMPONENTS_JSON), JSON.stringify(project.raw, null, 2) + "\n")
}

/**
 * `compilerOptions.paths` from tsconfig.json or jsconfig.json, with targets made relative to the
 * project root.
 * @param {string} cwd
 * @returns {Promise<[string, string][]>}
 */
async function tsconfigPaths(cwd) {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const file = path.join(cwd, name)
    if (!existsSync(file)) continue
    try {
      const opts = parseJsonc(await readFile(file, "utf8")).compilerOptions ?? {}
      const baseUrl = opts.baseUrl ?? "."
      return Object.entries(opts.paths ?? {}).map(([pattern, targets]) => [pattern, path.join(baseUrl, String(targets[0]))])
    } catch {
      return []
    }
  }
  return []
}

/**
 * Turns an import alias such as `@/components/ui` into a folder relative to the project root.
 * @param {string} cwd @param {string} alias @param {[string, string][]} paths
 */
export function resolveAlias(cwd, alias, paths) {
  for (const [pattern, target] of paths) {
    if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1)
      if (alias.startsWith(prefix)) return path.normalize(target.replace("*", alias.slice(prefix.length)))
    } else if (pattern === alias) {
      return path.normalize(target)
    }
  }
  const m = /^[@~]\/(.*)$/.exec(alias)
  if (!m) return alias
  return existsSync(path.join(cwd, "src")) ? path.join("src", m[1]) : m[1]
}

/** JSON with comments and trailing commas, as tsconfig allows. @param {string} text */
export function parseJsonc(text) {
  let out = ""
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      out += c
      if (c === "\\") out += text[++i] ?? ""
      else if (c === '"') inString = false
    } else if (c === '"') {
      inString = true
      out += c
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      out += "\n"
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2)
      if (i === -1) break
      i++
    } else {
      out += c
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"))
}

const TYPE_ALIAS = /** @type {Record<string, keyof Aliases>} */ ({
  "registry:ui": "ui",
  "registry:lib": "lib",
  "registry:hook": "hooks",
  "registry:component": "components",
  "registry:block": "components",
  "registry:example": "components",
})
const TYPE_SEGMENT = { ui: "ui", lib: "lib", hooks: "hooks", components: "components" }

/**
 * Where a registry file lands, relative to the project root. Refuses paths that leave the project,
 * since registry JSON comes from the network.
 * @param {Project} project
 * @param {{ path: string, type: string, target?: string }} file
 * @param {string} item used in error messages
 */
export function targetPath(project, file, item) {
  let rel
  if (file.target) {
    rel = file.target.replace(/^~\//, "")
  } else {
    const key = TYPE_ALIAS[file.type]
    if (!key) throw new Error(`${item}: ${file.path} has type ${file.type}, which needs a "target"`)
    const parts = file.path.split("/")
    const at = parts.lastIndexOf(TYPE_SEGMENT[key])
    const inside = at >= 0 && at < parts.length - 1 ? parts.slice(at + 1) : [parts.at(-1)]
    rel = path.join(project.dirs[key], ...inside)
  }
  const abs = path.resolve(project.cwd, rel)
  if (!abs.startsWith(project.cwd + path.sep)) throw new Error(`${item}: refusing to write outside the project: ${file.path}`)
  return path.relative(project.cwd, abs)
}

/**
 * Rewrites registry imports to the project's aliases, like the shadcn CLI:
 * `@/registry/<style>/ui/x` → ui alias, `.../lib/x` → lib, `.../hooks/x` → hooks, any other
 * `@/registry/<style>/x` → components, `@/lib/utils` → utils, and other `@/` imports to the
 * project's alias prefix.
 * @param {string} content @param {Aliases} aliases
 */
export function transformImports(content, aliases) {
  const prefix = aliases.components.includes("/") ? aliases.components.slice(0, aliases.components.indexOf("/") + 1) : "@/"
  return content
    .replace(/(["'])@\/registry\/[^/"']+\/(ui|lib|hooks)\//g, (_, q, dir) => `${q}${aliases[/** @type {"ui"} */ (dir)]}/`)
    .replace(/(["'])@\/registry\/[^/"']+\//g, (_, q) => `${q}${aliases.components}/`)
    .replace(/(["'])@\/lib\/utils(["'])/g, (_, q, q2) => `${q}${aliases.utils}${q2}`)
    .replace(/(["'])@\/(?!registry\/)/g, (_, q) => `${q}${prefix}`)
}
