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

Anthropic's automated abuse filter has triggered hard bans on legitimate usage:
- A developer building a CLAUDE.md scaffolding tool was banned instantly (`"You are a disabled organization."`) when meta-instructions triggered the prompt injection filter. Got a refund (EUR 220) through support.
- Developers using the *official* Claude Code Action for GitHub PR reviews were permanently banned when review-fix-review loops triggered the abuse filter. Filed as a P1 bug.

Both cases were reversed, but only after public complaints.

### Rate limits (ongoing)

Hitting subscription usage limits just returns errors — no account action. Pro limits can exhaust in 10-15 minutes of heavy use. Max $200 gives 20x Pro limits. Autocomplete usage will consume limits shared with interactive Claude Code / claude.ai usage.

## Risk Assessment for Autocomplete

**Most likely outcome if enforcement tightens:** SDK calls start returning a credential error. The `ClaudeCodeProvider` fails gracefully (SDK is an optional dependency), and the extension falls back to the Anthropic API provider. Workday disrupted briefly, account fine.

**Unlikely but possible:** High-frequency short requests trip the automated abuse filter, resulting in an account ban with no warning. Historical precedent shows these get reversed, but the experience is unpleasant.

**Mitigations already in place:**
- SDK is an optional dependency with graceful degradation
- `AnthropicProvider` with API key billing works as a fallback
- `apiCallsEnabled` switch can disable API billing path if needed

## References

- [Agent SDK overview](https://platform.claude.com/docs/en/agent-sdk/overview) — auth requirements and third-party policy
- [GitHub #5891](https://github.com/anthropics/claude-code/issues/5891) — SDK auth clarification from Anthropic
- [VentureBeat: Anthropic crackdown](https://venturebeat.com/technology/anthropic-cracks-down-on-unauthorized-claude-usage-by-third-party-harnesses) — January 2026 enforcement
- [Hugo Daniel ban](https://hugodaniel.com/posts/claude-code-banned-me/) — false positive account ban
- [GitHub #641 claude-code-action](https://github.com/anthropics/claude-code-action/issues/641) — PR loop ban (P1 bug)
- [The Register](https://www.theregister.com/2026/01/05/claude_devs_usage_limits/) — usage limit controversy
