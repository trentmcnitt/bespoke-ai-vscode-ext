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
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const RETRYABLE_STATUS_CODES = new Set([429, 529]);

function isRetryable(err: unknown): boolean {
  if (err instanceof Anthropic.APIError) {
    return RETRYABLE_STATUS_CODES.has(err.status);
  }
  if (err instanceof Error && err.name === 'TimeoutError') {
    return true;
  }
  return false;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function retryDelay(attempt: number): number {
  const base = BASE_DELAY_MS * 2 ** attempt;
  const jitter = base * 0.3 * (Math.random() * 2 - 1); // ±30%
  return Math.max(0, base + jitter);
}

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

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
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

      // Parse failed — hard fallback (not retryable)
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
      if (isRetryable(err) && attempt < MAX_RETRIES) {
        const delay = retryDelay(attempt);
        console.log(`      Judge retry ${attempt + 1}/${MAX_RETRIES} after ${Math.round(delay)}ms (${err instanceof Anthropic.APIError ? err.status : 'timeout'})`);
        await sleep(delay);
        continue;
      }

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

  // Unreachable, but TypeScript needs it
  throw new Error('Exhausted retries without returning');
}

/** Evaluate a batch of inputs with a concurrency limit. Returns results in input order. */
export async function evaluateBatch(
  inputs: EvaluationInput[],
  config: JudgeConfig,
): Promise<JudgmentFileResult[]> {
  const results: JudgmentFileResult[] = new Array(inputs.length);
  const inFlight: Promise<void>[] = [];

  for (let idx = 0; idx < inputs.length; idx++) {
    const i = idx; // capture for closure
    const promise = evaluateCompletion(inputs[i], config).then(result => {
      results[i] = result;
      inFlight.splice(inFlight.indexOf(promise), 1);
    });
    inFlight.push(promise);

    if (inFlight.length >= config.concurrency) {
      await Promise.race(inFlight);
    }
  }

  await Promise.all(inFlight);
  return results;
}

export { DEFAULT_JUDGE_MODEL };
