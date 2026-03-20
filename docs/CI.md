# CI Pipeline Spec

## Why

Bespoke AI has no CI pipeline. Code quality is enforced only by local pre-commit hooks (Husky + lint-staged). If hooks are bypassed or a contributor doesn't have them set up, broken code can land on main unchecked.

The pipeline should:

1. Catch regressions before they hit main
2. Enforce the same checks the pre-commit hooks already run
3. Gate merges via branch protection rules

## What to Build

### Workflow: `ci.yml`

Triggers on push to `main` and pull requests targeting `main`.

All jobs run on `ubuntu-latest`. Node version pinned to `20` (Vitest 4 requires Node 20+; the esbuild `target: 'node18'` controls output syntax, not the CI runtime). Dependencies installed with `npm ci`.

### Jobs

**1. `quality` — Static analysis (fast, runs first)**

- Type checking + linting (`npm run check`)
- Format checking (`npm run format:check`)

Depends on: nothing (starts immediately)

**2. `test` — Unit tests**

- `npm run test:unit` (Vitest)

Depends on: nothing (runs in parallel with `quality`)

### Job dependency graph

```
push/PR
  ├── quality
  └── test
```

Both jobs start immediately in parallel. Simple and fast.

### What NOT to include

- **API tests** (`npm run test:api`) — these hit real AI backends (xAI, OpenAI, Anthropic, etc.) and require API keys. Meant for targeted local runs, not CI.
- **Quality tests** (`npm run test:quality`) — these hit AI APIs for LLM-as-judge evaluation. Local only.
- **VSIX packaging/publishing** — handled separately. CI is about verification, not deployment.
- **Matrix testing** — this is a VS Code extension targeting a known Node version, not a library.

### Action versions

- `actions/checkout@v4`
- `actions/setup-node@v4` (with `node-version: '20'`, `cache: 'npm'`)

### Security

- Top-level `permissions: contents: read` (least privilege)
- No secrets needed beyond `GITHUB_TOKEN`

## Branch protection

Set up a branch ruleset on `main` in GitHub repo settings:

- Require a pull request before merging
- Require status checks to pass: `Quality`, `Test`
- Block force pushes
- Restrict deletions
