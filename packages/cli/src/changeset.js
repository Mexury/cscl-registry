// @ts-check
import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises"
import path from "node:path"

import { LEVELS } from "./semver.js"

/** @typedef {import("./semver.js").Level} Level */
/** @typedef {{ file: string, bumps: Record<string, Level>, summary: string }} Changeset */

export const CHANGESET_DIR = ".changeset"

/**
 * A changeset is a Markdown file with a front matter of `item: patch|minor|major` lines (the same
 * format as Changesets for npm) and a summary that ends up in each item's changelog.
 * @param {string} text
 * @param {string} file used in error messages
 * @returns {Changeset}
 */
export function parseChangeset(text, file) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) throw new Error(`${file}: a changeset starts with a --- front matter block`)
  /** @type {Record<string, Level>} */
  const bumps = {}
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim()) continue
    const entry = /^\s*["']?([a-z0-9-]+)["']?\s*:\s*(patch|minor|major)\s*$/.exec(line)
    if (!entry) throw new Error(`${file}: expected "item: patch|minor|major", got ${JSON.stringify(line)}`)
    bumps[entry[1]] = /** @type {Level} */ (entry[2])
  }
  return { file, bumps, summary: m[2].trim() }
}

/** @param {string} root registry repo root @returns {Promise<Changeset[]>} */
export async function readChangesets(root) {
  const dir = path.join(root, CHANGESET_DIR)
  if (!existsSync(dir)) return []
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md").sort()
  return Promise.all(
    files.map(async (f) => parseChangeset(await readFile(path.join(dir, f), "utf8"), path.join(CHANGESET_DIR, f)))
  )
}

/**
 * Writes a new changeset file.
 * @param {string} root
 * @param {Record<string, Level>} bumps
 * @param {string} summary
 */
export async function writeChangeset(root, bumps, summary) {
  const names = Object.keys(bumps)
  if (!names.length) throw new Error("Usage: cscl-reg changeset <item:patch|minor|major...> -m <summary>")
  for (const level of Object.values(bumps)) {
    if (!LEVELS.includes(level)) throw new Error(`Unknown bump ${JSON.stringify(level)}; use patch, minor or major`)
  }
  if (!summary.trim()) throw new Error("A changeset needs a summary (-m)")
  const file = path.join(CHANGESET_DIR, `${names[0]}-${randomBytes(3).toString("hex")}.md`)
  const body = `---\n${names.map((n) => `${n}: ${bumps[n]}`).join("\n")}\n---\n\n${summary.trim()}\n`
  await mkdir(path.join(root, CHANGESET_DIR), { recursive: true })
  await writeFile(path.join(root, file), body)
  return file
}

/** @param {string} root @param {Changeset[]} changesets */
export async function deleteChangesets(root, changesets) {
  for (const c of changesets) await unlink(path.join(root, c.file))
}
