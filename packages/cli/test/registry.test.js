// @ts-check
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { test } from "node:test"

import { parseChangeset, readChangesets } from "../src/changeset.js"
import { planVersions, readSource } from "../src/source.js"
import { BUTTON, CARD, UTILS, workspace } from "./helpers.js"

/** @param {string} dir @param {string} file */
const json = async (dir, file) => JSON.parse(await readFile(path.join(dir, file), "utf8"))

/** @param {Awaited<ReturnType<typeof workspace>>} ws */
async function plan(ws) {
  return planVersions(await readSource(ws.root), await readChangesets(ws.root))
}

test("served releases are shadcn items with dependencies pinned to versioned URLs", async () => {
  const ws = await workspace()
  const button = await json(ws.out, "button/1.0.0.json")
  assert.equal(button.$schema, "https://ui.shadcn.com/schema/registry-item.json")
  assert.deepEqual(button.registryDependencies, ["https://mexury.github.io/cscl-registry/r/utils/1.0.0.json"])
  assert.deepEqual(button.meta.requires, { utils: "^1.0.0" })
  assert.deepEqual(await json(ws.out, "button.json"), button)
  const versions = await json(ws.out, "button/versions.json")
  assert.equal(versions.latest, "1.0.0")
  const index = await json(ws.out, "registry.json")
  assert.deepEqual(index.items.map((/** @type {any} */ i) => i.name), ["button", "card", "utils"])
  assert.equal(index.items[0].files[0].content, undefined)
})

test("a file change without a changeset fails check and build", async () => {
  const ws = await workspace()
  await ws.edit(BUTTON, (s) => s + "\n// changed\n")
  const { errors } = await plan(ws)
  assert.match(errors.join("\n"), /button changed since 1\.0\.0 but has no changeset/)
  await assert.rejects(ws.build(), /button changed since 1\.0\.0 but has no changeset/)
})

test("a changeset bumps the item and every dependent gets a patch for its new pin", async () => {
  const ws = await workspace()
  await ws.release(UTILS, (s) => s + "\nexport const noop = () => {}\n", { utils: "minor" }, "Add noop().")
  assert.equal(await ws.versionOf("utils"), "1.1.0")
  assert.equal(await ws.versionOf("button"), "1.0.1")
  assert.equal(await ws.versionOf("card"), "1.0.1")
  assert.deepEqual(await readdir(path.join(ws.root, ".changeset")), [])

  const button = await json(ws.out, "button/1.0.1.json")
  assert.deepEqual(button.registryDependencies, ["https://mexury.github.io/cscl-registry/r/utils/1.1.0.json"])
  const old = await json(ws.out, "button/1.0.0.json")
  assert.deepEqual(old.registryDependencies, ["https://mexury.github.io/cscl-registry/r/utils/1.0.0.json"])

  const versions = await json(ws.out, "utils/versions.json")
  assert.deepEqual(versions.versions.map((/** @type {any} */ v) => v.version), ["1.0.0", "1.1.0"])
  assert.match(versions.versions[1].notes, /Add noop\(\)\./)
  assert.match(await readFile(path.join(ws.root, "releases/button/CHANGELOG.md"), "utf8"), /## 1\.0\.1[\s\S]*Updated utils 1\.0\.0 → 1\.1\.0/)

  // Versioning again changes nothing.
  await ws.version()
  assert.equal(await ws.versionOf("button"), "1.0.1")
})

test("a dependency major makes dependents minor, or major when they re-export it", async () => {
  const ws = await workspace()
  await ws.edit(CARD, (s) => s + '\nexport { cn } from "@/registry/default/lib/utils"\n')
  await ws.changeset({ card: "minor" }, "Re-export cn.")
  await ws.version()
  await ws.build()
  assert.equal(await ws.versionOf("card"), "1.1.0")

  await ws.release(UTILS, (s) => s.replace("cn(", "cx("), { utils: "major" }, "Rename cn to cx.")
  assert.equal(await ws.versionOf("utils"), "2.0.0")
  assert.equal(await ws.versionOf("button"), "1.1.0")
  assert.equal(await ws.versionOf("card"), "2.0.0")
  const button = await json(ws.out, "button/1.1.0.json")
  assert.deepEqual(button.meta.requires, { utils: "^2.0.0" })
})

test("npm version changes bump on their own: a new major is major, or minor when internal", async () => {
  const ws = await workspace()
  await ws.manifest((r) => {
    r.items[1].dependencies = ["@radix-ui/react-slot@1.2.3", "class-variance-authority@1.0.0"]
  })
  let { plan: p, errors } = await plan(ws)
  assert.deepEqual(errors, [])
  assert.deepEqual(
    p.filter((e) => e.from).map((e) => [e.name, e.to]),
    [["button", "2.0.0"]]
  )
  assert.match(p.find((e) => e.name === "button")?.reasons.join() ?? "", /class-variance-authority 0\.7\.1 → 1\.0\.0/)

  await ws.manifest((r) => {
    r.items[1].meta.internal = ["class-variance-authority"]
  })
  ;({ plan: p } = await plan(ws))
  assert.equal(p.find((e) => e.name === "button")?.to, "1.1.0")

  await ws.manifest((r) => {
    r.items[1].dependencies = ["@radix-ui/react-slot@1.2.4", "class-variance-authority@0.7.1"]
    delete r.items[1].meta.internal
  })
  ;({ plan: p } = await plan(ws))
  assert.equal(p.find((e) => e.name === "button")?.to, "1.0.1")

  await assert.rejects(ws.build(), /button: needs version 1\.0\.1 \(run `cscl-reg version`\)/)
  await ws.version()
  await ws.build()
  assert.ok(existsSync(path.join(ws.out, "button/1.0.1.json")))
})

test("a released version can never change", async () => {
  const ws = await workspace()
  await ws.manifest((r) => {
    r.items[0].meta.version = "1.0.1"
  })
  await ws.edit(UTILS, (s) => s + "\n// a\n")
  await ws.manifest((r) => {
    r.items[1].meta.version = "1.0.1"
    r.items[2].meta.version = "1.0.1"
  })
  await ws.build()
  await ws.edit(UTILS, (s) => s + "\n// b\n")
  await assert.rejects(ws.build(), /utils changed since 1\.0\.1 but has no changeset/)
})

test("meta.requires overrides the default caret range and is checked", async () => {
  const ws = await workspace()
  await ws.manifest((r) => {
    r.items[1].meta.requires = { utils: "~2.0.0" }
  })
  assert.match((await plan(ws)).errors.join(), /button: requires utils@~2\.0\.0 but utils is at 1\.0\.0/)
})

test("changeset files use the Changesets front matter", () => {
  const c = parseChangeset('---\nbutton: minor\n"card": patch\n---\n\nAdd a ghost variant.\n', "x.md")
  assert.deepEqual(c.bumps, { button: "minor", card: "patch" })
  assert.equal(c.summary, "Add a ghost variant.")
  assert.throws(() => parseChangeset("---\nbutton: huge\n---\n", "x.md"), /expected "item: patch\|minor\|major"/)
})

test("invalid manifests fail with every problem listed", async () => {
  const ws = await workspace()
  await ws.manifest((r) => {
    r.items.push({ name: "Bad Name", type: "ui", files: [{ path: "../x.ts", type: "registry:ui" }], meta: {} })
  })
  await assert.rejects(readSource(ws.root), (error) => {
    assert.match(error.message, /invalid name/)
    assert.match(error.message, /type must look like registry:ui/)
    assert.match(error.message, /meta\.version must look like 1\.2\.3/)
    assert.match(error.message, /file path must stay inside the repo/)
    return true
  })
})
