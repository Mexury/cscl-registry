// @ts-check
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { writeChangeset } from "../src/changeset.js"
import { applyVersions, build } from "../src/source.js"

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
export const silent = () => {}

/**
 * A writable copy of this repo's registry (manifest, sources, releases), a build folder, and an
 * app with components.json pointing at that folder as the `@cscl` registry.
 */
export async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), "cscl-reg-src-"))
  for (const entry of ["registry.json", "registry.config.json", "registry", "releases"]) {
    await cp(path.join(repoRoot, entry), path.join(root, entry), { recursive: true })
  }
  const out = path.join(root, "public/r")
  const app = await mkdtemp(path.join(tmpdir(), "cscl-reg-app-"))
  await mkdir(path.join(app, "src"))
  await writeFile(
    path.join(app, "tsconfig.json"),
    `{\n  // like create-next-app\n  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] }, },\n}\n`
  )
  await writeFile(
    path.join(app, "components.json"),
    JSON.stringify({
      style: "new-york",
      aliases: { components: "@/components", utils: "@/lib/utils", ui: "@/components/ui", lib: "@/lib", hooks: "@/hooks" },
      registries: { "@cscl": `${out}/{name}.json` },
    })
  )

  const ws = {
    root,
    out,
    app,
    build: () => build(root, { outDir: out, log: silent }),
    version: () => applyVersions(root, { log: silent }),
    /** @param {Record<string, import("../src/semver.js").Level>} bumps @param {string} summary */
    changeset: (bumps, summary) => writeChangeset(root, bumps, summary),
    /** @param {string} rel @param {(s: string) => string} edit */
    async edit(rel, edit) {
      const file = path.join(root, rel)
      await writeFile(file, edit(await readFile(file, "utf8")))
    },
    /** @param {(registry: any) => void} change */
    async manifest(change) {
      const file = path.join(root, "registry.json")
      const registry = JSON.parse(await readFile(file, "utf8"))
      change(registry)
      await writeFile(file, JSON.stringify(registry, null, 2))
    },
    /** @param {string} name */
    async versionOf(name) {
      const registry = JSON.parse(await readFile(path.join(root, "registry.json"), "utf8"))
      return registry.items.find((/** @type {any} */ i) => i.name === name).meta.version
    },
    /** Changes a file, records a changeset, versions and builds. @param {string} rel @param {(s: string) => string} edit @param {Record<string, any>} bumps */
    async release(rel, edit, bumps, summary = "A change.") {
      await ws.edit(rel, edit)
      await ws.changeset(bumps, summary)
      await ws.version()
      await ws.build()
    },
    /** @param {string} rel */
    read: (rel) => readFile(path.join(app, rel), "utf8"),
    /** @param {string} rel @param {string} content */
    write: (rel, content) => writeFile(path.join(app, rel), content),
  }
  await ws.build()
  return ws
}

export const BUTTON = "registry/default/ui/button.tsx"
export const CARD = "registry/default/ui/card.tsx"
export const UTILS = "registry/default/lib/utils.ts"
export const APP_BUTTON = "src/components/ui/button.tsx"
export const APP_CARD = "src/components/ui/card.tsx"
export const APP_UTILS = "src/lib/utils.ts"
