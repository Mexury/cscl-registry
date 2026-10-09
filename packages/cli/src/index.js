#!/usr/bin/env node
// @ts-check
import path from "node:path"
import { parseArgs } from "node:util"

import { readChangesets, writeChangeset } from "./changeset.js"
import { add, diff, init, list, outdated, remove, update } from "./consumer.js"
import { applyVersions, build, planVersions, readSource } from "./source.js"

const HELP = `cscl-reg: a shadcn registry with per-item versions

In the registry repo:
  cscl-reg changeset <item:patch|minor|major...> -m <summary>
  cscl-reg check                       validate, print the release plan, fail on unversioned changes
  cscl-reg version                     apply changesets and dependency bumps to registry.json
  cscl-reg build [--out public/r]      snapshot new versions into releases/, write the served files

In an app (reads components.json, writes components.lock.json):
  cscl-reg init --registry <url> [--namespace @cscl]
  cscl-reg list
  cscl-reg add <item[@version|@range]...> [--major] [--dry-run] [--overwrite] [--no-install]
  cscl-reg outdated
  cscl-reg update [item...] [--to <version>] [--major] [--dry-run] [--no-install]
  cscl-reg diff <item> [--upstream [--to <version>]]
  cscl-reg remove <item...> [--force]
`

/** @param {string[]} argv */
async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      message: { type: "string", short: "m" },
      out: { type: "string", default: "public/r" },
      registry: { type: "string" },
      namespace: { type: "string" },
      to: { type: "string" },
      major: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      overwrite: { type: "boolean", default: false },
      "no-install": { type: "boolean", default: false },
      upstream: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      cwd: { type: "string", default: process.cwd() },
      help: { type: "boolean", short: "h", default: false },
    },
  })
  const [command, ...rest] = positionals
  const cwd = path.resolve(values.cwd)
  const install = !values["no-install"]

  switch (command) {
    case "changeset": {
      /** @type {Record<string, any>} */
      const bumps = {}
      for (const arg of rest) {
        const [name, level] = arg.split(":")
        bumps[name] = level
      }
      const file = await writeChangeset(cwd, bumps, values.message ?? "")
      console.log(`wrote ${file}`)
      return
    }
    case "check": {
      const source = await readSource(cwd)
      const { plan, errors } = await planVersions(source, await readChangesets(cwd))
      const releases = plan.filter((e) => e.from !== e.to)
      for (const e of releases) {
        console.log(`${e.name}: ${e.from ?? "new"} → ${e.to}${e.level ? ` (${e.level})` : ""}`)
        for (const r of e.reasons) console.log(`    ${r.replace(/\s*\n+\s*/g, " ")}`)
      }
      if (!releases.length) console.log("no releases pending")
      if (errors.length) throw new Error(`Invalid registry:\n  - ${errors.join("\n  - ")}`)
      return
    }
    case "version":
      await applyVersions(cwd)
      return
    case "build":
      await build(cwd, { outDir: path.resolve(cwd, values.out) })
      return
    case "init":
      await init({ cwd, registry: values.registry, namespace: values.namespace })
      return
    case "list":
      await list({ cwd, namespace: values.namespace })
      return
    case "add": {
      const { conflicts } = await add(rest, { cwd, overwrite: values.overwrite, major: values.major, dryRun: values["dry-run"], install })
      if (conflicts.length) process.exitCode = 1
      return
    }
    case "outdated":
      await outdated({ cwd })
      return
    case "update": {
      const { conflicts } = await update(rest, { cwd, to: values.to, major: values.major, dryRun: values["dry-run"], install })
      if (conflicts.length) process.exitCode = 1
      return
    }
    case "diff":
      if (rest.length !== 1) throw new Error("Usage: cscl-reg diff <item> [--upstream [--to <version>]]")
      await diff(rest[0], { cwd, upstream: values.upstream, to: values.to })
      return
    case "remove":
      await remove(rest, { cwd, force: values.force })
      return
    default:
      console.log(HELP)
      if (command && command !== "help" && !values.help) process.exitCode = 1
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
