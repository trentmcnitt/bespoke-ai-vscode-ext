# AI Code Completion Feature Map

_Comprehensive landscape analysis — February 1 2026_

This document maps every significant AI code completion product and their features against Bespoke AI's current capabilities for gap analysis and roadmap planning. Star counts, pricing, and feature details are approximate as of the date above. See `ROADMAP.md` for prioritization decisions informed by this analysis.

---

## Table of Contents

1. [Bespoke AI Current State](#bespoke-ai-current-state)
2. [Feature Matrix: Inline Completion](#feature-matrix-inline-completion)
3. [Feature Matrix: Chat & Agent](#feature-matrix-chat--agent)
4. [Feature Matrix: Developer Workflow](#feature-matrix-developer-workflow)
5. [Feature Matrix: Context & Intelligence](#feature-matrix-context--intelligence)
6. [Feature Matrix: Privacy & Deployment](#feature-matrix-privacy--deployment)
7. [Closed-Source Products (Detailed)](#closed-source-products-detailed)
8. [Open-Source Projects (Detailed)](#open-source-projects-detailed)
9. [Gap Analysis: Bespoke AI vs Field](#gap-analysis-bespoke-ai-vs-field)
10. [Market Observations](#market-observations)

---

## Bespoke AI Current State

| Feature                         | Status                                              |
| ------------------------------- | --------------------------------------------------- |
| Inline completions (ghost text) | Yes — single-line and multi-line                    |
| Fill-in-the-Middle (FIM)        | Yes (Claude Code uses hole marker)                  |
| Prose mode                      | Yes — auto-detects prose vs code by languageId      |
| Backend                         | Claude Code CLI (single backend)                    |
| Partial accept (word-by-word)   | Yes (built into VS Code — no extension work needed) |
| Next edit suggestions           | No                                                  |
| Chat                            | No                                                  |
| Agent mode                      | No                                                  |
| Code actions / lightbulb        | No                                                  |
| Code review                     | No                                                  |
| Terminal integration            | No                                                  |
| Commit message generation       | Yes (via Claude Code CLI)                           |
| Test generation                 | No                                                  |
| Documentation generation        | Partial (works via inline completion on `/**`)      |
| Rename suggestions              | No                                                  |
| Context from open tabs          | No (planned)                                        |
| Workspace indexing              | No                                                  |
| Custom instructions file        | No (uses CLAUDE.md differently)                     |
| MCP support                     | No                                                  |
| Vision / image input            | No                                                  |
| Post-processing pipeline        | Yes (prefix/suffix overlap trimming)                |
| LRU cache                       | Yes (50 entries, 5-min TTL)                         |
| Debouncing                      | Yes (300ms, AbortSignal-aware)                      |
| Profiles                        | Yes (named config presets with deep merge)          |
| Usage tracking                  | Yes (per-session counts + character tracking)       |
| Benchmarking                    | Yes (automated parameter sweep + LLM-as-judge)      |

---

## Feature Matrix: Inline Completion

The core autocomplete experience — ghost text suggestions as you type.

| Product              | Open Source | Ghost Text            | Multi-line          | FIM | Partial Accept | NES / Next Edit            | Syntax Highlight | Snooze |
| -------------------- | ----------- | --------------------- | ------------------- | --- | -------------- | -------------------------- | ---------------- | ------ |
| **Bespoke AI**       | No          | Yes                   | Yes                 | Yes | Yes (built-in) | No                         | Yes (built-in)   | No     |
| **GitHub Copilot**   | No          | Yes                   | Yes                 | Yes | Yes (word)     | Yes (GA)                   | Yes              | Yes    |
| **Cursor**           | No          | Yes                   | Yes (multi-edit)    | Yes | Yes (word)     | Yes (jump in/across files) | Yes              | No     |
| **Windsurf/Codeium** | No          | Yes (Supercomplete)   | Yes                 | Yes | —              | No                         | —                | —      |
| **Tabnine**          | No          | Yes                   | Yes (full function) | Yes | —              | No                         | —                | —      |
| **Amazon Q**         | No          | Yes                   | Yes                 | Yes | —              | No                         | —                | —      |
| **JetBrains AI**     | No          | Yes (+local)          | Yes                 | Yes | —              | Yes (GA)                   | —                | —      |
| **Sourcegraph Cody** | Partial     | Yes                   | Yes                 | Yes | —              | No                         | —                | —      |
| **Google Gemini**    | No          | Yes                   | Yes                 | Yes | —              | Yes (Preview)              | —                | —      |
| **Augment Code**     | No          | Yes                   | Yes                 | —   | —              | No                         | —                | —      |
| **Qodo**             | No          | Yes                   | —                   | —   | —              | No                         | —                | —      |
| **Blackbox AI**      | No          | Yes                   | Yes                 | —   | —              | No                         | —                | —      |
| **Zencoder**         | No          | Yes (unlimited)       | —                   | —   | —              | No                         | —                | —      |
| **aiXcoder**         | Partial     | Yes (local)           | —                   | —   | —              | No                         | —                | —      |
| **Continue.dev**     | Yes         | Yes                   | Yes                 | Yes | Yes (word)     | No                         | —                | —      |
| **Tabby**            | Yes         | Yes                   | Yes                 | Yes | —              | No                         | —                | —      |
| **Twinny**           | Yes         | Yes                   | Yes                 | Yes | —              | No                         | —                | —      |
| **llama.vscode**     | Yes         | Yes                   | Yes                 | Yes | —              | No                         | —                | —      |
| **llm-vscode (HF)**  | Yes         | Yes                   | —                   | Yes | —              | No                         | —                | —      |
| **Refact.ai**        | Yes         | Yes (RAG)             | Yes                 | Yes | —              | No                         | —                | —      |
| **CodeGeeX**         | Partial     | Yes                   | —                   | —   | —              | No                         | —                | —      |
| **Kilo Code**        | Yes         | Yes                   | —                   | —   | —              | No                         | —                | —      |
| **Void**             | Yes         | Yes                   | Yes                 | Yes | —              | No                         | —                | —      |
| **Zed (Zeta)**       | Yes         | Yes (edit prediction) | Yes                 | Yes | —              | Partial (Zeta model)       | —                | —      |

`—` = unconfirmed / not publicly documented. `No` = confirmed absent.

**Key takeaway:** NES is the rarest and most differentiating feature. Only Copilot, Cursor, JetBrains AI, and Google Gemini have it. Partial accept and syntax-highlighted ghost text are built into VS Code itself — extensions get them for free.

---

## Feature Matrix: Chat & Agent

| Product            | Sidebar Chat  | Inline Chat | Agent Mode                | MCP Support        | Multi-Model      |
| ------------------ | ------------- | ----------- | ------------------------- | ------------------ | ---------------- |
| **Bespoke AI**     | No            | No          | No                        | No                 | No (Claude Code) |
| **GitHub Copilot** | Yes           | Yes         | Yes (+ coding agent)      | Yes                | Yes (10+ models) |
| **Cursor**         | Yes           | Yes (Cmd+K) | Yes (+ background agents) | Yes                | Yes              |
| **Windsurf**       | Yes (Cascade) | —           | Yes (3 modes)             | Yes                | Yes (BYOK)       |
| **Tabnine**        | Yes           | —           | Yes (5 agents)            | Yes                | Yes              |
| **Amazon Q**       | Yes           | —           | Yes                       | Yes                | Limited          |
| **JetBrains AI**   | Yes           | —           | Yes (Junie)               | Yes (+ MCP server) | Yes              |
| **Sourcegraph**    | Yes           | —           | Yes (Amp)                 | —                  | Yes              |
| **Google Gemini**  | Yes           | —           | Yes                       | —                  | No (Gemini only) |
| **OpenAI Codex**   | Yes           | —           | Yes (cloud agent)         | No                 | Limited          |
| **Augment Code**   | Yes           | —           | Yes                       | —                  | Yes              |
| **Cline**          | Yes           | —           | Yes (Plan/Act)            | Yes                | Yes (any)        |
| **Roo Code**       | Yes           | —           | Yes (multi-role)          | Yes                | Yes (any)        |
| **Kilo Code**      | Yes           | —           | Yes (orchestrator)        | Yes                | Yes (500+)       |
| **Continue.dev**   | Yes           | —           | Yes                       | Yes                | Yes (any)        |
| **Aider**          | Yes (CLI)     | —           | Yes                       | —                  | Yes (any)        |
| **Void**           | Yes           | —           | Yes                       | —                  | Yes              |
| **Zed**            | Yes           | —           | Yes                       | Yes                | Yes              |

---

## Feature Matrix: Developer Workflow

| Product            | Commit Messages | Code Review      | Test Gen       | Doc Gen       | Rename Suggest | Terminal    |
| ------------------ | --------------- | ---------------- | -------------- | ------------- | -------------- | ----------- |
| **Bespoke AI**     | Yes             | No               | No             | Partial       | No             | No          |
| **GitHub Copilot** | Yes             | Yes (PR)         | Yes            | Yes           | Yes (F2)       | Yes (CLI)   |
| **Cursor**         | Via agent       | Via agent        | Via agent      | Via agent     | No             | Yes         |
| **Windsurf**       | Via Cascade     | No               | Via Cascade    | Via Cascade   | No             | Via Cascade |
| **Tabnine**        | Via agent       | Yes (140+ rules) | Yes (agent)    | Yes (agent)   | No             | Yes         |
| **Amazon Q**       | Via chat        | Yes (SAST/SCA)   | Yes            | Yes           | No             | Yes (CLI)   |
| **JetBrains AI**   | Yes             | Via chat         | Yes            | Yes           | IDE-integrated | Yes         |
| **Google Gemini**  | Via chat        | No               | Yes            | Yes (Outline) | No             | Cloud Shell |
| **Augment Code**   | Via agent       | Yes              | Via agent      | Via agent     | No             | —           |
| **Qodo**           | Via agent       | **Yes (core)**   | **Yes (core)** | Yes           | No             | —           |
| **Bito AI**        | No              | **Yes (core)**   | Yes            | No            | No             | No          |
| **Cline**          | Via agent       | Via agent        | Via agent      | Via agent     | No             | Yes         |
| **Aider**          | Yes (auto-git)  | No               | Via chat       | Via chat      | No             | Native      |

---

## Feature Matrix: Context & Intelligence

| Product            | Open Files   | Workspace Index                 | Custom Instructions                   | RAG/Embeddings | Vision       |
| ------------------ | ------------ | ------------------------------- | ------------------------------------- | -------------- | ------------ |
| **Bespoke AI**     | No (planned) | No                              | No                                    | No             | No           |
| **GitHub Copilot** | Yes (tabs)   | Yes (@workspace)                | Yes (.github/copilot-instructions.md) | Yes            | Yes          |
| **Cursor**         | Yes          | Yes (200K+ tokens)              | Yes (.cursorrules)                    | Yes            | Yes          |
| **Windsurf**       | Yes          | Yes (multi-repo)                | Yes (.windsurfrules)                  | Yes            | —            |
| **Tabnine**        | Yes          | Yes (Enterprise Context Engine) | Yes (admin guidelines)                | Yes            | Yes (Figma)  |
| **Amazon Q**       | Yes          | Yes (private codebase)          | Yes (customization profiles)          | Yes            | No           |
| **JetBrains AI**   | Yes          | Yes (project analysis)          | Yes (.aiignore)                       | —              | Yes (images) |
| **Sourcegraph**    | Yes          | Yes (code graph)                | Yes                                   | Yes            | No           |
| **Continue.dev**   | Yes          | Yes (@codebase)                 | Yes (.continuerules)                  | Yes            | —            |
| **Tabby**          | Yes          | Yes (repo-level RAG)            | —                                     | Yes            | No           |
| **Refact.ai**      | Yes          | Yes (RAG)                       | —                                     | Yes            | No           |
| **Twinny**         | Yes          | Yes (workspace embeddings)      | —                                     | Yes            | No           |

---

## Feature Matrix: Privacy & Deployment

| Product            | Type         | Fully Local        | Self-Host      | Air-Gapped | No Telemetry        | License     |
| ------------------ | ------------ | ------------------ | -------------- | ---------- | ------------------- | ----------- |
| **Bespoke AI**     | Extension    | No                 | N/A            | No         | Yes                 | Proprietary |
| **GitHub Copilot** | Extension    | No                 | No             | No         | No                  | Proprietary |
| **Cursor**         | IDE          | No                 | No             | No         | Opt-in Privacy Mode | Proprietary |
| **Windsurf**       | IDE + Ext    | Enterprise         | Enterprise VPC | Enterprise | Opt-in              | Proprietary |
| **Tabnine**        | Extension    | Yes (Local Mode)   | Yes (K8s)      | Yes        | Configurable        | Proprietary |
| **Amazon Q**       | Extension    | No                 | No             | No         | Opt-out             | Proprietary |
| **JetBrains AI**   | IDE Plugin   | Yes (local models) | No             | No         | Opt-in              | Proprietary |
| **Continue.dev**   | Extension    | Yes (Ollama)       | N/A            | Yes        | Yes                 | Apache 2.0  |
| **Tabby**          | Server + Ext | Yes                | Yes            | Yes        | Yes                 | Apache 2.0  |
| **Twinny**         | Extension    | Yes (Ollama)       | N/A            | Yes        | Yes                 | MIT         |
| **llama.vscode**   | Extension    | Yes (llama.cpp)    | N/A            | Yes        | Yes                 | MIT         |
| **llm-vscode**     | Extension    | Possible           | N/A            | Possible   | Yes                 | Apache 2.0  |
| **Refact.ai**      | Server + Ext | Yes (Docker)       | Yes            | Possible   | Yes                 | BSD-3       |
| **Void**           | IDE          | Yes (Ollama)       | N/A            | Yes        | Yes                 | Apache 2.0  |
| **Zed**            | Editor       | Yes (Ollama)       | N/A            | Yes        | —                   | GPL 3.0     |

---

## Closed-Source Products (Detailed)

### Tier 1: Major Players

#### GitHub Copilot (Microsoft/GitHub)

- **Pricing:** Free (2K completions/mo) | Pro $10/mo | Pro+ $39/mo | Business $19/user | Enterprise $39/user
- **IDEs:** VS Code, Visual Studio, JetBrains, Eclipse, Xcode, Neovim, CLI
- **Models:** Custom GPT-4o (completions), GPT-4.1/5.1/5-Codex, Claude Sonnet 4/Opus 4.5, Gemini 3 Pro
- **Unique:** NES with RL-trained model, coding agent (assigns issues), Copilot Autofix (security), Copilot Spaces, open-sourced inline AI pipeline (Nov 2025), all features consolidating into single extension

#### Cursor (Anysphere)

- **Pricing:** Hobby (free) | Pro $20/mo | Ultra $200/mo | Teams $40/user
- **IDEs:** Cursor IDE only (VS Code fork)
- **Models:** Cursor's Composer model (custom), GPT family, Claude family, Gemini family. Tab powered by Supermaven acquisition.
- **Unique:** Multi-edit Tab completions (modify/add/delete around cursor), background agents from Slack/issue trackers, Debug Mode, Plan Mode with Mermaid diagrams, browser sidebar for visual editing. Cursor 2.0 is agent-centric with parallel agents.

#### Windsurf / Codeium (acquired by OpenAI for ~$3B)

- **Pricing:** Free (25 credits/mo) | Pro $15/mo | Teams $30/user | Enterprise $60/user
- **IDEs:** Windsurf IDE, VS Code, JetBrains, Neovim, 40+ IDEs total
- **Models:** SWE-1 family (proprietary: mini/lite/full), BYOK for Claude/GPT
- **Unique:** Supercomplete (intent prediction beyond next line), Cascade (3 modes: Write/Chat/Turbo), Memories system, multi-repo awareness. Integration into OpenAI ecosystem expected through 2026.

#### Tabnine

- **Pricing:** Dev Preview (free) | Dev ~$39/mo | Enterprise (custom)
- **IDEs:** VS Code, JetBrains, Eclipse, Visual Studio. 9M+ VS Code installs.
- **Models:** Proprietary (trained on permissive OSS only), plus GPT-4o, Claude 4, Gemini, Llama 3, Mistral
- **Unique:** Full air-gapped deployment (Dell PowerEdge bundles), license conflict detection, Figma/diagram-to-code, Enterprise Context Engine, on-prem Kubernetes

#### Amazon Q Developer

- **Pricing:** Free (50 agentic requests/mo) | Pro $19/user/mo
- **IDEs:** VS Code, JetBrains, Visual Studio, Eclipse, CLI, macOS menubar
- **Models:** Amazon Bedrock FMs (Claude Sonnet 3.7/4)
- **Unique:** Code transformations (automated Java 8→17, language conversions), reference tracking with license info, SAST/SCA code review, multi-language NL support (9 languages), CLI completions for 250+ CLI tools. Also powers Kiro IDE.

#### JetBrains AI Assistant + Junie

- **Pricing:** AI Free ($0) | AI Pro ~$99/yr | AI Ultimate ~$249/yr
- **IDEs:** JetBrains only (all IDEs)
- **Models:** OpenAI, Anthropic, Google (cloud); Mellum, Qwen2.5, Codestral (local)
- **Unique:** NES (GA), deep IDE integration leveraging JetBrains code analysis/inspections/refactoring, built-in MCP server (other tools connect TO JetBrains), Junie agent unified into AI Chat, Mellum (own open-source completion model), local model support for completions

#### Sourcegraph Cody / Amp

- **Pricing:** Free | Pro $9/mo | Enterprise $59/user/mo
- **IDEs:** VS Code, Cursor, Windsurf, JetBrains, Neovim
- **Models:** Claude, GPT, Gemini, DeepSeek-V2, Mixtral
- **Unique:** Deep code search integration (Sourcegraph's core), multi-repo/monorepo context, non-code integrations (Jira, Notion). Free/Pro being sunsetted in favor of Amp (agentic tool).

#### Google Gemini Code Assist

- **Pricing:** Free | Standard ~$22.80/user/mo | Enterprise $75/user/mo
- **IDEs:** VS Code, JetBrains, Android Studio, Cloud Shell
- **Models:** Gemini 2.5 Pro, Gemini 2.5 Flash
- **Unique:** Next edit predictions (Preview), Outline feature (auto-documentation), inline diff view, deep Google Cloud integration

### Tier 2: Specialized / Emerging

#### OpenAI Codex

- **Pricing:** Via ChatGPT Plus $20/mo | Pro $200/mo | API pricing
- **IDEs:** ChatGPT web, Codex CLI, VS Code extension
- **Unique:** Cloud sandbox execution (internet disabled during runs), multi-task parallelism, works 7+ hours autonomously. Agent-only — no inline completions.

#### Augment Code

- **Pricing:** Free | Indie $20/mo | Standard/Max (team) | Enterprise (custom)
- **Models:** Claude Sonnet 4.5 (default), GPT-5
- **Unique:** Context Engine (live understanding of entire stack), real-time team synchronization, Memories feature, 70% win rate over Copilot in benchmarks

#### Poolside AI

- **Pricing:** Enterprise-only (5,000+ developer orgs)
- **Unique:** Custom model per customer (fine-tuned on their codebase), RLCEF training, Point model for sub-200ms completions, Malibu for complex tasks. Targets banks/defense. On-prem/air-gapped.

#### Qodo (formerly CodiumAI)

- **Pricing:** Free (75 PRs/mo) | Teams $30/user/mo | Enterprise (custom)
- **Unique:** Code review is primary focus (not completions), 140+ predefined review rules per language, auto-purge data within 48 hours. Gartner Magic Quadrant Visionary.

#### Bito AI

- **Pricing:** Free | Team $15/seat/mo | Enterprise $25/seat/mo
- **Unique:** Code review workflow focus, AI Architect (knowledge graph), self-hosted Enterprise option

#### Kiro (AWS)

- **Pricing:** Free (50 credits/mo) | Pro $20/mo | Power $200/mo
- **IDEs:** Kiro IDE only (Code-OSS fork)
- **Unique:** Spec-driven development (requirements.md → design.md → tasks.md), autonomous agent that works for days. Uses Claude 4 Sonnet.

#### Other Notable Products

- **Blackbox AI** — $1/mo, 300+ models, mobile apps (iOS/Android), image-to-code, voice coding
- **AskCodi** — $14.99/mo, multi-model (GPT-4.5, Claude 4, Gemini, Llama 4, Mistral, DeepSeek)
- **Pieces for Developers** — Free forever, 9-month context retention, cross-platform sync
- **Zencoder** — Unlimited autocomplete (free), Repo Grokking, 100+ MCP library, interop with Claude Code/Codex
- **aiXcoder** — ~$15/mo, fully local (7B model in 6GB RAM), enterprise codebase training

---

## Open-Source Projects (Detailed)

### Inline Completion Focused

#### Continue.dev — The leading open-source AI code assistant

- **Repo:** github.com/continuedev/continue | **Stars:** 26K+ | **License:** Apache 2.0
- **IDEs:** VS Code, JetBrains, CLI
- **Architecture:** Model-agnostic, connects to any LLM (Ollama, LM Studio, llama.cpp, OpenAI, Anthropic, etc.)
- **Features:** FIM autocomplete with configurable prompt templates, chat, agent (Plan/Act), @codebase RAG, custom rules (.continuerules), partial accept (word-by-word), slash commands, Continue Hub
- **Best for:** Teams wanting maximum model flexibility

#### Tabby — Best self-hosted server

- **Repo:** github.com/TabbyML/tabby | **Stars:** 32K+ | **License:** Apache 2.0
- **IDEs:** VS Code, JetBrains, Vim/Neovim
- **Architecture:** Self-hosted Rust server, Docker deployment, no DBMS dependency
- **Features:** Inline completion, Answer Engine (chat), inline chat, repo-level RAG, code browser, team management
- **Models:** CodeLlama, StarCoder2, Qwen, DeepSeek Coder
- **Best for:** Enterprise/team self-hosted deployment

#### llama.vscode — Best pure-local option

- **Repo:** github.com/ggml-org/llama.vscode | **Stars:** 2K+ | **License:** MIT
- **IDEs:** VS Code
- **Architecture:** Built by the llama.cpp team, auto-installs llama.cpp, runs GGUF models locally
- **Features:** FIM inline completion, chat panel, experimental agent mode with MCP, predefined model environments, HuggingFace model browser
- **Performance:** Qwen2.5-Coder-3B ~60 tok/s on Apple Silicon, 7B ~90 tok/s on RTX 4090
- **Best for:** Zero-cloud inline completions. Most comparable to Bespoke AI's use case.

#### Twinny — Lightweight local-first

- **Repo:** github.com/twinnydotdev/twinny | **Stars:** 3.6K | **License:** MIT
- **IDEs:** VS Code
- **Architecture:** Connects to Ollama, LM Studio, or any OpenAI-compatible API
- **Features:** Inline completion, chat sidebar, workspace embeddings (RAG), Symmetry P2P network, FIM support
- **Best for:** Simple, no-nonsense local completion. Closest in spirit to Bespoke AI.

#### llm-vscode (Hugging Face) — Lightweight HF integration

- **Repo:** github.com/huggingface/llm-vscode | **Stars:** 1.6K | **License:** Apache 2.0
- **IDEs:** VS Code
- **Architecture:** Uses llm-ls (Rust language server), connects to HF Inference API or custom endpoints
- **Features:** Ghost text completion, code attribution check (searches The Stack via Bloom filter)

#### Refact.ai — Self-hosted with fine-tuning

- **Repo:** github.com/smallcloudai/refact | **Stars:** 3.4K | **License:** BSD-3
- **IDEs:** VS Code, JetBrains
- **Architecture:** Self-hosted Rust server (Docker), RAG-powered completions
- **Features:** Unlimited RAG-aware completion, chat, agent, fine-tuning on your codebase, 25+ languages
- **Best for:** Teams wanting to fine-tune a completion model on their own code

#### CodeGeeX — Own model

- **Repo:** github.com/THUDM/CodeGeeX4 | **Stars:** 8K+ | **License:** Research
- **IDEs:** VS Code, JetBrains
- **Features:** Inline completion, code translation between languages, own 13B model
- **Best for:** Chinese AI ecosystem, research

### Agentic Tools (no inline completion)

#### Cline — Dominant open-source agent

- **Repo:** github.com/cline/cline | **Stars:** 57K+ | **License:** Apache 2.0
- **IDEs:** VS Code
- **Features:** Plan/Act modes, file editing, terminal commands, browser automation, MCP, cost tracking, .clinerules
- **No inline completions** — chat/agent only

#### Roo Code (Cline fork) — Multi-agent roles

- **Repo:** github.com/RooCodeInc/Roo-Code | **Stars:** 22K+ | **License:** Apache 2.0
- **Features:** Multi-role agents (Code/Architect/Debug/Ask), codebase indexing, VS Code Code Actions

#### Kilo Code (Cline/Roo fork) — Agent + inline completion

- **Repo:** github.com/Kilo-Org/kilocode | **Stars:** 15K+ | **License:** Apache 2.0
- **IDEs:** VS Code, JetBrains
- **Features:** Inline autocomplete + orchestrator mode + Memory Bank + voice prompting. Raised $8M.

#### Aider — Terminal pair programmer

- **Repo:** github.com/Aider-AI/aider | **Stars:** 30K+ | **License:** Apache 2.0
- **Features:** Multi-file editing, auto-git, repo mapping, 3 modes (Code/Architect/Ask), voice commands
- **No inline completions** — describe changes, review diffs

#### OpenHands — Cloud coding agent platform

- **Repo:** github.com/OpenHands/OpenHands | **Stars:** 50K+ | **License:** MIT
- **Features:** Autonomous agent, SDK for custom agents, Docker sandboxed execution

#### Goose (Block) — MCP-native agent

- **Repo:** github.com/block/goose | **Stars:** 15K+ | **License:** Apache 2.0
- **Features:** MCP-first architecture, CLI + desktop app, extensible via MCP servers

### IDE Forks

#### Void — Open-source Cursor alternative

- **Repo:** github.com/voideditor/void | **Stars:** 18K+ | **License:** Apache 2.0
- **Features:** Agent/Gather/Chat modes, inline completions with FIM, checkpoints, no middleman backend. Beta.

#### Aide (CodeStory) — LSP-driven agent IDE

- **Repo:** github.com/codestoryai/aide | **Stars:** 5K+ | **License:** Open source
- **Features:** Multi-file agent editing using LSP for context (definitions, references). Early stage.

#### Zed — Fastest editor with Zeta model

- **Repo:** github.com/zed-industries/zed | **Stars:** 55K+ | **License:** GPL 3.0
- **Features:** Zeta (open-source edit prediction model — predicts edits, not just completions), agent editing, real-time multiplayer, built from scratch in Rust. Not a VS Code extension.

### Neovim Ecosystem

| Plugin                 | Stars | Features                                                       | Notes                                             |
| ---------------------- | ----- | -------------------------------------------------------------- | ------------------------------------------------- |
| **avante.nvim**        | 12K+  | AI suggestions, ACP for Claude Code/Gemini CLI/Codex, Zen Mode | "Cursor for Neovim"                               |
| **codecompanion.nvim** | 6K+   | Chat, inline assistant, workflows, 15+ LLM adapters            | Most feature-rich Neovim AI plugin                |
| **copilot.lua**        | 3K+   | Ghost text, accept_word/accept_line, nvim-cmp integration      | Community Copilot wrapper (requires subscription) |

### Abandoned Projects

| Project    | Stars | Status                  | Superseded By                         |
| ---------- | ----- | ----------------------- | ------------------------------------- |
| FauxPilot  | 14K   | Unmaintained since 2023 | Tabby, llama.vscode                   |
| TurboPilot | 3.8K  | Archived Sep 2023       | llama.cpp ecosystem                   |
| Localpilot | —     | Abandoned               | llama.vscode, Twinny, Continue+Ollama |

---

## Gap Analysis: Bespoke AI vs Field

### What Bespoke AI Does

See the [Current State table](#bespoke-ai-current-state) for the full list. Notable capabilities relative to the field:

- **Prose mode auto-detection** — no other tool has this, but the practical advantage is mild.
- **Automated quality benchmarking** — LLM-as-judge parameter sweeps. Useful internally; closed-source products likely have similar QA.

### Already Free from VS Code (No Extension Work Needed)

| Feature                       | How                                                                                      | Since                      |
| ----------------------------- | ---------------------------------------------------------------------------------------- | -------------------------- |
| Partial accept (word-by-word) | Built into VS Code for all InlineCompletionItemProviders. `Cmd+Right` accepts next word. | VS Code 1.74+              |
| Syntax-highlighted ghost text | Built into VS Code. `editor.inlineSuggest.syntaxHighlightingEnabled` defaults to `true`. | VS Code 1.99+ (March 2025) |
| Accept next line              | `editor.action.inlineSuggest.acceptNextLine` command (no default keybinding)             | VS Code 1.74+              |

Optional: implement `handleDidPartiallyAcceptCompletionItem()` on your provider to track partial accepts for analytics, but the feature works without it.

### Gaps by Priority

#### Quick Wins (Low Effort)

| Feature                  | What's Needed                                                                        | Who Has It                                 |
| ------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------ |
| Snooze suggestions       | Temporary disable timer via status bar                                               | Copilot                                    |
| Custom instructions file | Read a project-level markdown file and inject into system prompt (see details below) | Copilot, Cursor, Windsurf, Continue, Cline |

#### Medium Effort

| Feature                        | What's Needed                                            | Who Has It                       | Roadmap Status |
| ------------------------------ | -------------------------------------------------------- | -------------------------------- | -------------- |
| Context from open tabs         | Expand context-builder to include neighboring open files | Copilot, Cursor, all major tools | Planned        |
| Code actions (lightbulb fixes) | Register a CodeActionProvider, send diagnostics to LLM   | Copilot, JetBrains AI            | Deferred       |
| Rename suggestions             | RenameProvider with AI-suggested names                   | Copilot                          | Deferred       |
| Test generation (command)      | Dedicated command that sends selection to LLM            | Copilot, Tabnine, Amazon Q       | Deferred       |

#### High Effort

| Feature                  | What's Needed                                     | Who Has It                                  |
| ------------------------ | ------------------------------------------------- | ------------------------------------------- |
| Chat (sidebar)           | Webview panel, conversation management, streaming | All major products                          |
| Terminal integration     | Terminal inline suggestions or terminal chat      | Copilot, Cursor, Amazon Q                   |
| Code review              | Diff analysis, inline comment rendering           | Copilot, Amazon Q, Tabnine, Qodo, Bito      |
| MCP support              | MCP client implementation, tool registry          | Copilot, Cursor, Windsurf, JetBrains, Cline |
| Workspace indexing / RAG | Embedding pipeline, vector store, retrieval       | Copilot, Cursor, Tabby, Continue            |

#### Very High Effort / Likely Impractical

| Feature               | Why It's Hard                                                                                  | Who Has It                                   |
| --------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Next Edit Suggestions | Requires custom RL-trained model + edit history tracking + multi-location ghost text rendering | Copilot, Cursor, JetBrains AI, Google Gemini |
| Agent mode            | Multi-step orchestration, tool use, terminal execution, iteration                              | Copilot, Cursor, Windsurf, Cline, etc.       |
| Vision / image input  | Multimodal model integration, image processing pipeline                                        | Copilot, Cursor, Tabnine, Blackbox           |

---

## Market Observations

### Industry Trends (February 2026)

1. **The agent era is here.** Nearly every product now offers autonomous agent mode. Differentiation has shifted from "can it complete code" to "can it solve complex multi-file engineering tasks."

2. **NES is the new moat.** Next Edit Suggestions remain rare (only 4 products) and require custom model training. This is the most impactful UX improvement for inline completions since Copilot launched.

3. **MCP is becoming table stakes.** Model Context Protocol support is spreading rapidly, enabling plugin-like extensibility for AI agents.

4. **Pricing converges at $15-20/mo** for individuals but diverges wildly at enterprise scale. Credit/usage-based models are replacing flat-rate plans.

5. **Consolidation is accelerating.** OpenAI acquired Windsurf ($3B). Cursor acquired Supermaven. AWS launched Kiro. The market is consolidating around well-funded players.

6. **VS Code itself is becoming the open-source AI editor.** GitHub Copilot Chat was open-sourced, and AI features are moving into VS Code core. This changes the landscape for all extensions.

7. **Privacy is a real market segment.** Tabnine, aiXcoder, Poolside target enterprises with air-gapped/on-prem deployment. Open-source tools (Tabby, llama.vscode, Twinny) serve individual privacy needs.

8. **Code review is emerging as a distinct category.** Qodo and Bito lead with review-first products. Copilot, Amazon Q, and Augment have added review as supplementary features.

9. **The best open-source inline completion experience** comes from Continue.dev (most features), llama.vscode (best pure-local), and Tabby (best self-hosted). Twinny is the closest spiritual match to Bespoke AI.

10. **Zed's Zeta model is worth watching.** Open-source edit prediction (not just next-token completion) is a genuinely novel approach that could democratize NES-like features.

---

## Continue.dev Fork Analysis

_Evaluated February 2026 as a potential base for Bespoke AI._

**Verdict: Do not fork.** The forking tax outweighs the benefits. Selectively borrow ideas instead.

### Why Not Fork

1. **Autocomplete quality isn't better.** Continue has persistent open issues: completions limited to 10-15 tokens (#6003, #6377), VS Code lag (#5055), completions failing to display (#2524), custom prompt templates silently ignored (#6341), no actual cross-file context despite docs (#3900).

2. **Model-specific post-processing hacks.** Their postprocessing strips Codestral leading spaces, Qwen3 `<think>` tags, Granite prefix echoing, Gemma file separator tokens. This is the pattern our CLAUDE.md explicitly warns against.

3. **Massive codebase.** Hundreds of files, 49KB god-file (`core.ts`), 48KB type file, 50+ IDE interface methods. Stripping to autocomplete-only would be weeks of work.

4. **NES is experimental.** Continue has NES infrastructure in `core/nextEdit/` but their own README acknowledges it's buggy. Only works with 2 specific models (Mercury Coder, Instinct). Users report ~1 suggestion per 10 minutes. Not production-ready.

5. **No CodeActionProvider.** Despite being a mature project, Continue does not register lightbulb/quick fix actions.

### What to Borrow (Ideas, Not Code)

See the [Open-Source Reference Guide](#open-source-reference-guide) below for specific Continue.dev files to study. Key techniques: generator reuse, stream-time filtering, FIM template library, LSP context, persistent cache.

---

## Open-Source Reference Guide

When implementing a feature, check these projects first for prior art before building from scratch.

| Feature                           | Best Reference Project                                                                                  | Why                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Inline completion pipeline**    | [llama.vscode](https://github.com/ggml-org/llama.vscode)                                                | Cleanest, simplest FIM implementation. MIT licensed. Built by llama.cpp team. |
| **FIM prompt templates**          | [Continue.dev](https://github.com/continuedev/continue) `core/autocomplete/templating/`                 | 13+ model families covered. Study the template, not the whole codebase.       |
| **Stream-time filtering**         | [Continue.dev](https://github.com/continuedev/continue) `core/autocomplete/filtering/streamTransforms/` | Suffix overlap, repetition, function boundary detection.                      |
| **Open-tab context**              | [Continue.dev](https://github.com/continuedev/continue) `extensions/vscode/src/util/ideUtils.ts`        | Uses `vscode.window.tabGroups.all` — the simplest approach.                   |
| **LSP-based context**             | [Continue.dev](https://github.com/continuedev/continue) `extensions/vscode/src/autocomplete/lsp.ts`     | AST-driven go-to-definition with caching. Currently disabled due to perf.     |
| **Self-hosted completion server** | [Tabby](https://github.com/TabbyML/tabby)                                                               | Rust server, BM25 + embedding search, repo-level RAG.                         |
| **Workspace embeddings / RAG**    | [Twinny](https://github.com/twinnydotdev/twinny), [Tabby](https://github.com/TabbyML/tabby)             | Twinny has simple workspace embeddings. Tabby has full RAG pipeline.          |
| **Custom instructions file**      | [Cline](https://github.com/cline/cline) `.clinerules`                                                   | Simplest implementation: read file, append to system prompt.                  |
| **Code actions / lightbulb**      | [Roo Code](https://github.com/RooCodeInc/Roo-Code)                                                      | One of few open-source tools with VS Code CodeActionProvider.                 |
| **Edit prediction (NES-like)**    | [Zed](https://github.com/zed-industries/zed) Zeta model                                                 | Open-source edit prediction model. Rust/not VS Code, but novel approach.      |
| **Agent mode**                    | [Cline](https://github.com/cline/cline)                                                                 | 57K+ stars, Plan/Act modes, MCP support.                                      |
| **MCP integration**               | [Cline](https://github.com/cline/cline), [Goose](https://github.com/block/goose)                        | Both have clean MCP implementations.                                          |
