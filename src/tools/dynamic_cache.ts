import { ToolSpec } from './types.js';
import { VectorToolSearch } from './vector_search.js';

export interface CacheEntry {
  tool: ToolSpec<any>;
  loadTime: number;
  lastAccess: number;
  accessCount: number;
  memorySize: number;
}

export interface CacheStats {
  totalTools: number;
  loadedTools: number;
  cacheHits: number;
  cacheMisses: number;
  memoryUsage: number;
  hitRate: number;
}

export class DynamicToolCache {
  private cache = new Map<string, CacheEntry>();
  private loadPromises = new Map<string, Promise<ToolSpec<any> | null>>();
  private stats = { hits: 0, misses: 0 };
  
  private readonly MAX_CACHE_SIZE = 100; // Max tools in memory
  private readonly MAX_MEMORY_MB = 50; // Max memory usage
  private readonly IDLE_TIMEOUT = 10 * 60 * 1000; // 10 minutes
  private readonly PRELOAD_THRESHOLD = 0.7; // Cosine similarity threshold for preloading

  constructor(
    private vectorSearch: VectorToolSearch,
    private toolLoader: (name: string) => Promise<ToolSpec<any> | null>
  ) {
    // Periodic cleanup
    setInterval(() => this.cleanup(), 2 * 60 * 1000); // Every 2 minutes
  }

  async get(toolName: string): Promise<ToolSpec<any> | null> {
    // Check cache first
    const cached = this.cache.get(toolName);
    if (cached) {
      cached.lastAccess = Date.now();
      cached.accessCount++;
      this.stats.hits++;
      this.vectorSearch.recordUsage(toolName);
      return cached.tool;
    }

    // Check if already loading
    if (this.loadPromises.has(toolName)) {
      return this.loadPromises.get(toolName)!;
    }

    // Load tool
    this.stats.misses++;
    const loadPromise = this.loadTool(toolName);
    this.loadPromises.set(toolName, loadPromise);
    
    try {
      const tool = await loadPromise;
      return tool;
    } finally {
      this.loadPromises.delete(toolName);
    }
  }

  private async loadTool(toolName: string): Promise<ToolSpec<any> | null> {
    const tool = await this.toolLoader(toolName);
    if (!tool) return null;

    const entry: CacheEntry = {
      tool,
      loadTime: Date.now(),
      lastAccess: Date.now(),
      accessCount: 1,
      memorySize: this.estimateMemorySize(tool)
    };

    // Ensure cache limits before adding
    await this.ensureCacheSpace(entry.memorySize);
    
    this.cache.set(toolName, entry);
    this.vectorSearch.recordUsage(toolName);
    
    return tool;
  }

  async preloadSimilar(query: string, currentTools: string[]): Promise<void> {
    const similar = await this.vectorSearch.search(query, 10);
    const toPreload = similar
      .filter(name => !currentTools.includes(name) && !this.cache.has(name))
      .slice(0, 3); // Preload top 3 similar tools

    // Load in background without blocking
    Promise.all(toPreload.map(name => this.get(name))).catch(() => {
      // Ignore preload failures
    });
  }

  private async ensureCacheSpace(requiredMemory: number): Promise<void> {
    const currentMemory = this.getTotalMemoryUsage();
    const maxMemoryBytes = this.MAX_MEMORY_MB * 1024 * 1024;

    // Remove tools if over limits
    while (
      (this.cache.size >= this.MAX_CACHE_SIZE || 
       currentMemory + requiredMemory > maxMemoryBytes) &&
      this.cache.size > 0
    ) {
      const lruTool = this.findLRUTool();
      if (lruTool) {
        this.cache.delete(lruTool);
      } else {
        break;
      }
    }
  }

  private findLRUTool(): string | null {
    let oldestTime = Date.now();
    let oldestTool: string | null = null;

    for (const [name, entry] of this.cache) {
      // Prefer tools with low access count and old last access
      const score = entry.lastAccess - (entry.accessCount * 60000); // Boost frequently used
      if (score < oldestTime) {
        oldestTime = score;
        oldestTool = name;
      }
    }

    return oldestTool;
  }

  private cleanup(): void {
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [name, entry] of this.cache) {
      if (now - entry.lastAccess > this.IDLE_TIMEOUT) {
        toRemove.push(name);
      }
    }

    for (const name of toRemove) {
      this.cache.delete(name);
    }
  }

  private estimateMemorySize(tool: ToolSpec<any>): number {
    // Rough estimation: tool object + schema + description
    const baseSize = 1024; // 1KB base
    const descSize = (tool.description?.length || 0) * 2; // 2 bytes per char
    const schemaSize = JSON.stringify(tool.schema || {}).length * 2;
    return baseSize + descSize + schemaSize;
  }

  private getTotalMemoryUsage(): number {
    return Array.from(this.cache.values())
      .reduce((total, entry) => total + entry.memorySize, 0);
  }

  getStats(): CacheStats {
    const total = this.stats.hits + this.stats.misses;
    return {
      totalTools: this.vectorSearch.getStats().indexSize,
      loadedTools: this.cache.size,
      cacheHits: this.stats.hits,
      cacheMisses: this.stats.misses,
      memoryUsage: this.getTotalMemoryUsage(),
      hitRate: total > 0 ? this.stats.hits / total : 0
    };
  }

  // Intelligent preloading based on task analysis
  async smartPreload(task: string, context: string[]): Promise<void> {
    // Extract keywords and predict tool needs
    const keywords = this.extractKeywords(task);
    const predictions = await Promise.all(
      keywords.map(keyword => this.vectorSearch.search(keyword, 3))
    );
    
    const toolsToPreload = new Set<string>();
    predictions.flat().forEach(tool => toolsToPreload.add(tool));
    
    // Limit preloading to avoid memory bloat
    const preloadList = Array.from(toolsToPreload)
      .filter(name => !this.cache.has(name))
      .slice(0, 5);
    
    // Background preload
    Promise.all(preloadList.map(name => this.get(name))).catch(() => {});
  }

  private extractKeywords(text: string): string[] {
    const keywords = text.toLowerCase()
      .split(/\s+/)
      .filter(word => word.length > 3)
      .filter(word => !['the', 'and', 'for', 'with', 'this', 'that'].includes(word));
    
    return [...new Set(keywords)].slice(0, 5); // Unique, max 5
  }

  clear(): void {
    this.cache.clear();
    this.stats = { hits: 0, misses: 0 };
  }

  // Synchronous access to a loaded tool (does not trigger loading)
  peek(name: string): ToolSpec<any> | undefined {
    return this.cache.get(name)?.tool;
  }

  // List currently loaded tools (without triggering any loads)
  getLoadedTools(): ToolSpec<any>[] {
    return Array.from(this.cache.values()).map(e => e.tool);
  }

  // List names of currently loaded tools
  getLoadedToolNames(): string[] {
    return Array.from(this.cache.keys());
  }
}
