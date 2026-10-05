/**
 * The scenarios the playground offers and records: the synthetic quality
 * scenarios only. Never regression-scenarios.ts (captured from private use).
 * Custom-instruction scenarios are left out: the playground has no custom instructions.
 */
import type { TestScenario } from '../src/test/quality/judge';
import type { CheckScenarioFlags } from '../src/test/quality/deterministic-checks';
import { proseScenarios, codeScenarios, edgeCaseScenarios } from '../src/test/quality/scenarios';
import {
  proseMidDocumentScenarios,
  proseJournalScenarios,
  proseBridgingScenarios,
  codeMidFileScenarios,
  prosePromptWritingScenarios,
  proseFullWindowScenarios,
  codeFullWindowScenarios,
} from '../src/test/quality/scenarios/index';

export const SCENARIOS: TestScenario[] = [
  ...proseScenarios,
  ...codeScenarios,
  ...edgeCaseScenarios,
  ...proseMidDocumentScenarios,
  ...proseJournalScenarios,
  ...proseBridgingScenarios,
  ...prosePromptWritingScenarios,
  ...proseFullWindowScenarios,
  ...codeMidFileScenarios,
  ...codeFullWindowScenarios,
];

export const scenarioById = new Map(SCENARIOS.map((s) => [s.id, s]));

/** The scenario fields the deterministic checks read. */
export function checkFlagsFor(s: TestScenario): CheckScenarioFlags {
  return {
    mid_word: s.mid_word,
    max_completion_chars: s.max_completion_chars,
    expect_empty_ok: s.expect_empty_ok,
    requirements: { must_not_start_with: s.requirements.must_not_start_with },
  };
}
