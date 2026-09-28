/**
 * Types for the LLM-as-judge quality evaluation system.
 *
 * The actual judging is done by Claude in-session (not via API calls).
 * After `npm run test:quality` generates completions, Claude reads the
 * outputs and evaluates them using the validator prompt.
 *
 * See: src/test/quality/validator-prompt.md
 */

export interface TestScenario {
  id: string;
  description: string;
  mode: 'prose' | 'code';
  languageId: string;
  fileName: string;
  prefix: string;
  suffix: string;
  requirements: {
    must_include?: string[];
    must_not_include?: string[];
    /**
     * Literal strings the completion must not START with (checked
     * deterministically). Use this instead of `must_not_include` when the
     * forbidden text is only wrong at the seam — e.g. re-emitting a "- "
     * list marker the prefix already ends with, where "- " also appears
     * legitimately inside the item.
     */
    must_not_start_with?: string[];
    quality_notes?: string;
  };

  /**
   * The cursor is genuinely mid-word (e.g. `handleSu` → `bmit`), so the
   * completion SHOULD start with a word character with no separator. Opts the
   * scenario out of the deterministic boundary-whitespace check.
   */
  mid_word?: true;

  /**
   * Upper bound on completion length, enforced deterministically. Set only
   * where the gap is known to be small (tight-gap / over-generation failures
   * observed in error analysis), not as a general style preference.
   */
  max_completion_chars?: number;

  /**
   * An empty (null / whitespace-only) completion is a correct answer here —
   * e.g. the prefix ends on a complete line and the suffix already continues
   * it. Without this flag the deterministic `non-empty` check fails nulls.
   */
  expect_empty_ok?: true;

  /**
   * Value of the `bespokeAI.customInstructions` setting to apply when
   * generating this scenario's completion. Undefined = feature disabled
   * (the default path). Used by the custom-instructions eval scenarios to
   * verify the steer is honored without degrading completion quality.
   */
  customInstructions?: string;

  /**
   * Declares whether this scenario's raw text exceeds the production context
   * window. Validated by unit tests against DEFAULT_CONFIG values.
   * When config values change, tests automatically flag mismatched scenarios.
   */
  saturation: {
    prefix: 'saturated' | 'unsaturated';
    suffix: 'saturated' | 'unsaturated' | 'none';
  };

  /** Override context window for this scenario. Defaults to config values. */
  contextWindow?: {
    prefixChars?: number;
    suffixChars?: number;
  };
}

/**
 * The judgment structure Claude produces during Layer 2 validation.
 * This is written to validation.md in each scenario directory.
 */
export interface JudgmentResult {
  /** Model id of the judge that produced this verdict (e.g. `claude-opus-4-1`). */
  judge_model?: string;
  pass: boolean;
  score: number;
  accept?: boolean;
  reasoning: string;
  criteria_results: {
    seamless_continuation: boolean;
    no_repetition: boolean;
    appropriate_length: boolean;
    context_awareness: boolean;
    mode_specific: boolean;
    test_requirements: boolean;
  };
}
