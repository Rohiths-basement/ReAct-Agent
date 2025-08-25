import chalk from 'chalk';
import { randomUUID } from 'node:crypto';
import { Agent } from './agent.js';
import { JsonStore } from './store.js';
import { AppConfig } from '../config.js';
import { LLM } from '../llm/interfaces.js';
import { ToolRegistry } from '../tools/registry.js';
import { Step } from './types.js';

export type CollaborationStrategy = 'debate' | 'swarm';

export class MultiAgentCoordinator {
  constructor(private deps: { cfg: AppConfig; llm: LLM; store: JsonStore; registry: ToolRegistry }) {}

  async collaborate(params: {
    runId: string;
    task: string;
    agents?: number;
    strategy?: CollaborationStrategy;
    topK?: number;
    maxStepsPerAgent?: number;
  }): Promise<void> {
    const {
      runId,
      task,
      agents = 2,
      strategy = 'debate',
      topK = this.deps.cfg.TOPK_TOOLS,
      maxStepsPerAgent = Math.min(this.deps.cfg.MAX_STEPS, 6),
    } = params;

    // Parent run (coordination log)
    const parentRun = this.deps.store.create(runId, `[Collab:${strategy}] ${task}`);
    await this.append(parentRun, {
      kind: 'thought',
      data: { note: `Starting ${strategy} with ${agents} agents`, task },
      runId,
      id: randomUUID(),
      ts: Date.now(),
    });

    // Prepare agent personas
    const personas = this.buildPersonas(agents, strategy);

    // Launch child agents sequentially (simple and robust)
    const childRunIds: string[] = [];
    const childFinals: Array<{ runId: string; output: string | null }> = [];

    for (let i = 0; i < agents; i++) {
      const persona = personas[i];
      const childId = `${runId}-a${i + 1}`;
      childRunIds.push(childId);

      const agentCfg = { ...this.deps.cfg, MAX_STEPS: maxStepsPerAgent } as AppConfig;
      const agent = new Agent({ cfg: agentCfg, llm: this.deps.llm, store: this.deps.store, registry: this.deps.registry });

      const agentTask = `${task}\nRole: ${persona}`;
      console.log(chalk.magenta(`\n🤝 Agent ${i + 1}/${agents} (${persona}) starting…`));
      await agent.run({ runId: childId, task: agentTask, topK });

      // Extract final output from child run
      const childRun = this.deps.store.load(childId);
      const finalStep = childRun?.steps?.slice().reverse().find(s => s.kind === 'final');
      const finalText = finalStep ? (finalStep.data?.output ?? null) : null;
      childFinals.push({ runId: childId, output: finalText });

      await this.append(parentRun, {
        kind: 'observation',
        data: { child: childId, persona, final: finalText },
        runId,
        id: randomUUID(),
        ts: Date.now(),
      });
    }

    // Synthesize consensus
    const synthesis = await this.synthesize(task, personas, childFinals);
    await this.append(parentRun, {
      kind: 'final',
      data: { output: synthesis, rationale: 'Multi-agent consensus synthesis' },
      runId,
      id: randomUUID(),
      ts: Date.now(),
    });
    parentRun.status = 'done';
    this.deps.store.save(parentRun);

    console.log(chalk.bold(`\n✅ Collaboration complete`));
    console.log(synthesis);
  }

  private async synthesize(
    task: string,
    personas: string[],
    childFinals: Array<{ runId: string; output: string | null }>
  ): Promise<string> {
    const summaries = childFinals
      .map((c, i) => `Agent ${i + 1} (${personas[i]}):\n${c.output ?? '[no final answer produced]'}\n`)
      .join('\n');
    const prompt = [
      `You are the coordinator of multiple expert agents working on a task.`,
      `Task: ${task}`,
      `Each agent proposed a final answer. Compare, critique, and produce the best synthesized answer.`,
      `Prefer correctness, clarity, and completeness. If conflicting, reconcile and justify briefly.`,
      `Answers:`,
      summaries,
      `Final synthesized answer:`,
    ].join('\n\n');

    try {
      const out = await this.deps.llm.complete(prompt);
      return out.trim();
    } catch (e: any) {
      return `Synthesis failed: ${e?.message || String(e)}`;
    }
  }

  private buildPersonas(n: number, strategy: CollaborationStrategy): string[] {
    const base: string[] = strategy === 'debate'
      ? [
          'Researcher: gather concrete facts and sources',
          'Analyst: structure findings and reason step-by-step',
          'Skeptic: identify weaknesses and edge-cases',
          'Synthesizer: produce concise, actionable conclusions',
        ]
      : [
          'Generalist: broad coverage of the task',
          'Specialist A: deep dive into key subtopic A',
          'Specialist B: deep dive into key subtopic B',
          'Reviewer: ensure quality and coherence',
        ];
    const personas: string[] = [];
    for (let i = 0; i < n; i++) personas.push(base[i % base.length]);
    return personas;
  }

  private async append(run: { runId: string }, step: Step) {
    this.deps.store.appendStep(run as any, step);
  }
}
