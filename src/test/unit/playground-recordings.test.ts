/**
 * Guards the published playground recordings (playground/recordings/): they go on a
 * public site with content_mode "full", so every document in them must be a
 * synthetic quality scenario, byte for byte, and every recording must be a
 * well-formed bench recording.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { scenarioById } from '../../../playground/scenarios';
import { regressionScenarios } from '../quality/regression-scenarios';
import type { ReplayIndex } from '../../../playground/record';

const DIR = join(__dirname, '../../../playground/recordings');
const index: ReplayIndex = JSON.parse(readFileSync(join(DIR, 'index.json'), 'utf8'));
const topology = JSON.parse(readFileSync(join(DIR, '../topology.json'), 'utf8'));

function readRecording(file: string) {
  const rows = readFileSync(join(DIR, file), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  return { header: rows[0], events: rows.slice(1) };
}

describe('playground recordings', () => {
  it('has runs', () => {
    expect(index.v).toBe('bespoke-replay/0');
    expect(index.runs.length).toBeGreaterThan(0);
  });

  it('every document is a synthetic scenario, unchanged', () => {
    const regressionIds = new Set(regressionScenarios.map((s) => s.id));
    for (const [id, doc] of Object.entries(index.scenarios)) {
      expect(regressionIds.has(id)).toBe(false);
      const s = scenarioById.get(id);
      expect(s, id).toBeDefined();
      expect(doc.prefix).toBe(s!.prefix);
      expect(doc.suffix).toBe(s!.suffix);
    }
  });

  it('no stray files: exactly the index and one recording per run', () => {
    const files = readdirSync(DIR).sort();
    expect(files).toEqual(['index.json', ...index.runs.map((r) => r.recording)].sort());
  });

  it.each(index.runs.map((r) => [r.id, r] as const))('%s: well-formed recording', (_, run) => {
    expect(index.scenarios[run.scenarioId]).toBeDefined();
    const { header, events } = readRecording(run.recording);
    expect(header.v).toBe('bench-recording/0');
    expect(header.topology).toEqual(topology);
    const runIds = new Set(events.map((e) => e.run_id));
    expect(runIds.size).toBe(1);
    expect(events[0].event_type).toBe('run_started');
    const last = events[events.length - 1];
    expect(last.event_type).toBe('run_finished');
    expect(last.data.outcome).toBe(run.outcome);
    // The ghost text the page shows is the one the bench reports.
    expect(last.data.output).toBe(run.text);
    // The Model I/O panel's fields: prompt as sent, raw output as returned.
    const llm = events.find((e) => e.event_type === 'llm_call');
    if (llm) {
      expect(typeof llm.data.system).toBe('string');
      expect(llm.data.messages[0].role).toBe('user');
      expect('output' in llm.data).toBe(true);
    }
    // Prompt content in the recording comes from the scenario (no other text).
    const built = events.find((e) => e.node === 'prompt_build' && e.event_type === 'step_finished');
    const doc = index.scenarios[run.scenarioId];
    const tail = doc.prefix.slice(-200);
    expect(String(built.data.output)).toContain(tail);
  });
});
