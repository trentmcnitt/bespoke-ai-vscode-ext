/**
 * Regression scenarios — real-world completion issues captured from use.
 *
 * Each scenario reproduces a specific bug or quality failure observed during
 * actual usage. These flow through the same quality test pipeline (Layer 1
 * generation + Layer 2 judging) as the golden scenarios in scenarios.ts.
 *
 * Unlike the golden scenarios (which test general capability), regression
 * scenarios test that specific known failure modes don't recur. The
 * `regression_notes` field documents what went wrong originally so the
 * Layer 2 judge knows what to watch for.
 *
 * To add a new case:
 *   1. Copy the prefix and suffix from the trace log (or reconstruct them)
 *   2. Add a RegressionScenario with a descriptive id and the failure details
 *   3. Tag with the model/backend that produced the failure
 *
 * Run: npm run test:quality (these run alongside the standard scenarios)
 */
import { TestScenario } from './judge';

export interface RegressionScenario extends TestScenario {
  /** Which model/backend originally produced the failure. */
  observedModel: string;
  /** Date the issue was observed (ISO date string). */
  observedDate: string;
  /** What went wrong — guides the Layer 2 judge on what to watch for. */
  regression_notes: string;
}

// ─── REGRESSION CASES ─────────────────────────────────────────────────

export const regressionScenarios: RegressionScenario[] = [
  {
    id: 'regression-prose-list-marker-echo',
    description: 'Model echoes "- " list marker that is already at end of prefix, producing "- - "',
    observedModel: 'claude-code/haiku',
    observedDate: '2025-01-30',
    regression_notes:
      'The prefix ends with "\\n- " (user typed a dash-space to start a new bullet). ' +
      'The model echoed "- **Open source** - Transparency..." causing the document to show ' +
      '"- - **Open source**..." with a duplicated list marker. The completion must NOT start ' +
      'with "- " since that marker is already present in the prefix.',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'README.md',
    prefix:
      '# Todo Manager\n\n' +
      'LLM-assisted task management via Claude Code with Vikunja.\n\n' +
      '**Status:** Active (Vikunja self-hosted)\n\n' +
      '## Project Goals\n\n' +
      '1. **Reduce daily tedium** - Automate the repetitive morning triage of 100+ reminders\n' +
      '2. **Prevent forgotten items** - Use LLM context to track important one-offs and flag overdue patterns\n' +
      '3. **Claude integration** - Full API control for intelligent task management\n' +
      '4. **Critical alerts** - Pushover integration for items that must not be missed\n' +
      '5. **Data ownership** - Self-hosted solution with full control over data\n\n' +
      '## Documentation\n\n' +
      '| Document | Purpose |\n' +
      '|----------|--------|\n' +
      '| `CLAUDE.md` | Technical reference for Claude Code - commands, API patterns, workflows |\n' +
      '| `docs/vikunja-implementation.md` | Complete Vikunja implementation reference (recurrence, CANONICAL_* system, API gotchas) |\n' +
      '| `docs/task-manager-alternatives.md` | Research on alternatives (Todoist, TickTick, etc.) and why we chose Vikunja |\n\n' +
      '---\n\n' +
      '## Current System: Vikunja\n\n' +
      'Self-hosted task manager at https://tasks.homelab.example.com\n\n' +
      '### Why Vikunja?\n\n' +
      'After extensive research (see `docs/task-manager-alternatives.md`), Vikunja was chosen because:\n\n' +
      '- **Full REST API** - Complete programmatic control\n' +
      '- **Self-hosted** - Data ownership, no subscription\n' +
      '- **Active development** - Regular updates\n' +
      '- **iOS/Web access** - Mobile and desktop support\n' +
      '- ',
    suffix:
      '\n\n### Known Limitations\n\n' +
      'Vikunja has significant recurrence limitations that we work around:\n\n' +
      '| Limitation | Our Solution |\n' +
      '|------------|--------------|\n' +
      '| No anchor date (causes snooze drift) | CANON',
    requirements: {
      must_not_include: ['```'],
      quality_notes:
        'The prefix ends with "- " (the user has already typed the list marker). ' +
        'The completion MUST NOT start with "- " or any list marker — it should provide ' +
        'the content of the bullet point directly (e.g., "**Open source** - Transparency..."). ' +
        'Starting with "- " would produce a doubled marker "- - " in the document.',
    },
  },
];
