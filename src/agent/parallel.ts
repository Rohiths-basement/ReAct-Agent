import { ToolSpec } from '../tools/types.js';
import { ToolRegistry } from '../tools/registry.js';
import { PlannerAction } from './types.js';

interface ParallelTask {
  id: string;
  action: PlannerAction;
  dependencies: string[];
  priority: number;
  estimatedDuration: number;
}

interface TaskGraph {
  tasks: Map<string, ParallelTask>;
  dependencies: Map<string, Set<string>>;
  completed: Set<string>;
  running: Set<string>;
  failed: Set<string>;
}

export class ParallelExecutor {
  private maxConcurrency: number = 3;
  private runningTasks = new Map<string, Promise<any>>();

  constructor(private registry: ToolRegistry) {}

  // Decompose a complex task into parallelizable subtasks
  decomposeTask(task: string, availableTools: string[]): ParallelTask[] {
    const subtasks: ParallelTask[] = [];
    const taskLower = task.toLowerCase();

    // Pattern: "Find X and Y and summarize both"
    if (taskLower.includes(' and ') && (taskLower.includes('find') || taskLower.includes('search'))) {
      const parts = task.split(/\s+and\s+/i);
      parts.forEach((part, i) => {
        if (part.trim()) {
          subtasks.push({
            id: `search_${i}`,
            action: {
              type: 'use_tool',
              tool: 'web_search',
              args: { query: part.trim(), maxResults: 3 },
              rationale: `Parallel search for: ${part.trim()}`
            },
            dependencies: [],
            priority: 1,
            estimatedDuration: 5000
          });
        }
      });

      // Add summarization task that depends on all searches
      subtasks.push({
        id: 'final_summary',
        action: {
          type: 'use_tool',
          tool: 'summarize_text',
          args: { text: '', instruction: task },
          rationale: 'Combine and summarize all search results'
        },
        dependencies: subtasks.map(t => t.id),
        priority: 2,
        estimatedDuration: 3000
      });
    }

    // Pattern: "Compare X vs Y"
    else if (taskLower.includes(' vs ') || taskLower.includes(' versus ') || taskLower.includes('compare')) {
      const compareTerms = this.extractComparisonTerms(task);
      compareTerms.forEach((term, i) => {
        subtasks.push({
          id: `research_${i}`,
          action: {
            type: 'use_tool',
            tool: 'web_search',
            args: { query: `${term} features benefits overview`, maxResults: 3 },
            rationale: `Research ${term} for comparison`
          },
          dependencies: [],
          priority: 1,
          estimatedDuration: 5000
        });
      });

      subtasks.push({
        id: 'comparison_summary',
        action: {
          type: 'use_tool',
          tool: 'summarize_text',
          args: { text: '', instruction: `Compare ${compareTerms.join(' vs ')} based on the research` },
          rationale: 'Create comparison summary'
        },
        dependencies: subtasks.map(t => t.id),
        priority: 2,
        estimatedDuration: 4000
      });
    }

    // Pattern: "Process multiple files"
    else if (taskLower.includes('files') && (taskLower.includes('read') || taskLower.includes('analyze'))) {
      // This would need file discovery first, but we can set up the pattern
      subtasks.push({
        id: 'file_discovery',
        action: {
          type: 'ask_human',
          question: 'Which files would you like me to process?',
          rationale: 'Need file paths for parallel processing'
        },
        dependencies: [],
        priority: 1,
        estimatedDuration: 1000
      });
    }

    return subtasks;
  }

  private extractComparisonTerms(task: string): string[] {
    const patterns = [
      /compare\s+(.+?)\s+(?:vs|versus|and)\s+(.+?)(?:\s|$)/i,
      /(.+?)\s+(?:vs|versus)\s+(.+?)(?:\s|$)/i
    ];

    for (const pattern of patterns) {
      const match = task.match(pattern);
      if (match) {
        return [match[1].trim(), match[2].trim()];
      }
    }

    return [];
  }

