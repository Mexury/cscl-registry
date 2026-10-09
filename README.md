# CSCL Registry

A [shadcn registry](https://ui.shadcn.com/docs/registry) with real versions. Every item has its own
semver version, every release stays downloadable forever, versions bump themselves when a
dependency changes, and apps can upgrade or downgrade items without losing their local edits.

Plain `npx shadcn add` keeps working. The `cscl-reg` CLI in [`packages/cli`](packages/cli) adds what
shadcn does not have: versions, a lockfile, `outdated`, `update`, `diff` and a resolver.

## How it works

```
registry.json + registry/          source of truth: shadcn items, each with meta.version
.changeset/*.md                    one per PR: "button: minor" + a summary
releases/<item>/<version>.json     immutable snapshot of every released version (committed)
releases/<item>/CHANGELOG.md       written by `cscl-reg version`
public/r/                          what is served (built by CI, not committed)
```

Served files, at `https://mexury.github.io/cscl-registry/r/`:

| URL | Content |
| --- | --- |
| `r/button.json` | Latest version of `button` |
| `r/button/1.2.0.json` | That exact version, never changed |
| `r/button/versions.json` | All versions with their requirements and changelog notes |
| `r/registry.json` | Index of the latest items |

Every served file is a valid shadcn registry item. Inside a release, `registryDependencies` point at
exact versioned URLs (`r/utils/1.1.0.json`), so the same install command gives the same files a year
later. `meta.version`, `meta.requires` (`{ "utils": "^1.1.0" }`) and `meta.pins` carry the version
data `cscl-reg` uses.

## Changing an item

1. Edit the files in `registry/` (imports between items use `@/registry/default/...`).
2. Add a changeset: `npm run changeset -- button:minor -m "Add a ghost variant."`
3. Open a PR. CI runs the tests and `cscl-reg check`, which fails if a changed item has no
   changeset and prints the versions the PR will release.
4. On merge, CI runs `cscl-reg version` and `cscl-reg build`, commits the new versions, snapshots
   and changelogs to `main`, and deploys `public/` to GitHub Pages.

New item: add it to `registry.json` with `"meta": { "version": "1.0.0" }` (or `0.1.0`). Its first
release needs no changeset.

### Bump rules

| Change | Bump |
| --- | --- |
| The item's own files, dependency list or CSS changed | What the changeset says (a changeset is required) |
| An npm dependency gets a new major (`react-day-picker` 8 → 9) | Major, automatically; minor if the package is in `meta.internal` |
| An npm dependency gets a minor or patch | Patch, automatically |
| A registry dependency gets a new major | Minor, or major if the item re-exports it |
| A registry dependency gets a minor or patch | Patch (its pin changes) |

The last two rows apply recursively, so a change to `utils` reaches everything built on it.

"Re-exports" is detected from `export ... from "<dependency module>"` in the item's files, or set
with `"meta": { "exposes": ["utils"] }`. A dependent's default requirement is `^<pinned version>`;
override it with `"meta": { "requires": { "utils": "~1.2.0" } }`.

## Using it in an app

The app needs a `components.json` (from `npx shadcn@latest init`). Run the CLI from a checkout
until it is published to npm:

```bash
node <checkout>/packages/cli/src/index.js init --registry https://mexury.github.io/cscl-registry/r
```

That adds `"@cscl": "https://mexury.github.io/cscl-registry/r/{name}.json"` to `components.json`, so
both of these work:

```bash
npx shadcn@latest add @cscl/button      # plain shadcn: latest, no lockfile
cscl-reg add button                     # same files, plus components.lock.json
```

| Command | What it does |
| --- | --- |
| `cscl-reg add button card@1.0.0 @cscl/x@^2` | Installs items and their registry dependencies, installs exact npm versions, writes `components.lock.json` |
| `cscl-reg outdated` | Installed, newest in the same major, newest overall, edited locally |
| `cscl-reg update [items]` | Moves items to the newest version in their major. Dependencies (and dependents, if they must) move along |
| `cscl-reg update button --major` | Allows new majors, for the item or anything that has to move with it |
| `cscl-reg update button --to 1.0.0` | Any exact version, up or down |
| `cscl-reg diff button` | Your edits since install. `--upstream` shows what the registry changed instead |
| `cscl-reg remove button` | Deletes untouched files; refuses while another item needs it |

`add` and `update` take `--dry-run` to print the plan, and `--no-install` to print the npm command
instead of running it.

**How updates keep your edits.** The lockfile stores a hash of every file as installed. Untouched
files are replaced. Edited files get a three-way merge (`git merge-file`) between the installed
version, your file and the new version; overlapping edits get standard conflict markers and the
command exits with code 1.

**One version per item.** Items are copied to fixed paths, so a project holds one version of each.
The resolver picks versions that satisfy every installed item's `meta.requires`, moves dependents
when it has to (within their major unless `--major`), and otherwise explains the conflict.

## Setup still needed

- **GitHub Pages:** Settings → Pages → Source: GitHub Actions. The first push to `main` deploys.
- **Branch protection:** if you protect `main`, allow GitHub Actions to push, or the release
  commit fails.

## Limits

- `cscl-reg` writes files and npm dependencies only. Items with `cssVars` or `css` print a note;
  apply those with `npx shadcn add` for now.
- Ranges support `1.2.3`, `^`, `~`, `1.x` and `*`.
- Registry dependencies are versioned within this registry. Items from other registries are passed
  through unversioned.

## Develop

```bash
npm test          # node --test, zero dependencies
npm run check     # validate and print the release plan
npm run build     # build public/r locally
```

Background: [research spec](https://claude.ai/code/artifact/b6af0938-7681-4ccd-bbe9-e1e691911bd7).
