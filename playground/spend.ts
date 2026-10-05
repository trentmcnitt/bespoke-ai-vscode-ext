/**
 * Daily API spend cap for the playground (default $5/day, PLAYGROUND_DAILY_CAP_USD
 * to change). The tally is the estimated cost from prices.ts, kept per local date
 * in playground/.data/spend.json (gitignored), so a restart doesn't reset it.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const FILE = join(__dirname, '.data', 'spend.json');

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export class SpendTally {
  private date = today();
  private usd = 0;
  private runs = 0;

  constructor(readonly capUsd: number) {
    try {
      const saved = JSON.parse(readFileSync(FILE, 'utf8')) as {
        date: string;
        usd: number;
        runs: number;
      };
      if (saved.date === this.date) {
        this.usd = saved.usd;
        this.runs = saved.runs;
      }
    } catch {
      // first run, or unreadable: start from zero
    }
  }

  private roll(): void {
    const d = today();
    if (d !== this.date) {
      this.date = d;
      this.usd = 0;
      this.runs = 0;
    }
  }

  overCap(): boolean {
    this.roll();
    return this.usd >= this.capUsd;
  }

  add(usd: number): void {
    this.roll();
    this.usd += usd;
    this.runs += 1;
    try {
      mkdirSync(join(__dirname, '.data'), { recursive: true });
      writeFileSync(FILE, JSON.stringify({ date: this.date, usd: this.usd, runs: this.runs }));
    } catch (err) {
      console.error('[playground] could not save spend tally', err);
    }
  }

  status(): { date: string; usd: number; runs: number; capUsd: number } {
    this.roll();
    return { date: this.date, usd: this.usd, runs: this.runs, capUsd: this.capUsd };
  }
}
