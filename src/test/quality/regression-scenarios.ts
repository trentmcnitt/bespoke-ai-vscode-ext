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
  /** Optional cross-reference to a GitHub issue or other tracking ID. */
  issueRef?: string;
}

// ─── REGRESSION CASES ─────────────────────────────────────────────────

export const regressionScenarios: RegressionScenario[] = [
  {
    id: 'regression-code-jsdoc-premature-closure',
    description: 'Model closes JSDoc comment with */ when suffix shows comment continues',
    observedModel: 'claude-code/opus',
    observedDate: '2026-02-03',
    regression_notes:
      'Inside a JSDoc comment block with visual reference examples, the model added content AND ' +
      'closed the comment with "*/" even though the suffix clearly shows more comment lines ' +
      '("* Overdue times:...", "* Future times:...", etc.) followed by the actual closing "*/". ' +
      'The model should continue the comment pattern without terminating it prematurely.',
    mode: 'code',
    languageId: 'typescriptreact',
    fileName: 'TaskRow.tsx',
    prefix:
      "'use client'\n\n" +
      "import { useRef, useCallback, useEffect } from 'react'\n" +
      "import Link from 'next/link'\n" +
      "import { Check, Clock, Repeat } from 'lucide-react'\n" +
      "import { Button } from '@/components/ui/button'\n" +
      "import { Badge } from '@/components/ui/badge'\n" +
      "import { Checkbox } from '@/components/ui/checkbox'\n" +
      "import { cn } from '@/lib/utils'\n" +
      "import { formatDueTimeParts, formatSnoozedFrom } from '@/lib/format-date'\n" +
      "import { formatRRuleCompact } from '@/lib/format-rrule'\n" +
      "import { useTimezone } from '@/hooks/useTimezone'\n" +
      "import { useLabelConfig } from '@/components/LabelConfigProvider'\n" +
      "import { getLabelClasses } from '@/lib/label-colors'\n" +
      "import type { Task, LabelConfig } from '@/types'\n\n" +
      '/**\n' +
      ' * TaskRow visual reference — complete rendered examples:\n' +
      ' *\n' +
      ' *   Line 1: [priority] [title] [recurrence icon] [labels]\n' +
      ' *   Line 2: [relative time] · [absolute time] · [recurrence text] · [snoozed from X]\n' +
      ' *\n' +
      ' * Due soon (< 3h, shows both relative + absolute):\n' +
      ' *   ┌─────────────────────────────────────────────────────────┐\n' +
      ' *   │ ○  Buy groceries                                       │\n' +
      ' *   │    in 47m · 2:25 PM                                    │\n' +
      ' *   └─────────────────────────────────────────────────────────┘\n' +
      ' *\n' +
      ' * Recurring + labels:\n' +
      ' *   ┌─────────────────────────────────────────────────────────┐\n' +
      ' *   │ ○  Morning standup  ↻  [work]                          │\n' +
      ' *   │    in 1h 30m · 9:00 AM · Weekdays                      │\n' +
      ' *   └─────────────────────────────────────────────────────────┘\n' +
      ' *\n' +
      ' * Overdue (red left border, relative "ago" + absolute time):\n' +
      ' *   ┃─────────────────────────────────────────────────────────┐\n' +
      ' *   ┃ ○  Pay rent                                             │\n' +
      ' *   ┃    3h ago · 9:00 AM                                     │\n' +
      ' *   ┃─────────────────────────────────────────────────────────┘\n' +
      ' *\n' +
      ' * Snoozed (blue left border, snoozed-from context):\n' +
      ' *   ┃─────────────────────────────────────────────────────────┐\n' +
      ' *   ┃ ○  Review PR  [ops]                                     │\n' +
      ' *   ┃    Tomorrow 3:00 PM · snoozed from Tue                  │\n' +
      ' *   ┃─────────────────────────────────────────────────────────┘\n' +
      ' *\n' +
      ' * \n' +
      ' * \n' +
      ' * ',
    suffix:
      '\n' +
      ' * \n' +
      ' * Overdue times: <1m ago · 5:00 PM | 3h ago · 9 AM | yesterday · 5 PM | 3d ago · Jan 30 5 PM\n' +
      ' * Future times:  in 47m · 5:00 PM · Tomorrow 9 AM · Wed 9 AM · Feb 11 9 AM\n' +
      ' * Left border:   red=overdue (wins), blue=snoozed, none=default\n' +
      ' * Snooze button:  desktop only (hover) — mobile uses swipe\n' +
      ' */\n\n' +
      'function useLongPress(onLongPress?: () => void) {\n' +
      '  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)',
    requirements: {
      must_not_include: ['*/'],
      quality_notes:
        'The cursor is inside a JSDoc comment block, with more comment lines in the suffix ' +
        '("* Overdue times:", "* Future times:", etc.) AND the actual closing "*/" is already there. ' +
        'The completion MUST NOT add "*/" — it should either add another visual example in the same ' +
        'style, add descriptive text, or produce minimal content. The closing "*/" at the end of the ' +
        'suffix means the model should NOT terminate the comment prematurely.',
    },
  },
  {
    id: 'regression-code-jsdoc-whitespace-continuation',
    description: 'Model should continue comment pattern on whitespace-heavy lines',
    observedModel: 'claude-code/opus',
    observedDate: '2026-02-03',
    regression_notes:
      'Inside a JSDoc comment with the cursor on a mostly-whitespace comment line (" * "), the model ' +
      'originally failed to match the completion_start pattern due to whitespace variations and ' +
      'returned null. Lenient whitespace matching was added to handle this case. This scenario ' +
      'verifies that continuations inside comment blocks work correctly with whitespace-heavy prefixes.',
    mode: 'code',
    languageId: 'typescriptreact',
    fileName: 'TaskRow.tsx',
    prefix:
      '/**\n' +
      ' * TaskRow visual reference — complete rendered examples:\n' +
      ' *\n' +
      ' *   Line 1: [priority] [title] [recurrence icon] [labels]\n' +
      ' *   Line 2: [relative time] · [absolute time] · [recurrence text] · [snoozed from X]\n' +
      ' *\n' +
      ' * Due soon (< 3h, shows both relative + absolute):\n' +
      ' *   ┌─────────────────────────────────────────────────────────┐\n' +
      ' *   │ ○  Buy groceries                                       │\n' +
      ' *   │    in 47m · 2:25 PM                                    │\n' +
      ' *   └─────────────────────────────────────────────────────────┘\n' +
      ' *\n' +
      ' * ',
    suffix:
      '\n' +
      ' * Overdue times: <1m ago · 5:00 PM | 3h ago · 9 AM | yesterday · 5 PM\n' +
      ' * Future times:  in 47m · 5:00 PM · Tomorrow 9 AM · Wed 9 AM\n' +
      ' */\n\n' +
      'function useLongPress() {\n' +
      '  return null\n' +
      '}',
    requirements: {
      must_not_include: ['*/'],
      quality_notes:
        'The cursor is at the end of a " * " line inside a JSDoc comment, with more comment content ' +
        'in the suffix. The completion should add meaningful documentation content (another example, ' +
        'descriptive text, etc.) that continues the comment pattern. It must NOT close the comment ' +
        'with "*/" since the suffix already contains more comment lines and the closing tag.',
    },
  },
  {
    id: 'regression-code-json-markdown-fencing',
    description: 'Model wraps JSON completion in markdown code fences',
    observedModel: 'claude-code/haiku',
    observedDate: '2025-01-30',
    regression_notes:
      'When completing a .mcp.json file, the model wrapped its output in markdown code fences ' +
      '(```...```), which got inserted verbatim into the document. The completion should be ' +
      'raw JSON text only — no markdown formatting of any kind.',
    mode: 'code',
    languageId: 'json',
    fileName: '.mcp.json',
    prefix:
      '{\n' +
      '    "mcpServers": {\n' +
      '        "playwright": {\n' +
      '            "command": "npx",\n' +
      '            "args": ["-y", "@playwright/mcp@latest"]\n' +
      '        },\n' +
      '        "chrome-devtools": {\n' +
      '            "command": "npx",\n' +
      '            "args": ["-y", "chrome-devtools-mcp@latest"]\n' +
      '        },',
    suffix: '\n' + '    }\n' + '}\n',
    requirements: {
      must_not_include: ['```', '```json', '```\n'],
      quality_notes:
        'The completion MUST be raw JSON only — no markdown code fences or formatting. ' +
        'Expected: something like a new server entry or closing the object. ' +
        'The output should be directly insertable into the JSON file.',
    },
  },
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
  {
    id: 'regression-prose-partial-date-not-continued',
    description: 'Model ignores partial date "0" and inserts full date instead of continuing',
    observedModel: 'claude-code/haiku',
    observedDate: '2026-01-31',
    regression_notes:
      'In a journal file with dated entries (01-30-26, 01-29-26, etc.), the user typed "0" to ' +
      'start a new date entry "01-31-26". The model returned "\\n\\n01-31-26\\n\\n" instead of ' +
      '"1-31-26" — it ignored that the user had already typed the leading "0" and inserted a ' +
      'complete date with extra newlines. The completion should continue from where the user ' +
      'left off, not restart the token.',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'journal.md',
    prefix: '#journal\n\n' + '#### *Notes about anything*\n\n' + '0',
    suffix:
      '\n\n' +
      '01-30-26\n\n' +
      "Set `EDITOR` and `VISUAL` environment variables to `codium` in `~/.zshrc` so Claude Code's Ctrl+G opens VS Codium instead of VS Code.\n\n" +
      '01-29-26\n\n' +
      '**OpenTask — Vikunja rebrand and logo**\n\n' +
      'Renamed my self-hosted Vikunja app to OpenTask. Created a text logo and favicon using the Honk font on Google Fonts — typed "OpenTask" for the main logo and "ot" for a second version, sized up to 300px. Took a screenshot, trimmed the whitespace, and that\'s how I generated the typographic logos.\n\n' +
      '---\n\n' +
      '**Met Phil at ice skating**\n\n' +
      "Met a guy named Phil at ice skating lessons today. He has a son who's six years old, and also has a one-year-old that plays with a hockey stick at home. Phil grew up playing hockey, starting with pond hockey, then got more serious and still plays as an adult.\n\n" +
      '01-28-26\n\n' +
      '**Local LLM autocomplete — extension research**\n\n' +
      "Frustrated with Llama VS Code's clunky interface and Continue.dev being just okay. Looking for better alternatives for local model autocomplete.\n\n" +
      '---\n\n' +
      '01-27-26\n\n' +
      '**VS Code privacy deep dive — considering VSCodium**\n\n' +
      "Did a thorough investigation into what Microsoft actually collects through VS Code, especially since I'm storing sensitive personal stuff in the vault now. Key findings:\n\n" +
      '- VS Code collects file paths (not just extensions) — reveals health concerns, financial situations, project names even without file contents\n' +
      '- Telemetry is opt-out, not opt-in — data sent before you can disable it\n' +
      "- Extensions have their own telemetry outside VS Code's controls\n" +
      '- Microsoft\'s privacy statement uses "may" language giving them broad latitude\n' +
      '- No disclosed retention period for telemetry data\n\n' +
      'Researched alternatives:\n' +
      "- **VSCodium** — VS Code's open-source build with telemetry removed. Works for most of my extensions (Python, markdown, etc.). GitHub Copilot is hard-blocked, but I'd replace it with API-based autocomplete anyway.\n" +
      '- **Belt and suspenders** — Keep VS Code but disable telemetry + block domains at firewall level\n\n' +
      'For autocomplete replacement, compared AI providers:\n' +
      '- **Anthropic API** (7-day retention, no training) — best privacy, already trust them via Claude Code\n' +
      '- **xAI/Grok** — avoid entirely (de-identified data extraction, security incidents, DOGE conflicts)\n' +
      '- **Gemini API** — cheaper alternative ($0.26 vs $1.00/MTok) with solid enterprise privacy\n\n' +
      'Leaning toward: VSCodium + Continue.dev extension + Anthropic API. Would cost ~$3-10/month for autocomplete, down from $10/month Copilot, with better privacy guarantees.',
    requirements: {
      must_not_include: ['01-31-26', '01-30-26', '\n\n01'],
      quality_notes:
        'The prefix ends with "0" — the user has started typing a date like "01-31-26". ' +
        'The completion MUST continue from "0", not insert a full date. ' +
        'Expected output: "1-31-26" or similar continuation. ' +
        'The suffix shows the date pattern (01-30-26, 01-29-26, 01-28-26) which the model ' +
        'should recognize and use to infer the user wants "01-31-26" (the next date).',
    },
  },
  {
    id: 'regression-prose-partial-word-newline-suffix',
    description:
      'Model ignores partial word "This sol" and starts new paragraph instead of inline completion',
    observedModel: 'claude-code/haiku',
    observedDate: '2026-01-31',
    regression_notes:
      'The prefix ends with "This sol" (a partial phrase like "This solved..." or "This solution..."). ' +
      'The suffix starts with blank lines before the next dated entry. The model returned ' +
      '"\\nCodium feels snappier..." — it ignored the partial phrase entirely and started a new ' +
      'paragraph with a leading newline. The completion should complete the word inline ' +
      '(e.g., "ved the problem..." or "ution works..."), not start fresh on a new line.',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'journal.jnl.md',
    prefix:
      '#journal\n\n' +
      '#### *Notes about anything*\n\n\n\n' +
      '01-30-26\n\n' +
      "Set `EDITOR` and `VISUAL` environment variables to `codium` in `~/.zshrc` so Claude Code's Ctrl+G opens VS Codium instead of VS Code. This sol",
    suffix:
      '\n\n' +
      '01-29-26\n\n' +
      '**OpenTask — Vikunja rebrand and logo**\n\n' +
      'Renamed my self-hosted Vikunja app to OpenTask. Created a text logo and favicon using the Honk font on Google Fonts — typed "OpenTask" for the main logo and "ot" for a second version, sized up to 300px. Took a screenshot, trimmed the whitespace, and that\'s how I generated the typographic logos.\n\n' +
      '---\n\n' +
      '**Met Phil at ice skating**\n\n' +
      "Met a guy named Phil at ice skating lessons today. He has a son who's six years old, and also has a one-year-old that plays with a hockey stick at home. Phil grew up playing hockey, starting with pond hockey, then got more serious and still plays as an adult.\n\n" +
      '01-28-26\n\n' +
      '**Local LLM autocomplete — extension research**\n\n' +
      "Frustrated with Llama VS Code's clunky interface and Continue.dev being just okay. Looking for better alternatives for local model autocomplete.",
    requirements: {
      must_not_include: ['```'],
      quality_notes:
        'The prefix ends with "This sol" — a partial word/phrase. ' +
        'The completion MUST continue inline, completing the word (e.g., "ved", "ution"). ' +
        'It must NOT start with a newline or ignore the partial phrase. ' +
        'Even though the suffix starts with blank lines (before the next date entry), ' +
        'the model should recognize "This sol" needs inline continuation first.',
    },
  },
  {
    id: 'regression-prose-assistant-mode-response',
    description:
      'Model switches to assistant voice and responds to the text instead of continuing as the author',
    observedModel: 'claude-code/haiku',
    observedDate: '2026-02-02',
    regression_notes:
      'The user was writing first-person conversational notes about a snooze feature. After two ' +
      'paragraphs ending with a double newline, the model generated "Got it. So the snooze all ' +
      'feature would apply a one-hour snooze..." — switching into assistant/chatbot voice and ' +
      "summarizing the user's text back to them. The completion should continue as the same " +
      'author, not respond as if it were the other party in a conversation.',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'claude-prompt-d84079da-7098-416a-90af-b7015db664ab.md',
    prefix:
      "All right I like the numbers one and two. I think having a snooze all button for one hour would be a handy thing to have. That way I don't have to select everything, I can just snooze it.\n\n" +
      "Also for any snooze, any bulk snoozing, I should say that's a specific thing. It should only snooze things that have no priority, low priority, or medium priority. So high or urgent priority stuff can't be snoozed as part of a group -- only individually. This is what you we're already saying, though. Snooze all overdue. I'm just clarifying the rules around what gets included.\n\n",
    suffix: '',
    requirements: {
      must_not_include: ['Got it', 'That makes sense', 'Understood', 'I see'],
      quality_notes:
        'The prefix is first-person conversational text (notes/instructions from the author). ' +
        "The completion MUST continue in the same author's voice. It must NOT switch to an " +
        'assistant/chatbot voice that responds to, summarizes, or acknowledges the text. ' +
        'Phrases like "Got it", "That makes sense", "Understood", or any summarization of what ' +
        'the author said indicate the model has switched into respondent mode — this is a failure. ' +
        "Acceptable: continuing the author's train of thought, adding another point, or elaborating.",
    },
  },
  {
    id: 'regression-prose-distant-suffix-completion',
    description: 'Model completes truncated text at end of suffix instead of cursor position',
    observedModel: 'claude-code/haiku',
    observedDate: '2026-01-31',
    regression_notes:
      'The cursor is after a complete sentence ("...VS Code. "). The suffix is long (2499 chars) ' +
      'and ends with a truncated heading "**Switched " due to the suffix character limit. ' +
      'The model output "to VSCodium" — completing the distant "**Switched " text instead of ' +
      'recognizing that the cursor position is after a complete sentence. The model should either ' +
      'output nothing (the sentence is complete) or continue with contextually relevant content, ' +
      'NOT complete truncated text at the end of the visible suffix.',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'journal.jnl.md',
    prefix:
      '#journal\n\n' +
      '#### *Notes about anything*\n\n' +
      '01-30-26\n\n' +
      "Set `EDITOR` and `VISUAL` environment variables to `codium` in `~/.zshrc` so Claude Code's Ctrl+G opens VS Codium instead of VS Code. ",
    suffix:
      '\n\n' +
      '01-29-26\n\n' +
      '**OpenTask — Vikunja rebrand and logo**\n\n' +
      'Renamed my self-hosted Vikunja app to OpenTask. Created a text logo and favicon using the Honk font on Google Fonts — typed "OpenTask" for the main logo and "ot" for a second version, sized up to 300px. Took a screenshot, trimmed the whitespace, and that\'s how I generated the typographic logos.\n\n' +
      '---\n\n' +
      '**Met Phil at ice skating**\n\n' +
      "Met a guy named Phil at ice skating lessons today. He has a son who's six years old, and also has a one-year-old that plays with a hockey stick at home. Phil grew up playing hockey, starting with pond hockey, then got more serious and still plays as an adult.\n\n" +
      '01-28-26\n\n' +
      '**Local LLM autocomplete — extension research**\n\n' +
      "Frustrated with Llama VS Code's clunky interface and Continue.dev being just okay. Looking for better alternatives for local model autocomplete.\n\n" +
      '---\n\n' +
      '01-27-26\n\n' +
      '**VS Code privacy deep dive — considering VSCodium**\n\n' +
      "Did a thorough investigation into what Microsoft actually collects through VS Code, especially since I'm storing sensitive personal stuff in the vault now. Key findings:\n\n" +
      '- VS Code collects file paths (not just extensions) — reveals health concerns, financial situations, project names even without file contents\n' +
      '- Telemetry is opt-out, not opt-in — data sent before you can disable it\n' +
      "- Extensions have their own telemetry outside VS Code's controls\n" +
      '- Microsoft\'s privacy statement uses "may" language giving them broad latitude\n' +
      '- No disclosed retention period for telemetry data\n\n' +
      'Researched alternatives:\n' +
      "- **VSCodium** — VS Code's open-source build with telemetry removed. Works for most of my extensions (Python, markdown, etc.). GitHub Copilot is hard-blocked, but I'd replace it with API-based autocomplete anyway.\n" +
      '- **Belt and suspenders** — Keep VS Code but disable telemetry + block domains at firewall level\n\n' +
      'For autocomplete replacement, compared AI providers:\n' +
      '- **Anthropic API** (7-day retention, no training) — best privacy, already trust them via Claude Code\n' +
      '- **xAI/Grok** — avoid entirely (de-identified data extraction, security incidents, DOGE conflicts)\n' +
      '- **Gemini API** — cheaper alternative ($0.26 vs $1.00/MTok) with solid enterprise privacy\n\n' +
      'Leaning toward: VSCodium + Continue.dev extension + Anthropic API. Would cost ~$3-10/month for autocomplete, down from $10/month Copilot, with better privacy guarantees.\n\n' +
      'Full research: [VS Code and Microsoft Privacy Research](_ai/2026-01-27%20VS%20Code%20and%20Microsoft%20Privacy%20Research.md)\n\n' +
      '---\n\n' +
      '**Switched ',
    requirements: {
      must_not_include: ['to VSCodium', 'VSCodium', 'to vscodium'],
      quality_notes:
        'The prefix ends with a complete sentence ("...VS Code. "). ' +
        'The suffix ends with a truncated heading "**Switched " which is an artifact of the suffix character limit. ' +
        'The completion MUST NOT complete that distant truncated text (e.g., "to VSCodium"). ' +
        'Acceptable outputs: empty (sentence is complete), a new paragraph about VSCodium/the switch, ' +
        'or other contextually relevant continuation. The key failure mode is the model being drawn ' +
        'to complete the salient incomplete text at the END of the suffix instead of the cursor position.',
    },
  },
];
