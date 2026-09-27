# CI

`.github/workflows/ci.yml` runs on every push to `main` and every pull request targeting `main`.

| Job        | Runs on                     | What it does                                                                                                                                      |
| ---------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quality    | ubuntu                      | `npm run check` (ESLint + `tsc --noEmit`), `npm run format:check` (Prettier), advisory `npm audit`                                                |
| Test       | ubuntu, macOS, Windows      | `npm run test:coverage` (Vitest unit tests + v8 coverage). Ubuntu uploads the HTML coverage report and writes a coverage table to the job summary |
| Build VSIX | ubuntu (pull requests only) | `npm run compile` + `vsce package`, uploads the `.vsix` as an artifact                                                                            |

Every job has a 10-minute timeout.

The OS matrix exists because the extension ships on all three platforms and some code is platform-specific (IPC uses a Unix socket on macOS/Linux and a named pipe on Windows — see `src/pool-server/ipc-path.ts`).

## Not in CI

- **Integration tests** (`npm run test:api`) call real backends and need API keys or a Claude subscription.
- **Quality evals** (`npm run test:quality`) generate completions from real models and are judged in a second, LLM-as-judge step. Results from these runs are summarized in `evals/`.

Run both locally; see AGENTS.md → Testing.
