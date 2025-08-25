import chalk from 'chalk';
import { nanoid } from 'nanoid';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { LLM } from '../llm/interfaces.js';
import { ToolRegistry } from '../tools/registry.js';
import { ToolSpec } from '../tools/types.js';
import { Planner } from './planner.js';
import { Run as BaseRun, Step as BaseStep } from './types';
import { ToolComposer } from './composer.js';
import { AdaptiveLearning } from './learning.js';
import { ParallelExecutor } from './parallel.js';
import { MetricsCollector } from '../observability/metrics.js';
import { DynamicToolGenerator } from '../tools/dynamic.js';
import { maybeApprove } from '../policy/approvals.js';
import { JsonStore } from './store.js';
import { AppConfig } from '../config.js';
import { ArgInferencer } from './arg_infer.js';

// Use base types directly
type Run = BaseRun;
type Step = BaseStep;

function safeTextPreview(text: string, maxLen = 50): string {
  return text.length > maxLen ? text.slice(0, maxLen) + '...' : text;
}

export class Agent {
  private planner: Planner;
  private interrupted = false;
  private breaker = new Map<string, { failures: number; openedUntil?: number }>();
  private toolComposer: ToolComposer;
  private adaptiveLearning: AdaptiveLearning;
  private parallelExecutor: ParallelExecutor;
  private dynamicToolGenerator: DynamicToolGenerator;
  private metrics: MetricsCollector;
  private argInferencer: ArgInferencer;

  constructor(private deps: { cfg: AppConfig, llm: LLM, store: JsonStore, registry: ToolRegistry }) {
    this.planner = new Planner(deps.llm, deps.registry);
    this.metrics = new MetricsCollector(deps.cfg);
    this.toolComposer = new ToolComposer(deps.registry);
    this.adaptiveLearning = new AdaptiveLearning(deps.cfg);
    this.parallelExecutor = new ParallelExecutor(deps.registry);
    this.dynamicToolGenerator = new DynamicToolGenerator(deps.llm, deps.registry);
    this.argInferencer = new ArgInferencer(deps.llm);
    process.on('SIGINT', () => { this.interrupted = true; });
  }

  async run({ runId, task, topK }: { runId: string; task: string; topK: number }) {
    let run: Run = this.deps.store.create(runId, task);
    console.log(chalk.green(`Task: ${task}`));
    console.log(chalk.gray(`Run ID: ${runId}`));

    const history: string[] = [];
    let consecutiveFailures = 0;
    
    for (let stepNo = 1; stepNo <= this.deps.cfg.MAX_STEPS; stepNo++) {
      if (this.interrupted) { await this.markInterrupted(run, 'User interrupt'); return; }
      
      console.log(chalk.blue(`\n--- Step ${stepNo}/${this.deps.cfg.MAX_STEPS} ---`));
      
      const action = await this.planner.proposeNext(task, history, topK);
      await this.append(run, { kind: 'thought', data: { step: stepNo, action: action.type, tool: (action as any).tool, rationale: (action as any).rationale }, runId, id: nanoid(), ts: Date.now() });
      
      console.log(chalk.yellow(`Action: ${action.type}${(action as any).tool ? ` (${(action as any).tool})` : ''}`));
      console.log(chalk.gray(`Rationale: ${(action as any).rationale || 'N/A'}`));
      
      if (action.type === 'final_answer') {
        console.log(chalk.bold(`\n✅ Final Answer:`));
        console.log(action.output);
        await this.append(run, { kind: 'final', data: action, runId, id: nanoid(), ts: Date.now() });
        run.status = 'done'; this.deps.store.save(run); return;
      }
      if (action.type === 'ask_human') {
        const summary = `ask_human(${safeTextPreview(action.question)})`;
        if (this.deps.cfg.APPROVAL_MODE === 'always') {
          await this.append(run, { kind: 'approval-request', data: { summary, sensitive: false }, runId, id: nanoid(), ts: Date.now() });
          const ok = await maybeApprove('always', summary, false);
          await this.append(run, { kind: 'approval-response', data: { approved: !!ok }, runId, id: nanoid(), ts: Date.now() });
          if (!ok) { await this.markInterrupted(run, 'User denied input'); return; }
        }
        console.log(chalk.yellow(`\nQuestion for you: ${action.question}`));
        const rl = readline.createInterface({ input, output });
        const answer = await rl.question(`Your answer: `);
        rl.close();
        history.push(`Human: ${answer}`);
        await this.append(run, { kind: 'observation', data: { human: true, question: action.question, answer }, runId, id: nanoid(), ts: Date.now() });
        continue;
      }
      // use_tool
      const tool = this.deps.registry.get(action.tool)!;
      // Try to infer/repair args before approval so user sees accurate intent
      let candidateArgs: any = (action as any).args;
      let parsed = (tool as any).schema?.safeParse ? (tool as any).schema.safeParse(candidateArgs) : { success: true, data: candidateArgs };
      if (!parsed.success) {
        const inferred = await this.argInferencer.infer(tool as ToolSpec<any>, task, history, candidateArgs);
        if (inferred) {
          candidateArgs = inferred;
          parsed = (tool as any).schema?.safeParse ? (tool as any).schema.safeParse(candidateArgs) : { success: true, data: candidateArgs };
        }
      }
      const summaryArgText = typeof candidateArgs === 'string' ? candidateArgs : JSON.stringify(candidateArgs ?? '');
      const summary = `${tool.name}(${safeTextPreview(summaryArgText)})`;
      await this.append(run, { kind: 'approval-request', data: { summary, sensitive: !!tool.sensitive }, runId, id: nanoid(), ts: Date.now() });
      const ok = await maybeApprove(this.deps.cfg.APPROVAL_MODE, summary, !!tool.sensitive);
      await this.append(run, { kind: 'approval-response', data: { approved: !!ok }, runId, id: nanoid(), ts: Date.now() });
      if (!ok) { await this.markInterrupted(run, 'User denied action'); return; }

      try {
        // validate args against tool schema if present (post-approval)
        if (!parsed.success) {
          const err = parsed.error?.errors || parsed.error || 'Invalid arguments';
          console.log(chalk.red(`\nArg validation failed for ${tool.name}:`), JSON.stringify(err));
          history.push(`Tool ${tool.name} args invalid: ${safeTextPreview(err)}`);
          await this.append(run, { kind: 'observation', data: { error: 'schema_validation', details: err }, runId, id: nanoid(), ts: Date.now() });
          continue;
        }
        const observation = await this.executeToolWithRetry(tool as ToolSpec<any>, parsed.data);
        console.log(chalk.cyan(`\n[${tool.name}] →`), preview(observation));
        history.push(`Used ${tool.name}, observed: ${preview(observation)}`);
        await this.append(run, { kind: 'tool', data: { tool: tool.name, args: parsed.data }, runId, id: nanoid(), ts: Date.now() });
        await this.append(run, { kind: 'observation', data: observation, runId, id: nanoid(), ts: Date.now() });
      } catch (err: any) {
        console.log(chalk.red(`\nTool error (${tool.name}): ${err.message || err}`));
        history.push(`Tool ${tool.name} failed: ${err?.message || String(err)}`);
        await this.append(run, { kind: 'observation', data: { error: String(err) }, runId, id: nanoid(), ts: Date.now() });
      }
    }
    console.log(chalk.yellow(`\nReached step limit (${this.deps.cfg.MAX_STEPS}). Consider resuming.`));
    run.status = 'paused'; this.deps.store.save(run);
  }

