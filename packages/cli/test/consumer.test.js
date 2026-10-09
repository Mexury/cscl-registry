// @ts-check
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { test } from "node:test"

import { add, diff, init, outdated, remove, update } from "../src/consumer.js"
import { readLock } from "../src/lock.js"
import { parseJsonc, readProject, targetPath, transformImports } from "../src/project.js"
import { APP_BUTTON, APP_CARD, APP_UTILS, BUTTON, CARD, UTILS, silent, workspace } from "./helpers.js"

const GHOST = (/** @type {string} */ s) => s.replace('ghost: "hover:bg-accent', 'ghost: "hover:bg-muted')
const opts = (/** @type {string} */ cwd) => ({ cwd, install: false, log: silent })

test("add writes the item and its registry dependencies with imports rewritten, and locks them", async () => {
  const ws = await workspace()
  const logs = []
  await add(["button"], { cwd: ws.app, install: false, log: (m) => logs.push(m) })
  const button = await ws.read(APP_BUTTON)
  assert.match(button, /from "@\/lib\/utils"/)
  assert.doesNotMatch(button, /@\/registry/)
  assert.ok(existsSync(path.join(ws.app, APP_UTILS)))
  assert.match(logs.join("\n"), /npm packages to install: npm install --save-exact clsx@2\.1\.1 tailwind-merge@3\.3\.1 @base-ui\/react@1\.8\.0 class-variance-authority@0\.7\.1/)

  const lock = await readLock(ws.app)
  assert.equal(lock.items["@cscl/button"].version, "1.0.0")
  assert.equal(lock.items["@cscl/button"].direct, true)
  assert.equal(lock.items["@cscl/utils"].direct, undefined)
  assert.deepEqual(lock.items["@cscl/button"].requires, { "@cscl/utils": "^1.0.0" })
  assert.match(lock.items["@cscl/button"].files[APP_BUTTON], /^sha256-[0-9a-f]{64}$/)
})

test("add accepts a version or range and does not overwrite files it did not write", async () => {
  const ws = await workspace()
  await ws.release(BUTTON, GHOST, { button: "minor" })
  await add(["@cscl/button@1.0.0"], opts(ws.app))
  assert.doesNotMatch(await ws.read(APP_BUTTON), /hover:bg-muted/)

  await ws.write(APP_CARD, "// mine\n")
  await add(["card"], opts(ws.app))
  assert.equal(await ws.read(APP_CARD), "// mine\n")
  await assert.rejects(add(["button@2"], opts(ws.app)), /no version matches 2/)
})

test("update replaces untouched files, merges your edits, and can go back", async () => {
  const ws = await workspace()
  await add(["button"], opts(ws.app))
  await ws.write(APP_BUTTON, (await ws.read(APP_BUTTON)).replace('size: "default",\n    },', 'size: "lg",\n    },'))
  await ws.release(BUTTON, GHOST, { button: "minor" }, "Softer ghost hover.")

  const rows = await outdated({ cwd: ws.app, log: silent })
  assert.deepEqual(rows.find((r) => r.id === "@cscl/button"), { id: "@cscl/button", installed: "1.0.0", wanted: "1.1.0", latest: "1.1.0", edited: true })

  const { conflicts } = await update(["button"], opts(ws.app))
  assert.deepEqual(conflicts, [])
  const merged = await ws.read(APP_BUTTON)
  assert.match(merged, /hover:bg-muted/, "upstream change applied")
  assert.match(merged, /size: "lg"/, "local edit kept")
  assert.equal((await readLock(ws.app)).items["@cscl/button"].version, "1.1.0")

  await update(["button"], { ...opts(ws.app), to: "1.0.0" })
  const back = await ws.read(APP_BUTTON)
  assert.doesNotMatch(back, /hover:bg-muted/)
  assert.match(back, /size: "lg"/)
})

test("overlapping edits leave conflict markers and report the file", async () => {
  const ws = await workspace()
  await add(["button"], opts(ws.app))
  await ws.write(APP_BUTTON, (await ws.read(APP_BUTTON)).replace('ghost: "hover:bg-accent', 'ghost: "hover:bg-red-500'))
  await ws.release(BUTTON, GHOST, { button: "minor" })
  const { conflicts } = await update(["button"], opts(ws.app))
  assert.deepEqual(conflicts, [APP_BUTTON])
  assert.match(await ws.read(APP_BUTTON), /<<<<<<< yours[\s\S]*>>>>>>> @cscl\/button@1\.1\.0/)
})