  // Execute tasks in parallel with dependency management
  async executeParallel(tasks: ParallelTask[]): Promise<Map<string, any>> {
    const graph = this.buildTaskGraph(tasks);
    const results = new Map<string, any>();
    
    while (graph.completed.size < tasks.length && graph.failed.size === 0) {
      const readyTasks = this.getReadyTasks(graph);
      
      if (readyTasks.length === 0 && graph.running.size === 0) {
        throw new Error('Deadlock detected in task dependencies');
      }

      // Start new tasks up to concurrency limit
      const availableSlots = this.maxConcurrency - graph.running.size;
      const tasksToStart = readyTasks.slice(0, availableSlots);

      for (const task of tasksToStart) {
        graph.running.add(task.id);
        
        const promise = this.executeTask(task, results).then(result => {
          results.set(task.id, result);
          graph.completed.add(task.id);
          graph.running.delete(task.id);
          return result;
        }).catch(error => {
          graph.failed.add(task.id);
          graph.running.delete(task.id);
          throw error;
        });

        this.runningTasks.set(task.id, promise);
      }

      // Wait for at least one task to complete
      if (graph.running.size > 0) {
        await Promise.race(Array.from(this.runningTasks.values()));
      }
    }

    if (graph.failed.size > 0) {
      throw new Error(`Tasks failed: ${Array.from(graph.failed).join(', ')}`);
    }

    return results;
  }

  private buildTaskGraph(tasks: ParallelTask[]): TaskGraph {
    const graph: TaskGraph = {
      tasks: new Map(),
      dependencies: new Map(),
      completed: new Set(),
      running: new Set(),
      failed: new Set()
    };

    for (const task of tasks) {
      graph.tasks.set(task.id, task);
      graph.dependencies.set(task.id, new Set(task.dependencies));
    }

    return graph;
  }

  private getReadyTasks(graph: TaskGraph): ParallelTask[] {
    const ready: ParallelTask[] = [];

    for (const [taskId, task] of graph.tasks) {
      if (graph.completed.has(taskId) || graph.running.has(taskId) || graph.failed.has(taskId)) {
        continue;
      }

      const deps = graph.dependencies.get(taskId) || new Set();
      const allDepsCompleted = Array.from(deps).every(depId => graph.completed.has(depId));

      if (allDepsCompleted) {
        ready.push(task);
      }
    }

    return ready.sort((a, b) => b.priority - a.priority);
  }

  private async executeTask(task: ParallelTask, previousResults: Map<string, any>): Promise<any> {
    const action = task.action;

    if (action.type === 'use_tool') {
      const tool = this.registry.get(action.tool);
      if (!tool) {
        throw new Error(`Tool ${action.tool} not found`);
      }

      // Merge dependency outputs into args if needed
      let args = { ...action.args };
      if (task.dependencies.length > 0) {
        args = this.mergeDependencyOutputs(args, task.dependencies, previousResults);
      }

      console.log(`🔄 Executing parallel task: ${task.id} (${action.tool})`);
      const result = await tool.run(args);
      console.log(`✅ Completed parallel task: ${task.id}`);
      return result;
    }

    return null;
  }

  private mergeDependencyOutputs(args: any, dependencies: string[], results: Map<string, any>): any {
    let mergedText = '';
    
    for (const depId of dependencies) {
      const depResult = results.get(depId);
      if (depResult) {
        if (typeof depResult === 'string') {
          mergedText += depResult + '\n';
        } else if (depResult.results) {
          // Web search results
          mergedText += depResult.results.map((r: any) => `${r.title}: ${r.snippet}`).join('\n') + '\n';
        } else if (depResult.output) {
          mergedText += depResult.output + '\n';
        } else {
          mergedText += JSON.stringify(depResult) + '\n';
        }
      }
    }

    return {
      ...args,
      text: mergedText || args.text
    };
  }

  // Estimate if a task would benefit from parallel execution
  shouldUseParallel(task: string): boolean {
    const taskLower = task.toLowerCase();
    
    const parallelPatterns = [
      /\band\b.*\band\b/i,  // "X and Y and Z"
      /\bvs\b|\bversus\b/i,  // "X vs Y"
      /\bcompare\b/i,        // "compare X and Y"
      /\bmultiple\b/i,       // "multiple files/items"
      /\bboth\b/i,           // "both X and Y"
      /\ball\b.*\bof\b/i     // "all of these"
    ];

    return parallelPatterns.some(pattern => pattern.test(taskLower));
  }

  // Get performance metrics
  getMetrics(): {
    maxConcurrency: number;
    currentlyRunning: number;
    completedTasks: number;
    avgTaskDuration: number;
  } {
    return {
      maxConcurrency: this.maxConcurrency,
      currentlyRunning: this.runningTasks.size,
      completedTasks: 0, // Would track this in a real implementation
      avgTaskDuration: 0  // Would calculate from historical data
    };
  }

  setMaxConcurrency(max: number): void {
    this.maxConcurrency = Math.max(1, Math.min(max, 10)); // Reasonable bounds
  }
}
