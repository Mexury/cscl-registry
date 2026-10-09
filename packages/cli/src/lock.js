// @ts-check
import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"

export const LOCK_FILE = "components.lock.json"

/**
 * What is installed: the version per item, the npm specs and registry ranges of that version, and
 * a hash of each file as written (after import rewriting), so local edits can be detected.
 * @typedef {{ version: string, direct?: boolean, dependencies?: string[],
 *   requires?: Record<string, string>, files: Record<string, string> }} LockEntry
 * @typedef {{ lockfileVersion: 1, items: Record<string, LockEntry> }} Lock
 */

/** @param {string} cwd @returns {Promise<Lock>} */
export async function readLock(cwd) {
  try {
    const lock = JSON.parse(await readFile(path.join(cwd, LOCK_FILE), "utf8"))
    if (lock.lockfileVersion !== 1) throw new Error(`${LOCK_FILE}: unsupported lockfileVersion ${lock.lockfileVersion}`)
    return lock
  } catch (error) {
    if (error.code === "ENOENT") return { lockfileVersion: 1, items: {} }
    throw error
  }
}

/** @param {string} cwd @param {Lock} lock */
export async function writeLock(cwd, lock) {
  const items = Object.fromEntries(Object.entries(lock.items).sort(([a], [b]) => a.localeCompare(b)))
  await writeFile(path.join(cwd, LOCK_FILE), JSON.stringify({ lockfileVersion: 1, items }, null, 2) + "\n")
}

/** @param {string} content */
export function hash(content) {
  return `sha256-${createHash("sha256").update(content).digest("hex")}`
}

/** @param {string} file @returns {Promise<string | undefined>} */
export async function hashFile(file) {
  try {
    return hash(await readFile(file, "utf8"))
  } catch {
    return undefined
  }
}
