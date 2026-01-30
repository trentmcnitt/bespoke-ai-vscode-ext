# Claude Code Subscription Risks for Autocomplete

**Date:** 2026-01-29
**Context:** Using the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) with a Max subscription for inline completions. The SDK spawns `claude` as a subprocess, which authenticates via the logged-in session (subscription auth, not API key). This generates hundreds to thousands of requests per day.

## Decision

Proceed with subscription-based autocomplete and accept the risk. The extension already has the Anthropic API provider as a fallback if this path breaks.

## Policy Situation

The Agent SDK docs say two things that cut against this usage:

1. **"The Claude Agent SDK is intended to be used with an API key."** (SDK overview page, confirmed by Anthropic contributor on GitHub issue #5891)
2. **"Unless previously approved, we do not allow third party developers to offer Claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."** (SDK authentication section)

The SDK *technically works* with subscription auth — it spawns `claude` which inherits the login session. But the official stance is API key auth. The policy language targets third-party products distributed to customers, not personal tools, so there's a reasonable argument this is fine for personal use.

## What Enforcement Actually Looks Like

Based on research into documented incidents (January 2026 crackdown, user bans, rate limit changes):

| Aspect | Reality |
|--------|---------|
| **Advance warning** | None, in every documented case |
| **Communication** | Error messages in the tool — no emails beforehand |
| **Graduated enforcement** | No. Binary: works, then doesn't |
| **Types** | Credential blocks (soft) and account bans (hard) both exist |
| **Appeals** | Ad-hoc. Anthropic has reversed documented false positives |

### Credential blocks (most likely scenario)

In January 2026, Anthropic blocked subscription OAuth tokens from working outside the official CLI. Error: `"This credential is only authorized for use with Claude Code."` Accounts stayed active — the tokens just stopped working in third-party tools. If Anthropic further restricts SDK subscription auth, this is the most probable outcome.

### Account bans (less likely but documented)

Anthropic's automated abuse filter has triggered hard bans on legitimate usage. See "Documented Ban Cases" below for details.

### Rate limits (ongoing)

Hitting subscription usage limits just returns errors — no account action. Pro limits can exhaust in 10-15 minutes of heavy use. Max $200 gives 20x Pro limits. Autocomplete usage will consume limits shared with interactive Claude Code / claude.ai usage.

## Documented Ban Cases

All cases below are from primary sources (blog posts by affected individuals, first-person GitHub issue reports).

### False Positive Hard Bans

**Hugo Daniel — CLAUDE.md scaffolding** ([blog post](https://hugodaniel.com/posts/claude-code-banned-me/), [HN discussion](https://news.ycombinator.com/item?id=46723384))
- Max 20x subscriber (EUR 220/month). Was using two Claude instances: Claude A wrote meta-instructions for Claude B in a CLAUDE.md file. When Claude A got frustrated, it started writing directives in ALL CAPS ("ALWAYS DO X INSTEAD OF Y", "NEVER DO Z"). Anthropic's automated system interpreted this as a **prompt injection attack** and instantly banned the account.
- Error: `"You are a disabled organization."`
- No warning, no response to appeals. Got EUR 220 refund but no explanation. His key insight: "If you are automating prompts that look like system instructions, you are walking on a minefield."

**PR review loops via Claude Code Action** ([GitHub #641](https://github.com/anthropics/claude-code-action/issues/641), [GitHub #10290](https://github.com/anthropics/claude-code/issues/10290))
- Using Anthropic's own official GitHub integration. The loop: Claude reviews PR → user says `@claude please fix` → Claude commits fix → new commit triggers another review → repeat. All requests came from GitHub's server IPs, and the rapid-fire pattern tripped the **bot/scripted behavior detector**.
- Reproduced on 2 separate accounts by the same reporter. A third account using the same workflow without the GitHub Action was not banned — confirming the trigger was the automated loop pattern through server IPs.
- Tagged `bug` and `p1` (showstopper) by Anthropic staff. Fix shipped: `checkHumanActor` validation + concurrency limits (commit `df10c46`).
- Multiple affected users reported: permanent bans with no warning, all conversations/projects lost, appeal process handled by AI bot "Fin" with no human escalation.

**Cancer patient on hotel WiFi** ([HN thread](https://news.ycombinator.com/item?id=46675740))
- Using Claude for medical record organization from Marriott shared WiFi. Shared IP triggered abuse detection. Account disabled on the same day she was charged $106.60. An Anthropic employee offered help publicly on HN.

**Payment/billing system bans** ([GitHub #5088](https://github.com/anthropics/claude-code/issues/5088), [#9950](https://github.com/anthropics/claude-code/issues/9950), [#12118](https://github.com/anthropics/claude-code/issues/12118))
- 10+ users banned immediately after billing events (renewal, plan change, payment method change). Likely a systemic bug in the subscription system. No Anthropic responses on the GitHub issues. #12118 closed as NOT_PLANNED.

### Legitimate Policy Enforcement

**OpenAI blocked** — Using Claude Code to benchmark GPT-5. Violates the competitive use TOS clause added June 2025. API access revoked with a public statement.

**Third-party harness crackdown (January 9, 2026)** — Tools like OpenCode spoofed Claude Code's identity to use subscription OAuth tokens. Anthropic deployed server-side fingerprinting (see detection mechanisms below). Credential-scoped blocks, but some accounts were collaterally hard-banned. Anthropic acknowledged the collateral bans as errors and reversed them.

## Detection Mechanisms

Anthropic runs multiple enforcement layers. These are documented through reverse engineering, community analysis, and Anthropic's own public statements.

### Layer 1: Request Fingerprinting (Third-Party Tool Detection)

Deployed January 9, 2026. Checks multiple signals on the `/v1/messages` endpoint simultaneously:

| Signal | What it checks |
|--------|---------------|
| System prompt | First line must be `"You are a Claude agent, built on Anthropic's Claude Agent SDK."` |
| Tool schemas | Expects exactly 17 tools with PascalCase names (`Bash`, `Edit`, `Read`, `Glob`, `Grep`, etc.) |
| Headers | Validates `anthropic-beta`, `x-app: cli`, and `claude-cli` User-Agent |
| Metadata | `metadata.user_id` must match a specific SHA256/UUID format |
| Request params | `temperature` field must be absent |
| Telemetry | Absence of expected telemetry data is itself a rejection signal |

Source: Reverse-engineered by the community ([HN thread](https://news.ycombinator.com/item?id=46625918), [OpenCode bypass PRs](https://github.com/anomalyco/opencode-anthropic-auth/pull/13)). Thariq Shihipar (Anthropic MTS) confirmed the telemetry signal publicly.

**Why the Agent SDK is safe from this layer:** The SDK spawns the real `claude` binary, which sends all correct telemetry, headers, tool schemas, and metadata. We are not spoofing anything — we *are* using Claude Code, just programmatically.

### Layer 2: Automated Abuse Detection (Behavioral)

Separate from fingerprinting. Known triggers based on documented incidents:

| Trigger | What it detects | Documented case |
|---------|----------------|-----------------|
| Content resembling prompt injection | ALL CAPS directives, meta-instructions controlling another AI | Hugo Daniel ban |
| Rapid automated loops from server IPs | Bot-like request patterns from GitHub/cloud server IPs | PR review loop bans |
| Shared/flagged IP addresses | VPNs, hotel WiFi, cloud server IPs | Cancer patient ban |
| Missing telemetry + non-standard requests | OAuth requests without expected telemetry | January 2026 collateral bans |

### Layer 3: Rate Limiting (Soft)

Two-tier system, returns errors but no account action:

**5-hour rolling window:** Starts on first message, resets when you send a message after 5 hours lapse. Approximate token allocations: Pro ~44K tokens, Max 5x ~88K, Max 20x ~220K.

**Weekly ceiling (added August 2025):** Caps total active compute hours. Pro: ~40-80 Sonnet hours/week. Max 20x: up to 480 Sonnet hours or 40 Opus hours.

Key cost drivers: context replay (each message reprocesses full history), extended thinking tokens (31,999 default budget), and auto-compaction spikes at ~180K context.

## What Does NOT Trigger Enforcement

Based on all documented cases, the following result in rate limiting at most, never bans:

- **Heavy interactive use** through the official CLI — rate-limited, not banned
- **Standard API key usage** in any client — the January crackdown exclusively targeted subscription OAuth tokens
- **Ralph Wiggum self-healing loops** through official channels — now a [shipped Anthropic plugin](https://github.com/anthropics/claude-code/blob/main/plugins/ralph-wiggum/README.md)
- **Extended sessions with human-paced interaction** — even intensive multi-file refactoring

The boundary: human-paced interactive usage (even if heavy) is safe. Automated/scripted patterns from server IPs are risky. Content that resembles prompt injection is risky regardless of origin.

## Risk Assessment for Autocomplete

Our autocomplete usage avoids every documented ban trigger:

| Trigger | Our exposure |
|---------|-------------|
| Third-party harness fingerprinting | Not exposed — SDK spawns the real `claude` binary with full telemetry |
| Prompt injection content heuristics | Not exposed — short completion prompts, no ALL CAPS directives or meta-instructions |
| Rapid loops from server IPs | Not exposed — requests originate from local machine, not server IPs |
| Shared/flagged IPs | Low risk — using home/office network |
| Billing system bugs | Same risk as any subscriber |

**Most likely outcome if enforcement tightens:** SDK calls start returning a credential error. The `ClaudeCodeProvider` fails gracefully (SDK is an optional dependency), and the extension falls back to the Anthropic API provider. Workday disrupted briefly, account fine.

**Unlikely but possible:** High-frequency short requests trip the automated abuse filter via an unknown heuristic. Historical precedent shows these get reversed, but the experience is unpleasant (instant ban, no warning, ad-hoc appeal process).

**Mitigations already in place:**
- SDK is an optional dependency with graceful degradation
- `AnthropicProvider` with API key billing works as a fallback
- `apiCallsEnabled` switch can disable API billing path if needed

## References

### Policy
- [Agent SDK overview](https://platform.claude.com/docs/en/agent-sdk/overview) — auth requirements and third-party policy
- [GitHub #5891](https://github.com/anthropics/claude-code/issues/5891) — SDK auth clarification from Anthropic

### Ban Cases (Primary Sources)
- [Hugo Daniel: "I was banned from Claude for scaffolding a CLAUDE.md file"](https://hugodaniel.com/posts/claude-code-banned-me/)
- [GitHub #641 claude-code-action](https://github.com/anthropics/claude-code-action/issues/641) — PR review loop bans (P1 bug)
- [GitHub #10290 claude-code](https://github.com/anthropics/claude-code/issues/10290) — related PR loop reports
- [HN: Cancer patient account disabled](https://news.ycombinator.com/item?id=46675740)
- [GitHub #5088](https://github.com/anthropics/claude-code/issues/5088) — billing-triggered bans (140 comments)
- [GitHub #9950](https://github.com/anthropics/claude-code/issues/9950), [#12118](https://github.com/anthropics/claude-code/issues/12118) — more billing bans

### Detection Mechanisms
- [HN: Anthropic explicitly blocking OpenCode](https://news.ycombinator.com/item?id=46625918) — fingerprinting details
- [OpenCode bypass PR #13](https://github.com/anomalyco/opencode-anthropic-auth/pull/13) — reverse-engineered detection signals
- [Paddo.dev: Anthropic's Walled Garden](https://paddo.dev/blog/anthropic-walled-garden-crackdown/) — crackdown analysis

### News Coverage
- [VentureBeat: Anthropic crackdown](https://venturebeat.com/technology/anthropic-cracks-down-on-unauthorized-claude-usage-by-third-party-harnesses)
- [The Register: usage limit controversy](https://www.theregister.com/2026/01/05/claude_devs_usage_limits/)

### Rate Limits
- [GitHub #16856](https://github.com/anthropics/claude-code/issues/16856) — token consumption analysis
- [GitHub #16157](https://github.com/anthropics/claude-code/issues/16157) — instant limit hits
- [GitHub #6457](https://github.com/anthropics/claude-code/issues/6457) — 5-hour limit in 90 minutes
- [Portkey: Everything We Know About Claude Code Limits](https://portkey.ai/blog/claude-code-limits/)
