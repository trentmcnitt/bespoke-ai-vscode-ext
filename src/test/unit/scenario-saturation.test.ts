/**
 * Validates that every scenario's declared saturation matches its actual
 * text length. Thresholds come from DEFAULT_CONFIG in test/helpers.ts,
 * so the test automatically adjusts when config values change.
 */
import { makeConfig } from '../helpers';
import { TestScenario } from '../quality/judge';
import {
  proseScenarios,
  codeScenarios,
  edgeCaseScenarios,
  reuseQualityScenarios,
} from '../quality/scenarios';
import { regressionScenarios } from '../quality/regression-scenarios';
import {
  proseMidDocumentScenarios,
  proseJournalScenarios,
  proseBridgingScenarios,
  codeMidFileScenarios,
  prosePromptWritingScenarios,
  proseFullWindowScenarios,
  codeFullWindowScenarios,
} from '../quality/scenarios/index';

const config = makeConfig();

const allScenarios: TestScenario[] = [
  ...proseScenarios,
  ...codeScenarios,
  ...edgeCaseScenarios,
  ...reuseQualityScenarios,
  ...regressionScenarios,
  ...proseMidDocumentScenarios,
  ...proseJournalScenarios,
  ...proseBridgingScenarios,
  ...codeMidFileScenarios,
  ...prosePromptWritingScenarios,
  ...proseFullWindowScenarios,
  ...codeFullWindowScenarios,
];

describe('scenario saturation validation', () => {
  for (const scenario of allScenarios) {
    describe(scenario.id, () => {
      const window =
        scenario.mode === 'code'
          ? { prefix: config.code.contextChars, suffix: config.code.suffixChars }
          : { prefix: config.prose.contextChars, suffix: config.prose.suffixChars };

      it('prefix matches declared saturation', () => {
        if (scenario.saturation.prefix === 'saturated') {
          expect(scenario.prefix.length).toBeGreaterThan(window.prefix);
        } else {
          expect(scenario.prefix.length).toBeLessThanOrEqual(window.prefix);
        }
      });

      it('suffix matches declared saturation', () => {
        if (scenario.saturation.suffix === 'none') {
          expect(scenario.suffix).toBe('');
        } else if (scenario.saturation.suffix === 'saturated') {
          expect(scenario.suffix.length).toBeGreaterThan(window.suffix);
        } else {
          expect(scenario.suffix.length).toBeLessThanOrEqual(window.suffix);
        }
      });
    });
  }
});