  async resume(runId: string) {
    const run = this.deps.store.load(runId);
    if (!run) throw new Error(`No such run: ${runId}`);
    if (run.status === 'done') { console.log('Run already completed.'); return; }
    if (run.status === 'failed') { console.log('Run failed earlier; manual fix needed.'); return; }
    console.log(chalk.cyan(`Resuming run ${runId}…`));
    // continue from scratch but with same runId; planner sees history via store if you pass it (simplified: we regenerate history from steps)
    const history: string[] = stepsToHistory(run);
    const task = run.task;
    const topK = this.deps.cfg.TOPK_TOOLS;

    run.status = 'running'; this.deps.store.save(run);
    for (let i = 0; i < this.deps.cfg.MAX_STEPS; i++) {
      if (this.interrupted) { await this.markInterrupted(run, 'User interrupt'); return; }
      const action = await this.planner.proposeNext(task, history, topK);
      await this.append(run, { kind: 'thought', data: { step: i + 1, action: action.type, tool: (action as any).tool, rationale: (action as any).rationale }, runId, id: nanoid(), ts: Date.now() });
      if (action.type === 'final_answer') {
        console.log(chalk.bold(`\nFinal Answer:`));
        console.log(action.output);
        await this.append(run, { kind: 'final', data: action, runId, id: nanoid(), ts: Date.now() });
        run.status = 'done'; this.deps.store.save(run); return;
      }
      if (action.type === 'ask_human') {
        const summary = `ask_human(${safeTextPreview(action.question)})`;
        if (this.deps.cfg.APPROVAL_MODE === 'always') {
          await this.append(run, { kind: 'approval-request', data: { summary, sensitive: false }, runId, id: nanoid(), ts: Date.now() });
          const okAsk = await maybeApprove('always', summary, false);
          await this.append(run, { kind: 'approval-response', data: { approved: !!okAsk }, runId, id: nanoid(), ts: Date.now() });
          if (!okAsk) { await this.markInterrupted(run, 'User denied input'); return; }
        }
        console.log(chalk.yellow(`\nQuestion for you: ${action.question}`));
        const rl = readline.createInterface({ input, output });
        const answer = await rl.question(`Your answer: `);
        rl.close();
        history.push(`Human: ${answer}`);
        await this.append(run, { kind: 'observation', data: { human: true, question: action.question, answer }, runId, id: nanoid(), ts: Date.now() });
        continue;
      }
      const tool = this.deps.registry.get(action.tool)!;
      // Pre-approval arg inference/repair during resume as well
      let candidateArgs: any = (action as any).args;
      let parsed = (tool as any).schema?.safeParse ? (tool as any).schema.safeParse(candidateArgs) : { success: true, data: candidateArgs };
      if (!parsed.success) {
        const inferred = await this.argInferencer.infer(tool as ToolSpec<any>, task, history, candidateArgs);
        if (inferred) {
          candidateArgs = inferred;
          parsed = (tool as any).schema?.safeParse ? (tool as any).schema.safeParse(candidateArgs) : { success: true, data: candidateArgs };
        }
      }
      const summaryArgText = typeof candidateArgs === 'string' ? candidateArgs : JSON.stringify(candidateArgs ?? '');
      const summary = `${tool.name}(${safeTextPreview(summaryArgText)})`;
      await this.append(run, { kind: 'approval-request', data: { summary, sensitive: !!tool.sensitive }, runId, id: nanoid(), ts: Date.now() });
      const ok = await maybeApprove(this.deps.cfg.APPROVAL_MODE, summary, !!tool.sensitive);
      await this.append(run, { kind: 'approval-response', data: { approved: !!ok }, runId, id: nanoid(), ts: Date.now() });
      if (!ok) { await this.markInterrupted(run, 'User denied action'); return; }

      try {
        if (!parsed.success) {
          const err = parsed.error?.errors || parsed.error || 'Invalid arguments';
          console.log(chalk.red(`\nArg validation failed for ${tool.name}:`), JSON.stringify(err));
      	history.push(`Tool ${tool.name} args invalid: ${safeTextPreview(err)}`);
          await this.append(run, { kind: 'observation', data: { error: 'schema_validation', details: err }, runId, id: nanoid(), ts: Date.now() });
          continue;
        }
        const observation = await this.executeToolWithRetry(tool as ToolSpec<any>, parsed.data);
        console.log(chalk.cyan(`\n[${tool.name}] →`), preview(observation));
        history.push(`Used ${tool.name}, observed: ${preview(observation)}`);
        await this.append(run, { kind: 'tool', data: { tool: tool.name, args: parsed.data }, runId, id: nanoid(), ts: Date.now() });
        await this.append(run, { kind: 'observation', data: observation, runId, id: nanoid(), ts: Date.now() });
      } catch (err: any) {
        console.log(chalk.red(`\nTool error (${tool.name}): ${err.message || err}`));
        history.push(`Tool ${tool.name} failed: ${err?.message || String(err)}`);
        await this.append(run, { kind: 'observation', data: { error: String(err) }, runId, id: nanoid(), ts: Date.now() });
      }
    }
    console.log(chalk.yellow(`\nReached step limit (${this.deps.cfg.MAX_STEPS}). Consider resuming.`));
    run.status = 'paused'; this.deps.store.save(run);
  }

