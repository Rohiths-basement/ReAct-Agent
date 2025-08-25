import { ToolSpec } from '../tools/types.js';
import { ToolRegistry } from '../tools/registry.js';

interface ToolChain {
  id: string;
  name: string;
  description: string;
  steps: Array<{
    tool: string;
    outputMapping?: Record<string, string>;
    condition?: (prevOutputs: any[]) => boolean;
  }>;
  parallel?: boolean;
}

interface ComposedTool extends ToolSpec<any> {
  chain: ToolChain;
  originalTools: string[];
}

export class ToolComposer {
  private compositions = new Map<string, ComposedTool>();
  private learningData = new Map<string, { success: number; total: number; avgTime: number }>();

  constructor(private registry: ToolRegistry) {}

  // Automatically discover and create tool compositions based on usage patterns
  async discoverCompositions(taskHistory: Array<{ task: string; tools: string[]; success: boolean; duration: number }>): Promise<void> {
    const patterns = this.analyzeToolPatterns(taskHistory);
    
    for (const pattern of patterns) {
      if (pattern.frequency > 3 && pattern.successRate > 0.8) {
        await this.createComposition(pattern);
      }
    }
  }

  private analyzeToolPatterns(history: Array<{ task: string; tools: string[]; success: boolean; duration: number }>) {
    const sequences = new Map<string, { count: number; successes: number; totalTime: number }>();
    
    for (const run of history) {
      if (run.tools.length >= 2) {
        const sequence = run.tools.join(' -> ');
        const existing = sequences.get(sequence) || { count: 0, successes: 0, totalTime: 0 };
        sequences.set(sequence, {
          count: existing.count + 1,
          successes: existing.successes + (run.success ? 1 : 0),
          totalTime: existing.totalTime + run.duration
        });
      }
    }

    return Array.from(sequences.entries()).map(([sequence, stats]) => ({
      tools: sequence.split(' -> '),
      frequency: stats.count,
      successRate: stats.successes / stats.count,
      avgTime: stats.totalTime / stats.count
    }));
  }

  private async createComposition(pattern: { tools: string[]; frequency: number; successRate: number; avgTime: number }) {
    const compositionId = `composed_${pattern.tools.join('_')}`;
    const compositionName = `${pattern.tools[0]}_to_${pattern.tools[pattern.tools.length - 1]}`;
    
    const chain: ToolChain = {
      id: compositionId,
      name: compositionName,
      description: `Optimized chain: ${pattern.tools.join(' → ')} (${Math.round(pattern.successRate * 100)}% success rate)`,
      steps: pattern.tools.map((tool, i) => ({
        tool,
        outputMapping: i > 0 ? this.inferOutputMapping(pattern.tools[i-1], tool) : undefined
      }))
    };

    const self = this;
    const composedTool: ComposedTool = {
      name: compositionName,
      description: chain.description,
      schema: this.createComposedSchema(pattern.tools),
      chain,
      originalTools: pattern.tools,
      async run(args: any) {
        return await self.executeChain(chain, args);
      }
    };

    this.compositions.set(compositionId, composedTool);
    console.log(`🔗 Created tool composition: ${compositionName}`);
  }

  private inferOutputMapping(fromTool: string, toTool: string): Record<string, string> {
    // Smart mapping based on common patterns
    const mappings: Record<string, Record<string, string>> = {
      'web_search->summarize_text': { 'results': 'text' },
      'file_read->summarize_text': { 'content': 'text' },
      'web_fetch->html_extract': { 'content': 'html' },
      'csv_read->json_read': { 'data': 'content' }
    };
    
    return mappings[`${fromTool}->${toTool}`] || {};
  }

  private createComposedSchema(tools: string[]) {
    // Merge schemas from constituent tools
    const { z } = require('zod');
    return z.object({
      input: z.any().describe('Input for the tool chain'),
      options: z.object({}).optional().describe('Chain execution options')
    });
  }

  async executeChain(chain: ToolChain, args: any): Promise<any> {
    const outputs: any[] = [];
    let currentInput = args.input;

    for (const step of chain.steps) {
      if (step.condition && !step.condition(outputs)) {
        continue;
      }

      const tool = this.registry.get(step.tool);
      if (!tool) throw new Error(`Tool ${step.tool} not found in chain`);

      // Map previous outputs to current input
      if (step.outputMapping && outputs.length > 0) {
        const lastOutput = outputs[outputs.length - 1];
        for (const [from, to] of Object.entries(step.outputMapping)) {
          if (lastOutput[from]) {
            currentInput = { ...currentInput, [to]: lastOutput[from] };
          }
        }
      }

      const result = await tool.run(currentInput);
      outputs.push(result);
      currentInput = result;
    }

    return {
      chainResult: outputs[outputs.length - 1],
      intermediateOutputs: outputs,
      executedSteps: chain.steps.length
    };
  }

  getCompositions(): ComposedTool[] {
    return Array.from(this.compositions.values());
  }

  // Register a composition with the main tool registry
  registerWithRegistry(): void {
    for (const composition of this.compositions.values()) {
      // Add to registry as a regular tool
      (this.registry as any).tools.set(composition.name, composition);
    }
  }
}
