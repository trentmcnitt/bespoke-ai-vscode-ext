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
    quality_notes?: string;
  };

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
