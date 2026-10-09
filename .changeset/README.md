# Changesets

One Markdown file per change, committed with the PR that makes it. The front matter says which
registry items change and how much; the text goes into each item's changelog.

```md
---
button: minor
---

Add a ghost variant.
```

Create one with `npm run changeset -- button:minor -m "Add a ghost variant."`. On merge to `main`,
CI turns pending changesets into versions (`cscl-reg version`), bumps dependents, snapshots the
releases and deploys the registry.
