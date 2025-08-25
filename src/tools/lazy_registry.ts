import { ToolSpec } from './types.js';
import { ToolCatalog, ToolCatalogEntry } from './catalog.js';
import { EmbeddingsProvider } from '../llm/interfaces.js';

export class LazyToolRegistry {
  private catalog: ToolCatalog;
  private loadedTools = new Map<string, ToolSpec<any>>();
  private usageStats = new Map<string, number>();
  private lastUsed = new Map<string, number>();

  constructor(
    private toolsDir: string,
    private embeddings?: EmbeddingsProvider
  ) {
    this.catalog = new ToolCatalog(toolsDir);
  }

  async initialize(): Promise<void> {
    await this.catalog.scanTools();
    // Always load core tools
    const coreTools = await this.catalog.loadCoreTools();
    for (const tool of coreTools) {
      this.loadedTools.set(tool.name, tool);
    }
  }

  async get(name: string): Promise<ToolSpec<any> | null> {
    // Return if already loaded
    if (this.loadedTools.has(name)) {
      this.recordUsage(name);
      return this.loadedTools.get(name)!;
    }

    // Lazy load the tool
    const tool = await this.catalog.loadTool(name);
    if (tool) {
      this.loadedTools.set(name, tool);
      this.recordUsage(name);
    }
    return tool;
  }

  async search(query: string, topK = 10): Promise<ToolSpec<any>[]> {
    // First search in catalog for tool names
    const toolNames = await this.catalog.searchTools(query, topK * 2);
    
    // Load the top tools
    const tools: ToolSpec<any>[] = [];
    for (const name of toolNames.slice(0, topK)) {
      const tool = await this.get(name);
      if (tool) tools.push(tool);
    }

    return tools;
  }

  async loadCategory(categoryName: string): Promise<ToolSpec<any>[]> {
    const tools = await this.catalog.loadCategory(categoryName);
    for (const tool of tools) {
      this.loadedTools.set(tool.name, tool);
    }
    return tools;
  }

  async preloadFrequentlyUsed(topN = 15): Promise<void> {
    await this.catalog.preloadByUsage(this.usageStats, topN);
  }

  list(): ToolSpec<any>[] {
    return Array.from(this.loadedTools.values());
  }

  listAll(): ToolCatalogEntry[] {
    const categories = this.catalog.listCategories();
    const allTools: ToolCatalogEntry[] = [];
    
    for (const category of categories) {
      allTools.push(...this.catalog.listToolsByCategory(category.name));
    }
    
    return allTools;
  }

  getStats(): { loaded: number; total: number; categories: number } {
    return {
      loaded: this.catalog.getLoadedToolsCount(),
      total: this.catalog.getTotalToolsCount(),
      categories: this.catalog.listCategories().length
    };
  }

  getUsageStats(): Map<string, number> {
    return new Map(this.usageStats);
  }

  private recordUsage(toolName: string): void {
    this.usageStats.set(toolName, (this.usageStats.get(toolName) || 0) + 1);
    this.lastUsed.set(toolName, Date.now());
  }

  async unloadUnusedTools(maxIdleMs = 30 * 60 * 1000): Promise<number> {
    const now = Date.now();
    let unloaded = 0;
    
    for (const [name, lastUsedTime] of this.lastUsed) {
      if (now - lastUsedTime > maxIdleMs) {
        // Don't unload core tools
        const info = this.catalog.getToolInfo(name);
        if (info?.category !== 'core') {
          this.loadedTools.delete(name);
          this.lastUsed.delete(name);
          unloaded++;
        }
      }
    }
    
    return unloaded;
  }

  // Compatibility methods for existing code
  async loadFromDirectory(): Promise<void> {
    // No-op for lazy loading - tools are loaded on demand
  }

  async buildEmbeddingIndex(): Promise<void> {
    // Build index only for loaded tools to save memory
    if (!this.embeddings) return;
    
    // This could be enhanced to build embeddings for catalog entries
    // without loading the actual tools
  }
}
