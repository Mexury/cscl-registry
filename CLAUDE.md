# CLAUDE.md

A shadcn registry with per-item versions. `README.md` describes the formats, bump rules and CLI;
read it before changing either.

## Commands

```bash
npm test           # node --test, no install needed
npm run check      # validate, print the release plan
npm run build      # snapshot new versions into releases/, write public/r (gitignored)
```

## Rules

- Items live in `registry.json` (shadcn schema) with `meta.version`; sources in `registry/default/`,
  imports between items via `@/registry/default/...`.
- Every change to an item needs a changeset in `.changeset/` (`npm run changeset -- item:level -m "..."`).
  CI versions and releases on merge; do not hand-bump dependents.
- Never edit an existing file in `releases/` or anything in `public/`.
- CLI: zero runtime dependencies, plain ESM JavaScript with `// @ts-check` + JSDoc, Node ≥ 22.
  Registry JSON comes from the network: keep the name checks and the write-outside-project guard.
- Every behavior change gets a test in `packages/cli/test/`.
