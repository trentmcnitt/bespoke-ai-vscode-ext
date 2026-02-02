import { BenchmarkConfig } from './types';

/**
 * Named config presets for parameter sweep benchmarking.
 *
 * NOTE: These configs are Anthropic-specific and need updating for the Claude Code backend.
 * The benchmark runner is currently non-functional — see runner.ts.
 *
 * Each preset defines a label, description, and partial ExtensionConfig overrides.
 * The runner deep-merges these over the base config from makeConfig(), so only
 * the swept parameter needs to be specified — defaults fill in the rest.
 */
export const BENCHMARK_CONFIGS: BenchmarkConfig[] = [
  // ── Temperature sweep (prose) ──────────────────────────────────────
  {
    label: 'haiku-temp0.3',
    description: 'Haiku with low prose temperature (0.3)',
    overrides: { prose: { temperature: 0.3 } },
  },
  {
    label: 'haiku-temp0.5',
    description: 'Haiku with medium prose temperature (0.5)',
    overrides: { prose: { temperature: 0.5 } },
  },
  {
    label: 'haiku-baseline',
    description: 'Haiku with default settings (baseline)',
    overrides: {},
  },
  {
    label: 'haiku-temp0.9',
    description: 'Haiku with high prose temperature (0.9)',
    overrides: { prose: { temperature: 0.9 } },
  },

  // ── Max tokens sweep ───────────────────────────────────────────────
  {
    label: 'haiku-tokens50',
    description: 'Haiku with 50 max tokens (prose)',
    overrides: { prose: { maxTokens: 50 } },
  },
  {
    label: 'haiku-tokens100',
    description: 'Haiku with 100 max tokens (prose, default)',
    overrides: { prose: { maxTokens: 100 } },
  },
  {
    label: 'haiku-tokens200',
    description: 'Haiku with 200 max tokens (prose)',
    overrides: { prose: { maxTokens: 200 } },
  },

  // ── Context size sweep ─────────────────────────────────────────────
  {
    label: 'haiku-context1000',
    description: 'Haiku with 1000 char prose context',
    overrides: { prose: { contextChars: 1000 } },
  },
  {
    label: 'haiku-context2000',
    description: 'Haiku with 2000 char prose context (default)',
    overrides: { prose: { contextChars: 2000 } },
  },
  {
    label: 'haiku-context4000',
    description: 'Haiku with 4000 char prose context',
    overrides: { prose: { contextChars: 4000 } },
  },

  // ── Code temperature sweep ─────────────────────────────────────────
  {
    label: 'haiku-code-temp0.0',
    description: 'Haiku with code temperature 0.0',
    overrides: { code: { temperature: 0.0 } },
  },
  {
    label: 'haiku-code-temp0.1',
    description: 'Haiku with code temperature 0.1',
    overrides: { code: { temperature: 0.1 } },
  },
  {
    label: 'haiku-code-temp0.2',
    description: 'Haiku with code temperature 0.2 (default)',
    overrides: { code: { temperature: 0.2 } },
  },

  // ── Model comparison ───────────────────────────────────────────────
  {
    label: 'sonnet-baseline',
    description: 'Sonnet with default settings',
    overrides: { anthropic: { model: 'claude-sonnet-4-20250514' } },
  },
  {
    label: 'opus-baseline',
    description: 'Opus with default settings',
    overrides: { anthropic: { model: 'claude-opus-4-20250514' } },
  },
];

/**
 * Returns configs to run, filtered by BENCHMARK_CONFIGS env var.
 * If unset, returns all configs.
 */
export function getConfigsToRun(): BenchmarkConfig[] {
  const filter = process.env.BENCHMARK_CONFIGS;
  if (!filter) return BENCHMARK_CONFIGS;

  const labels = new Set(
    filter
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const filtered = BENCHMARK_CONFIGS.filter((c) => labels.has(c.label));

  if (filtered.length === 0) {
    const available = BENCHMARK_CONFIGS.map((c) => c.label).join(', ');
    throw new Error(
      `No matching configs for BENCHMARK_CONFIGS="${filter}". Available: ${available}`,
    );
  }

  return filtered;
}
