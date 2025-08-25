import { ToolSpec } from './types.js';
import { LazyToolRegistry } from './lazy_registry.js';
import { EmbeddingsProvider } from '../llm/interfaces.js';

export interface ToolLoadingStrategy {
  name: string;
  shouldLoad: (toolName: string, context: ToolLoadingContext) => Promise<boolean>;
}

export interface ToolLoadingContext {
  task: string;
  history: string[];
  currentlyLoaded: string[];
  usageStats: Map<string, number>;
}

export class SmartToolRegistry {
  private lazyRegistry: LazyToolRegistry;
  private strategies: ToolLoadingStrategy[] = [];
  private maxLoadedTools = 50; // Configurable limit

  constructor(toolsDir: string, embeddings?: EmbeddingsProvider) {
    this.lazyRegistry = new LazyToolRegistry(toolsDir, embeddings);
    this.initializeStrategies();
  }

  private initializeStrategies(): void {
    // Strategy 1: Task-based loading
    this.strategies.push({
      name: 'task-based',
      shouldLoad: async (toolName, context) => {
        const taskLower = context.task.toLowerCase();
        
        // Math tasks
        if (/\d.*[+\-*/^].*\d/.test(taskLower) && toolName === 'calculator') return true;
        
        // File operations
        if (/(read|write|file|directory)/.test(taskLower) && toolName.startsWith('file_')) return true;
        
        // Text processing
        if (/(search|replace|text|pattern)/.test(taskLower) && toolName.startsWith('text_')) return true;
        
        // Web operations
        if (/(web|search|fetch|url)/.test(taskLower) && toolName.startsWith('web_')) return true;
        
        return false;
      }
    });

    // Strategy 2: Usage-based loading
    this.strategies.push({
      name: 'usage-based',
      shouldLoad: async (toolName, context) => {
        const usage = context.usageStats.get(toolName) || 0;
        return usage > 5; // Load frequently used tools
      }
    });

    // Strategy 3: Context-based loading
    this.strategies.push({
      name: 'context-based',
      shouldLoad: async (toolName, context) => {
        // If we've used similar tools recently, load related ones
        const recentTools = context.history
          .slice(-5)
          .join(' ')
          .toLowerCase();
        
        if (recentTools.includes('file_') && toolName.startsWith('file_')) return true;
        if (recentTools.includes('text_') && toolName.startsWith('text_')) return true;
        if (recentTools.includes('json') && toolName.includes('json')) return true;
        
        return false;
      }
    });
  }

  async initialize(): Promise<void> {
    await this.lazyRegistry.initialize();
  }

  async get(name: string): Promise<ToolSpec<any> | null> {
    return this.lazyRegistry.get(name);
  }

  async search(query: string, topK = 10): Promise<ToolSpec<any>[]> {
    return this.lazyRegistry.search(query, topK);
  }

  async smartLoad(context: ToolLoadingContext): Promise<string[]> {
    const allTools = this.lazyRegistry.listAll();
    const toLoad: string[] = [];
    
    for (const toolEntry of allTools) {
      if (context.currentlyLoaded.includes(toolEntry.name)) continue;
      if (toLoad.length >= this.maxLoadedTools) break;
      
      // Check if any strategy recommends loading this tool
      for (const strategy of this.strategies) {
        if (await strategy.shouldLoad(toolEntry.name, context)) {
          toLoad.push(toolEntry.name);
          break;
        }
      }
    }
    
    // Actually load the tools
    for (const toolName of toLoad) {
      await this.lazyRegistry.get(toolName);
    }
    
    return toLoad;
  }

  async optimizeForTask(task: string, history: string[] = []): Promise<void> {
    const context: ToolLoadingContext = {
      task,
      history,
      currentlyLoaded: this.lazyRegistry.list().map(t => t.name),
      usageStats: this.lazyRegistry.getUsageStats()
    };
    
    await this.smartLoad(context);
  }

  list(): ToolSpec<any>[] {
    return this.lazyRegistry.list();
  }

  listAll(): any[] {
    return this.lazyRegistry.listAll();
  }

  getStats(): { loaded: number; total: number; categories: number } {
    return this.lazyRegistry.getStats();
  }

  async cleanup(): Promise<number> {
    return this.lazyRegistry.unloadUnusedTools();
  }

  // Compatibility methods
  async loadFromDirectory(): Promise<void> {
    await this.initialize();
  }

  async buildEmbeddingIndex(): Promise<void> {
    await this.lazyRegistry.buildEmbeddingIndex();
  }
}
