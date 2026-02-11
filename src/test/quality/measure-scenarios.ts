/**
 * Measures character counts for all quality test scenarios.
 * Shows raw sizes, post-truncation sizes, and saturation declaration cross-check.
 * Run: npx tsx src/test/quality/measure-scenarios.ts
 */
import {
  proseScenarios,
  codeScenarios,
  edgeCaseScenarios,
  reuseQualityScenarios,
} from './scenarios';
import { regressionScenarios } from './regression-scenarios';
import {
  proseMidDocumentScenarios,
  proseJournalScenarios,
  proseBridgingScenarios,
  codeMidFileScenarios,
  prosePromptWritingScenarios,
  proseFullWindowScenarios,
  codeFullWindowScenarios,
} from './scenarios/index';
import { TestScenario } from './judge';
import { truncatePrefix, truncateSuffix } from '../../utils/truncation';

const PREFIX_WINDOW = 2500; // Default config.prose.contextChars / config.code.contextChars
const SUFFIX_WINDOW = 2000; // Default config.prose.suffixChars / config.code.suffixChars

interface Measurement {
  id: string;
  category: string;
  mode: string;
  rawPrefixLen: number;
  rawSuffixLen: number;
  truncPrefixLen: number;
  truncSuffixLen: number;
  totalRawLen: number;
  prefixSaturated: boolean; // raw prefix > PREFIX_WINDOW
  suffixSaturated: boolean; // raw suffix > SUFFIX_WINDOW
  saturationLabel: string;
  // Saturation declaration cross-check
  declaredPrefixSat: string;
  declaredSuffixSat: string;
  prefixMatch: boolean;
  suffixMatch: boolean;
}

function classify(prefix: number, suffix: number): string {
  const pSat = prefix > PREFIX_WINDOW;
  const sSat = suffix > SUFFIX_WINDOW;
  if (pSat && sSat) return 'FULL (both saturated)';
  if (pSat && suffix > 0) return 'PREFIX-SAT + partial suffix';
  if (pSat && suffix === 0) return 'PREFIX-SAT + no suffix';
  if (sSat && prefix > 0) return 'partial prefix + SUFFIX-SAT';
  if (suffix === 0) return 'short prefix + no suffix';
  return 'short prefix + short suffix';
}

function checkSaturation(
  scenario: TestScenario,
  rawPrefix: number,
  rawSuffix: number,
): { declPrefix: string; declSuffix: string; prefixOk: boolean; suffixOk: boolean } {
  const declPrefix = scenario.saturation.prefix;
  const declSuffix = scenario.saturation.suffix;

  const prefixOk =
    declPrefix === 'saturated' ? rawPrefix > PREFIX_WINDOW : rawPrefix <= PREFIX_WINDOW;

  let suffixOk: boolean;
  if (declSuffix === 'none') {
    suffixOk = rawSuffix === 0;
  } else if (declSuffix === 'saturated') {
    suffixOk = rawSuffix > SUFFIX_WINDOW;
  } else {
    suffixOk = rawSuffix <= SUFFIX_WINDOW && rawSuffix > 0;
  }

  return { declPrefix, declSuffix, prefixOk, suffixOk };
}

function measure(scenarios: TestScenario[], category: string): Measurement[] {
  return scenarios.map((s) => {
    const rp = s.prefix.length;
    const rs = s.suffix.length;
    const prefixChars = s.contextWindow?.prefixChars ?? PREFIX_WINDOW;
    const suffixChars = s.contextWindow?.suffixChars ?? SUFFIX_WINDOW;
    const tp = truncatePrefix(s.prefix, prefixChars).length;
    const ts = truncateSuffix(s.suffix, suffixChars).length;
    const sat = checkSaturation(s, rp, rs);
    return {
      id: s.id,
      category,
      mode: s.mode,
      rawPrefixLen: rp,
      rawSuffixLen: rs,
      truncPrefixLen: tp,
      truncSuffixLen: ts,
      totalRawLen: rp + rs,
      prefixSaturated: rp > PREFIX_WINDOW,
      suffixSaturated: rs > SUFFIX_WINDOW,
      saturationLabel: classify(rp, rs),
      declaredPrefixSat: sat.declPrefix,
      declaredSuffixSat: sat.declSuffix,
      prefixMatch: sat.prefixOk,
      suffixMatch: sat.suffixOk,
    };
  });
}

const all: Measurement[] = [
  ...measure(proseScenarios, 'standard-prose'),
  ...measure(codeScenarios, 'standard-code'),
  ...measure(edgeCaseScenarios, 'edge-case'),
  ...measure(reuseQualityScenarios, 'reuse'),
  ...measure(regressionScenarios, 'regression'),
  ...measure(proseMidDocumentScenarios, 'prose-mid-document'),
  ...measure(proseJournalScenarios, 'prose-journal'),
  ...measure(proseBridgingScenarios, 'prose-bridging'),
  ...measure(codeMidFileScenarios, 'code-mid-file'),
  ...measure(prosePromptWritingScenarios, 'prose-prompt-writing'),
  ...measure(proseFullWindowScenarios, 'prose-full-window'),
  ...measure(codeFullWindowScenarios, 'code-full-window'),
];

