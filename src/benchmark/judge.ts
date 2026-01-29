/**
 * Automated benchmark evaluator using Claude as judge.
 *
 * Calls the Anthropic API with the validator prompt + scenario context + completion,
 * parses the structured JSON response, and returns judgment results.
 */
import * as fs from 'fs';
import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { JudgmentResult, TestScenario } from '../test/quality/judge';
import { JudgmentFileResult } from './types';

/** Input for a single evaluation call. */
export interface EvaluationInput {
  scenario: TestScenario;
  completion: string | null;
  generationIndex: number;
  judgeIndex: number;
}

/** Config for the judge. */
export interface JudgeConfig {
  apiKey: string;
  model: string;
  concurrency: number;
}

const DEFAULT_JUDGE_MODEL = 'claude-sonnet-4-20250514';

let cachedValidatorPrompt: string | null = null;

function loadValidatorPrompt(): string {
  if (cachedValidatorPrompt) return cachedValidatorPrompt;
  const promptPath = path.join(__dirname, '..', 'test', 'quality', 'validator-prompt.md');
  cachedValidatorPrompt = fs.readFileSync(promptPath, 'utf-8');
  return cachedValidatorPrompt;
}

function buildUserMessage(scenario: TestScenario, completion: string | null): string {
  const completionText = completion ?? '(null — provider returned no completion)';
  return [
    `Mode: ${scenario.mode}`,
    `Language: ${scenario.languageId}`,
    `File name: ${scenario.fileName}`,
    '',
    '--- Prefix ---',
    scenario.prefix,
    '--- End Prefix ---',
    '',
    '--- Suffix ---',
    scenario.suffix,
    '--- End Suffix ---',
    '',
    '--- Completion ---',
    completionText,
    '--- End Completion ---',
    '',
    '--- Requirements ---',
    JSON.stringify(scenario.requirements, null, 2),
    '--- End Requirements ---',
  ].join('\n');
}

function parseJudgmentResponse(text: string): JudgmentResult | null {
  // Try direct JSON parse first
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed.score === 'number' && typeof parsed.pass === 'boolean') {
      return parsed as JudgmentResult;
    }
  } catch {
    // Fall through to regex
  }

  // Regex fallback: extract JSON object from response
  const jsonMatch = text.match(/\{[\s\S]*"score"\s*:\s*\d+[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (typeof parsed.score === 'number' && typeof parsed.pass === 'boolean') {
        return parsed as JudgmentResult;
      }
    } catch {
      // Fall through to hard fallback
    }
  }

  return null;
}

/** Evaluate a single completion against the validator prompt. */
export async function evaluateCompletion(
  input: EvaluationInput,
  config: JudgeConfig,
): Promise<JudgmentFileResult> {
  const validatorPrompt = loadValidatorPrompt();
  const userMessage = buildUserMessage(input.scenario, input.completion);

  // Null completions are automatic failures
  if (input.completion === null) {
    return {
      index: input.judgeIndex,
      judgeModel: config.model,
      score: 0,
      accept: false,
      pass: false,
      reasoning: 'Provider returned null completion.',
      criteria_results: {
        seamless_continuation: false,
        no_repetition: false,
        appropriate_length: false,
        context_awareness: false,
        mode_specific: false,
        test_requirements: false,
      },
    };
  }

  const client = new Anthropic({ apiKey: config.apiKey, timeout: 60_000 });

  try {
    const response = await client.messages.create({
      model: config.model,
      max_tokens: 1024,
      temperature: 0,
      system: [{ type: 'text', text: validatorPrompt }],
      messages: [{ role: 'user', content: userMessage }],
    });

    const block = response.content[0];
    const text = block && block.type === 'text' ? block.text : '';

    const judgment = parseJudgmentResponse(text);
    if (judgment) {
      return {
        index: input.judgeIndex,
        judgeModel: config.model,
        score: judgment.score,
        accept: judgment.accept ?? (judgment.score >= 7),
        pass: judgment.pass,
        reasoning: judgment.reasoning,
        criteria_results: judgment.criteria_results,
      };
    }

    // Parse failed — hard fallback
    return {
      index: input.judgeIndex,
      judgeModel: config.model,
      score: 0,
      accept: false,
      pass: false,
      reasoning: `Failed to parse judge response: ${text.slice(0, 200)}`,
      criteria_results: {
        seamless_continuation: false,
        no_repetition: false,
        appropriate_length: false,
        context_awareness: false,
        mode_specific: false,
        test_requirements: false,
      },
    };
  } catch (err) {
    return {
      index: input.judgeIndex,
      judgeModel: config.model,
      score: 0,
      accept: false,
      pass: false,
      reasoning: `Judge API error: ${err instanceof Error ? err.message : String(err)}`,
      criteria_results: {
        seamless_continuation: false,
        no_repetition: false,
        appropriate_length: false,
        context_awareness: false,
        mode_specific: false,
        test_requirements: false,
      },
    };
  }
}

/** Evaluate a batch of inputs with a concurrency limit. */
export async function evaluateBatch(
  inputs: EvaluationInput[],
  config: JudgeConfig,
): Promise<JudgmentFileResult[]> {
  const results: JudgmentFileResult[] = [];
  const queue = [...inputs];
  const inFlight: Promise<void>[] = [];

  for (const input of queue) {
    const promise = evaluateCompletion(input, config).then(result => {
      results.push(result);
    });
    inFlight.push(promise);

    if (inFlight.length >= config.concurrency) {
      await Promise.race(inFlight);
      // Remove settled promises
      for (let i = inFlight.length - 1; i >= 0; i--) {
        const settled = await Promise.race([
          inFlight[i].then(() => true),
          Promise.resolve(false),
        ]);
        if (settled) inFlight.splice(i, 1);
      }
    }
  }

  await Promise.all(inFlight);
  return results;
}

export { DEFAULT_JUDGE_MODEL };