test("updating an item moves its dependencies along, and a new major needs --major", async () => {
  const ws = await workspace()
  await add(["button", "card"], opts(ws.app))
  await ws.release(UTILS, (s) => s.replace("cn(", "cx("), { utils: "major" }, "Rename cn to cx.")
  // utils 2.0.0, button 1.1.0 and card 1.1.0 now require utils ^2.0.0.

  await assert.rejects(update(["button"], opts(ws.app)), /new major version:\n {2}@cscl\/utils 1\.0\.0 → 2\.0\.0/)
  const logs = []
  await update(["button"], { ...opts(ws.app), major: true, log: (m) => logs.push(m) })
  const lock = await readLock(ws.app)
  assert.equal(lock.items["@cscl/button"].version, "1.1.0")
  assert.equal(lock.items["@cscl/utils"].version, "2.0.0")
  assert.equal(lock.items["@cscl/card"].version, "1.1.0", "card follows so it still gets a utils it accepts")
  assert.match(await ws.read(APP_UTILS), /cx\(/)
  assert.match(logs.join("\n"), /@cscl\/card 1\.0\.0 → 1\.1\.0 \(to keep its dependents working\)/)

  // Going back to utils 1.x takes button and card back with it.
  await update(["utils"], { ...opts(ws.app), to: "1.0.0", major: true })
  const after = await readLock(ws.app)
  assert.equal(after.items["@cscl/utils"].version, "1.0.0")
  assert.equal(after.items["@cscl/button"].version, "1.0.0")
  assert.equal(after.items["@cscl/card"].version, "1.0.0")
})

test("update with no names updates everything within its major, and --dry-run writes nothing", async () => {
  const ws = await workspace()
  await add(["button"], opts(ws.app))
  await ws.release(BUTTON, GHOST, { button: "minor" })
  const before = await ws.read(APP_BUTTON)
  const { changes } = await update([], { ...opts(ws.app), dryRun: true })
  assert.deepEqual(changes, [["@cscl/button", "1.1.0"]])
  assert.equal(await ws.read(APP_BUTTON), before)
  await update([], opts(ws.app))
  assert.match(await ws.read(APP_BUTTON), /hover:bg-muted/)
})

test("diff shows your edits, or with --upstream what the registry changed", async () => {
  const ws = await workspace()
  await add(["button"], opts(ws.app))
  await ws.write(APP_BUTTON, (await ws.read(APP_BUTTON)) + "// mine\n")
  await ws.release(BUTTON, GHOST, { button: "minor" })
  const mine = await diff("button", { cwd: ws.app, log: silent })
  assert.match(mine, /\+\/\/ mine/)
  assert.doesNotMatch(mine, /hover:bg-muted/)
  const upstream = await diff("button", { cwd: ws.app, upstream: true, log: silent })
  assert.match(upstream, /\+.*hover:bg-muted/)
  assert.match(upstream, /--- @cscl\/button@1\.0\.0\/src\/components\/ui\/button\.tsx/)
})

test("remove deletes untouched files and refuses while something depends on it", async () => {
  const ws = await workspace()
  await add(["button"], opts(ws.app))
  await assert.rejects(remove(["utils"], { cwd: ws.app, log: silent }), /used by @cscl\/button/)
  await ws.write(APP_BUTTON, "// edited\n")
  await assert.rejects(remove(["button"], { cwd: ws.app, log: silent }), /was edited/)
  await remove(["button"], { cwd: ws.app, force: true, log: silent })
  assert.ok(!existsSync(path.join(ws.app, APP_BUTTON)))
  assert.deepEqual(Object.keys((await readLock(ws.app)).items), ["@cscl/utils"])
})

test("init adds the namespace; remote registries get headers and params with env expansion", async () => {
  const ws = await workspace()
  /** @type {import("node:http").IncomingMessage[]} */
  const seen = []
  const server = createServer(async (req, res) => {
    seen.push(req)
    const file = path.join(ws.out, decodeURIComponent(new URL(req.url ?? "", "http://x").pathname))
    try {
      res.end(await readFile(file))
    } catch {
      res.statusCode = 404
      res.end()
    }
  })
  await new Promise((done) => server.listen(0, () => done(undefined)))
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address())
  try {
    await init({ cwd: ws.app, registry: `http://127.0.0.1:${port}/`, namespace: "@remote", log: silent })
    const config = JSON.parse(await readFile(path.join(ws.app, "components.json"), "utf8"))
    assert.equal(config.registries["@remote"], `http://127.0.0.1:${port}/{name}.json`)
    config.registries["@remote"] = { url: config.registries["@remote"], headers: { Authorization: "Bearer ${TOKEN}" }, params: { v: "${V:-1}" } }
    await writeFile(path.join(ws.app, "components.json"), JSON.stringify(config))

    await assert.rejects(add(["@remote/card"], opts(ws.app)), /needs TOKEN/)
    await add(["@remote/card"], { ...opts(ws.app), env: { TOKEN: "t0k" } })
    assert.ok(existsSync(path.join(ws.app, APP_CARD)))
    assert.equal(seen[0].headers.authorization, "Bearer t0k")
    assert.match(seen[0].url ?? "", /\?v=1$/)
  } finally {
    server.close()
  }
})

test("targets follow tsconfig paths and file types; nothing may land outside the project", async () => {
  const ws = await workspace()
  const project = await readProject(ws.app)
  assert.equal(targetPath(project, { path: "registry/default/ui/button.tsx", type: "registry:ui" }, "x"), APP_BUTTON)
  assert.equal(targetPath(project, { path: "registry/default/hooks/use-x.ts", type: "registry:hook" }, "x"), "src/hooks/use-x.ts")
  assert.equal(targetPath(project, { path: "registry/default/blocks/login.tsx", type: "registry:block" }, "x"), "src/components/login.tsx")
  assert.equal(targetPath(project, { path: "a/page.tsx", type: "registry:page", target: "~/app/login/page.tsx" }, "x"), "app/login/page.tsx")
  assert.throws(() => targetPath(project, { path: "x", type: "registry:file", target: "../../etc/passwd" }, "x"), /outside the project/)
  assert.throws(() => targetPath(project, { path: "x", type: "registry:file" }, "x"), /needs a "target"/)

  const aliases = { components: "~/components", utils: "~/lib/utils", ui: "~/components/ui", lib: "~/lib", hooks: "~/hooks" }
  assert.equal(
    transformImports('import { cn } from "@/registry/default/lib/utils"\nimport { B } from "@/registry/default/ui/b"\nimport x from "@/lib/utils"\nimport y from "@/components/y"', aliases),
    'import { cn } from "~/lib/utils"\nimport { B } from "~/components/ui/b"\nimport x from "~/lib/utils"\nimport y from "~/components/y"'
  )
  assert.deepEqual(parseJsonc('{ "$schema": "https://x.dev/a", /* c */ "a": [1,], // d\n }'), { $schema: "https://x.dev/a", a: [1] })
})
