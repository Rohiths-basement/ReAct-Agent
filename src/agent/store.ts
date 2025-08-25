import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { Run, Step } from './types.js';

export class JsonStore {
  constructor(private baseDir: string) {}

  private path(runId: string) { return `${this.baseDir}/runs/${runId}.json`; }

  load(runId: string): Run | null {
    const p = this.path(runId);
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, 'utf-8');
    return JSON.parse(raw) as Run;
  }

  save(run: Run) {
    const p = this.path(run.runId);
    mkdirSync(`${this.baseDir}/runs`, { recursive: true });
    writeFileSync(p, JSON.stringify(run, null, 2), 'utf-8');
  }

  create(runId: string, task: string): Run {
    const now = Date.now();
    const run: Run = { runId, task, createdAt: now, updatedAt: now, status: 'running', steps: [] };
    this.save(run);
    return run;
  }

  appendStep(run: Run, step: Step) {
    run.steps.push(step);
    run.updatedAt = Date.now();
    this.save(run);
  }
}