  private async append(run: Run, step: Step) {
    this.deps.store.appendStep(run, step);
  }

  private async markInterrupted(run: Run, reason: string) {
    await this.append(run, { kind: 'interruption', data: { reason }, runId: run.runId, id: nanoid(), ts: Date.now() });
    run.status = 'paused'; this.deps.store.save(run);
    console.log(chalk.yellow(`\nPaused: ${reason}`));
  }

  private async executeToolWithRetry(tool: ToolSpec<any>, args: any): Promise<any> {
    const name = tool.name;
    const state = this.breaker.get(name) || { failures: 0, openedUntil: undefined as number | undefined };
    const now = Date.now();
    const breakerCfg = tool.breaker || { failureThreshold: 3, cooldownMs: 30_000 };
    if (state.openedUntil && now < state.openedUntil) {
      throw new Error(`circuit_open:${name}`);
    }
    const retryCfg = tool.retry || { retries: 2, baseDelayMs: 400 };
    let attempt = 0;
    let lastErr: any;
    while (attempt <= (retryCfg.retries ?? 2)) {
      try {
        const res = await tool.run(args);
        // success: reset breaker
        this.breaker.set(name, { failures: 0, openedUntil: undefined });
        return res;
      } catch (err: any) {
        lastErr = err;
        if (attempt === (retryCfg.retries ?? 2)) break;
        const delay = (retryCfg.baseDelayMs ?? 400) * Math.pow(2, attempt);
        await new Promise(res => setTimeout(res, delay));
        attempt++;
      }
    }
    // record failure and maybe open circuit
    const failures = (state.failures ?? 0) + 1;
    if (failures >= (breakerCfg.failureThreshold ?? 3)) {
      const openedUntil = Date.now() + (breakerCfg.cooldownMs ?? 30_000);
      this.breaker.set(name, { failures: 0, openedUntil });
    } else {
      this.breaker.set(name, { failures, openedUntil: undefined });
    }
    throw lastErr;
  }
}

function stepsToHistory(run: Run): string[] {
  const h: string[] = [];
  for (const s of run.steps) {
    if (s.kind === 'tool') h.push(`Used ${s.data.tool} with ${JSON.stringify(s.data.args)}`);
    if (s.kind === 'observation') h.push(`Observed: ${preview(s.data)}`);
    if (s.kind === 'final') h.push(`Final: ${s.data.output}`);
  }
  return h;
}

function preview(o: any): string {
  const s = typeof o === 'string' ? o : JSON.stringify(o);
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}