// ─── Per-scenario table ────────────────────────────────────────────
console.log('\n=== SCENARIO CHARACTER COUNTS (raw → truncated) ===\n');
console.log(
  'ID'.padEnd(48) +
    'Category'.padEnd(22) +
    'RawPfx'.padStart(8) +
    '→Trunc'.padStart(8) +
    'RawSfx'.padStart(8) +
    '→Trunc'.padStart(8) +
    '  Saturation' +
    '  Decl',
);
console.log('-'.repeat(140));

for (const m of all) {
  const pfxTrunc = m.rawPrefixLen !== m.truncPrefixLen ? `${m.truncPrefixLen}` : '=';
  const sfxTrunc = m.rawSuffixLen !== m.truncSuffixLen ? `${m.truncSuffixLen}` : '=';
  const pfxMark = m.prefixMatch ? '' : ' ✗';
  const sfxMark = m.suffixMatch ? '' : ' ✗';
  const decl = `${m.declaredPrefixSat}/${m.declaredSuffixSat}${pfxMark}${sfxMark}`;
  console.log(
    m.id.padEnd(48) +
      m.category.padEnd(22) +
      m.rawPrefixLen.toString().padStart(8) +
      pfxTrunc.padStart(8) +
      m.rawSuffixLen.toString().padStart(8) +
      sfxTrunc.padStart(8) +
      '  ' +
      m.saturationLabel.padEnd(30) +
      decl,
  );
}

// ─── Saturation declaration cross-check ───────────────────────────
const mismatches = all.filter((m) => !m.prefixMatch || !m.suffixMatch);
if (mismatches.length > 0) {
  console.log('\n=== ✗ SATURATION DECLARATION MISMATCHES ===\n');
  for (const m of mismatches) {
    const issues: string[] = [];
    if (!m.prefixMatch)
      issues.push(`prefix: declared=${m.declaredPrefixSat}, actual=${m.rawPrefixLen} chars`);
    if (!m.suffixMatch)
      issues.push(`suffix: declared=${m.declaredSuffixSat}, actual=${m.rawSuffixLen} chars`);
    console.log(`  ${m.id}: ${issues.join('; ')}`);
  }
} else {
  console.log('\n=== ✓ All saturation declarations match actual sizes ===');
}

// ─── Summary by category ───────────────────────────────────────────
console.log('\n=== SUMMARY BY CATEGORY ===\n');
const categories = [...new Set(all.map((m) => m.category))];
for (const cat of categories) {
  const items = all.filter((m) => m.category === cat);
  const avgPrefix = Math.round(items.reduce((s, m) => s + m.rawPrefixLen, 0) / items.length);
  const avgSuffix = Math.round(items.reduce((s, m) => s + m.rawSuffixLen, 0) / items.length);
  const saturatedBoth = items.filter((m) => m.prefixSaturated && m.suffixSaturated).length;
  const saturatedPrefix = items.filter((m) => m.prefixSaturated && !m.suffixSaturated).length;
  const noSuffix = items.filter((m) => m.rawSuffixLen === 0).length;
  console.log(
    `${cat} (${items.length} scenarios): avg prefix=${avgPrefix}, avg suffix=${avgSuffix}` +
      ` | both-sat=${saturatedBoth}, prefix-only-sat=${saturatedPrefix}, no-suffix=${noSuffix}`,
  );
}

// ─── Saturation distribution ───────────────────────────────────────
console.log('\n=== SATURATION DISTRIBUTION ===\n');
const satLabels = [...new Set(all.map((m) => m.saturationLabel))];
for (const label of satLabels) {
  const count = all.filter((m) => m.saturationLabel === label).length;
  const pct = ((count / all.length) * 100).toFixed(1);
  console.log(`  ${label}: ${count} (${pct}%)`);
}
console.log(`\n  Total scenarios: ${all.length}`);
console.log(`  Prefix window: ${PREFIX_WINDOW} chars`);
console.log(`  Suffix window: ${SUFFIX_WINDOW} chars`);

// ─── Truncation impact ──────────────────────────────────────────────
const truncated = all.filter(
  (m) => m.rawPrefixLen !== m.truncPrefixLen || m.rawSuffixLen !== m.truncSuffixLen,
);
console.log(`\n=== TRUNCATION IMPACT ===\n`);
console.log(`  Scenarios affected by truncation: ${truncated.length}/${all.length}`);
for (const m of truncated) {
  const parts: string[] = [];
  if (m.rawPrefixLen !== m.truncPrefixLen)
    parts.push(`prefix ${m.rawPrefixLen}→${m.truncPrefixLen}`);
  if (m.rawSuffixLen !== m.truncSuffixLen)
    parts.push(`suffix ${m.rawSuffixLen}→${m.truncSuffixLen}`);
  console.log(`  ${m.id}: ${parts.join(', ')}`);
}

// ─── Mode distribution ──────────────────────────────────────────────
console.log('\n=== MODE DISTRIBUTION ===\n');
const proseCount = all.filter((m) => m.mode === 'prose').length;
const codeCount = all.filter((m) => m.mode === 'code').length;
console.log(`  Prose: ${proseCount} (${((proseCount / all.length) * 100).toFixed(1)}%)`);
console.log(`  Code: ${codeCount} (${((codeCount / all.length) * 100).toFixed(1)}%)`);
