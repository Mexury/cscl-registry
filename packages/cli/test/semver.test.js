// @ts-check
import assert from "node:assert/strict"
import { test } from "node:test"

import { resolve } from "../src/resolve.js"
import { bump, maxSatisfying, npmMajor, satisfies, splitPackage } from "../src/semver.js"

test("ranges", () => {
  assert.ok(satisfies("1.4.0", "^1.2.0"))
  assert.ok(!satisfies("2.0.0", "^1.2.0"))
  assert.ok(satisfies("0.2.9", "^0.2.1") && !satisfies("0.3.0", "^0.2.1"))
  assert.ok(satisfies("1.2.9", "~1.2.0") && !satisfies("1.3.0", "~1.2.0"))
  assert.ok(satisfies("1.9.9", "1") && satisfies("1.2.5", "1.2.x") && satisfies("3.0.0", "*"))
  assert.equal(maxSatisfying(["1.0.0", "1.2.0", "2.0.0"], ["^1.0.0", "~1.2.0"]), "1.2.0")
  assert.equal(bump("1.2.3", "minor"), "1.3.0")
  assert.throws(() => satisfies("1.0.0", ">=1 <2"), /Unsupported version range/)
})

test("npm specs", () => {
  assert.deepEqual(splitPackage("@radix-ui/react-slot@1.2.3"), { name: "@radix-ui/react-slot", version: "1.2.3" })
  assert.deepEqual(splitPackage("clsx"), { name: "clsx" })
  assert.equal(npmMajor("^9.4.0"), 9)
  assert.equal(npmMajor("latest"), undefined)
})

/** A fake registry from { id: { version: requires } }. @param {Record<string, Record<string, Record<string, string>>>} data */
function fake(data) {
  return /** @type {any} */ ({
    async versions(/** @type {string} */ id) {
      const versions = Object.entries(data[id]).map(([version, requires]) => ({ version, requires }))
      return { name: id, latest: versions.at(-1)?.version, versions }
    },
  })
}

test("the resolver explains conflicts between items it may not move", async () => {
  const registry = fake({
    "@x/utils": { "1.0.0": {}, "2.0.0": {} },
    "@x/a": { "1.0.0": { utils: "^1.0.0" } },
    "@x/b": { "1.0.0": { utils: "^1.0.0" }, "1.1.0": { utils: "^2.0.0" } },
  })
  const installed = new Map([["@x/utils", "1.0.0"], ["@x/a", "1.0.0"], ["@x/b", "1.0.0"]])
  await assert.rejects(
    resolve({ installed, requests: [{ id: "@x/b", range: "1.1.0" }, { id: "@x/a" }], registry }),
    /No version of @x\/utils works for everything installed:\n {2}@x\/a@1\.0\.0 needs @x\/utils@\^1\.0\.0\n {2}@x\/b@1\.1\.0 needs @x\/utils@\^2\.0\.0/
  )
  const chosen = await resolve({ installed, requests: [{ id: "@x/a" }], registry })
  assert.equal(chosen.get("@x/utils"), "1.0.0", "nothing moves when nothing has to")
})

test("item names from registry JSON cannot escape the registry folder", async () => {
  const registry = fake({ "@x/a": { "1.0.0": { "../../etc": "^1.0.0" } } })
  await assert.rejects(resolve({ installed: new Map(), requests: [{ id: "@x/a" }], registry }), /Invalid item: "@x\/..\/..\/etc"/)
})
