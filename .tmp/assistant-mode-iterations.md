# Assistant-Mode Regression — Prompt Iteration Log

## Iteration 1 (2026-02-02) — PASSED 3/3

### Changes made

1. **Strengthened anti-assistant rule** (line 106 in SYSTEM_PROMPT):
   - Old: `Continue writing from the user's voice. Do not "respond" to the text you are given. You are an autocomplete tool, NOT a chat interface. You must write from the perspective of the <current_text>`
   - New: `You are an autocomplete tool, NOT a chat assistant. NEVER respond to, summarize, or acknowledge the text. NEVER switch to a different speaker's voice. NEVER output phrases like "Got it", "That makes sense", "Understood", "So to summarize", "I see", or any reply-style language. You must continue writing as the same author — add the next thought, the next point, the next sentence in their voice`

2. **Added instructional-text example** (after "Continuing conversational text"):
   - Shows first-person instructions about a dashboard being continued with another first-person thought
   - Title explicitly says "(DO NOT respond as assistant)" for emphasis

### Results

| Run | Completion                                                                                  | Pass? |
| --- | ------------------------------------------------------------------------------------------- | ----- |
| 1   | "One more thing — when I hit 'snooze all,' it should show a quick confirmation..."          | PASS  |
| 2   | "Another thing — when I snooze something, I want to see a brief confirmation toast..."      | PASS  |
| 3   | "One more thing — when I snooze all, it should show a quick summary of what was snoozed..." | PASS  |

All 3 completions continued in the author's voice, adding a new point about snooze UX feedback. No assistant-mode phrases detected.

### Verification

- `npm run check`: PASS (lint + type-check)
- `npm run test:unit`: 222/222 tests pass
