import { ToolSpec } from './types.js';
import { VectorToolSearch } from './vector_search.js';
import { DynamicToolCache } from './dynamic_cache.js';
import { EmbeddingsProvider } from '../llm/interfaces.js';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface UltraScaleConfig {
  maxLoadedTools: number;
  maxMemoryMB: number;
  cacheWarmupQueries: string[];
  preloadCategories: string[];
  vectorSearchTopK: number;
}

export class UltraScaleToolRegistry {
  private vectorSearch: VectorToolSearch;
  private dynamicCache: DynamicToolCache;
  private toolMetadata = new Map<string, { path: string; category: string; tags: string[]; description: string }>();
  private initialized = false;

  private readonly defaultConfig: UltraScaleConfig = {
    maxLoadedTools: 100,
    maxMemoryMB: 50,
    cacheWarmupQueries: [
      'calculate math', 'read file', 'write file', 'search text', 'format json',
      'encode base64', 'generate hash', 'get date', 'random number', 'system info'
    ],
    preloadCategories: ['core'],
    vectorSearchTopK: 15
  };

  constructor(
    private toolsDir: string,
    private embeddings: EmbeddingsProvider,
    private config: Partial<UltraScaleConfig> = {}
  ) {
    const finalConfig = { ...this.defaultConfig, ...config };
    this.vectorSearch = new VectorToolSearch(embeddings);
    this.dynamicCache = new DynamicToolCache(
      this.vectorSearch,
      (name) => this.loadToolFromDisk(name)
    );
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    console.log('🚀 Initializing Ultra-Scale Tool Registry...');
    const startTime = Date.now();

    // 1. Scan all tools (metadata only)
    await this.scanToolMetadata();
    
    // 2. Build vector index for fast similarity search
    const toolsForIndex = Array.from(this.toolMetadata.entries()).map(([name, meta]) => ({
      name,
      description: meta.description,
      category: meta.category,
      tags: meta.tags
    }));
    
    await this.vectorSearch.buildIndex(toolsForIndex);
    
    // 3. Preload core tools
    const config = { ...this.defaultConfig, ...this.config };
    for (const category of config.preloadCategories) {
      await this.preloadCategory(category);
    }
    
    // 4. Warm up cache with common queries
    await this.vectorSearch.warmupCache(config.cacheWarmupQueries);
    
    this.initialized = true;
    const initTime = Date.now() - startTime;
    console.log(`✅ Ultra-Scale Registry ready in ${initTime}ms`);
    console.log(`   📊 ${this.toolMetadata.size} tools cataloged`);
    console.log(`   🧠 Vector index built`);
    console.log(`   ⚡ Dynamic cache active`);
  }

  private async scanToolMetadata(): Promise<void> {
    const implDir = join(this.toolsDir, 'impl');
    const files = await readdir(implDir);
    
    for (const file of files) {
      if (!file.endsWith('.ts')) continue;
      
      const toolName = file.replace('.ts', '');
      const filePath = join(implDir, file);
      
      // Extract metadata without loading the tool
      const metadata = await this.extractToolMetadata(filePath, toolName);
      this.toolMetadata.set(toolName, {
        path: filePath,
        category: metadata.category,
        tags: metadata.tags,
        description: metadata.description
      });
    }
  }

  private async extractToolMetadata(filePath: string, toolName: string): Promise<{
    category: string;
    tags: string[];
    description: string;
  }> {
    try {
      const fs = await import('node:fs/promises');
      const content = await fs.readFile(filePath, 'utf-8');
      
      // Extract description from tool definition
      const descMatch = content.match(/description:\s*['"`]([^'"`]+)['"`]/);
      const description = descMatch?.[1] || `${toolName} tool`;
      
      // Categorize based on naming patterns and content
      const category = this.categorizeByName(toolName);
      const tags = this.generateTags(toolName, content);
      
      return { category, tags, description };
    } catch {
      return {
        category: 'custom',
        tags: [],
        description: `${toolName} tool`
      };
    }
  }

  private categorizeByName(toolName: string): string {
    if (['calculator'].includes(toolName)) return 'core';
    if (toolName.startsWith('file_') || toolName.includes('_read') || toolName.includes('_write')) return 'file';
    if (toolName.startsWith('text_') || toolName.includes('search') || toolName.includes('replace')) return 'text';
    if (toolName.includes('json') || toolName.includes('csv') || toolName.includes('format')) return 'data';
    if (toolName.includes('hash') || toolName.includes('base64') || toolName.includes('url_encode') || toolName.includes('uuid')) return 'crypto';
    if (toolName.includes('system') || toolName.includes('random') || toolName.includes('date')) return 'system';
    if (toolName.includes('web_') || toolName.includes('http') || toolName.includes('html')) return 'web';
    if (toolName.includes('summarize') || toolName.includes('email')) return 'ai';
    return 'custom';
  }

  private generateTags(toolName: string, content: string): string[] {
    const tags: string[] = [];
    if (toolName.includes('read') || content.includes('read')) tags.push('read', 'input');
    if (toolName.includes('write') || content.includes('write')) tags.push('write', 'output');
    if (toolName.includes('search') || content.includes('search')) tags.push('search', 'find');
    if (toolName.includes('format') || content.includes('format')) tags.push('format', 'transform');
    if (toolName.includes('generate') || content.includes('generate')) tags.push('generate', 'create');
    if (toolName.includes('encode') || content.includes('encode')) tags.push('encode', 'decode');
    return [...new Set(tags)];
  }

  private async loadToolFromDisk(toolName: string): Promise<ToolSpec<any> | null> {
    const metadata = this.toolMetadata.get(toolName);
    if (!metadata) return null;

    try {
      const module = await import(`file://${metadata.path}`);
      return module.default as ToolSpec<any>;
    } catch (error) {
      console.warn(`Failed to load tool ${toolName}:`, error);
      return null;
    }
  }

  // Synchronous get method for IToolRegistry interface
  get(toolName: string): ToolSpec<any> | undefined {
    return this.dynamicCache.peek(toolName);
  }

  // Async get method for loading tools on demand
  async getAsync(toolName: string): Promise<ToolSpec<any> | null> {
    if (!this.initialized) await this.initialize();
    return this.dynamicCache.get(toolName);
  }

  // Async getOrLoad method for IToolRegistry interface
  async getOrLoad(toolName: string): Promise<ToolSpec<any> | undefined> {
    if (!this.initialized) await this.initialize();
    const tool = await this.dynamicCache.get(toolName);
    return tool || undefined;
  }

  async search(query: string, topK?: number): Promise<ToolSpec<any>[]> {
    if (!this.initialized) await this.initialize();
    
    const config = { ...this.defaultConfig, ...this.config };
    const k = topK || config.vectorSearchTopK;
    
    // Get tool names from vector search
    const toolNames = await this.vectorSearch.search(query, k);
    
    // Load tools dynamically
    const tools: ToolSpec<any>[] = [];
    for (const name of toolNames) {
      const tool = await this.dynamicCache.get(name);
      if (tool) tools.push(tool);
    }
    
    // Preload similar tools in background
    await this.dynamicCache.preloadSimilar(query, toolNames);
    
    return tools;
  }

  async optimizeForTask(task: string, context: string[] = []): Promise<void> {
    if (!this.initialized) await this.initialize();
    await this.dynamicCache.smartPreload(task, context);
  }

  private async preloadCategory(category: string): Promise<void> {
    const toolsInCategory = Array.from(this.toolMetadata.entries())
      .filter(([_, meta]) => meta.category === category)
      .map(([name]) => name);
    
    // Load core tools immediately
    for (const toolName of toolsInCategory.slice(0, 5)) {
      await this.dynamicCache.get(toolName);
    }
  }

  list(): ToolSpec<any>[] {
    // Return only loaded tools to avoid loading everything
    return this.dynamicCache.getLoadedTools();
  }

  getPerformanceStats(): {
    tools: { total: number; loaded: number; categories: number };
    cache: { hitRate: number; memoryUsage: number };
    vector: { indexSize: number; cacheHits: number };
  } {
    const cacheStats = this.dynamicCache.getStats();
    const vectorStats = this.vectorSearch.getStats();
    
    return {
      tools: {
        total: this.toolMetadata.size,
        loaded: cacheStats.loadedTools,
        categories: new Set(Array.from(this.toolMetadata.values()).map(m => m.category)).size
      },
      cache: {
        hitRate: cacheStats.hitRate,
        memoryUsage: cacheStats.memoryUsage
      },
      vector: {
        indexSize: vectorStats.indexSize,
        cacheHits: vectorStats.cacheHits
      }
    };
  }

  // Simulate 1000+ tools performance
  async benchmarkScale(toolCount: number = 1000): Promise<{
    initTime: number;
    searchTime: number;
    memoryEfficiency: number;
  }> {
    console.log(`🧪 Benchmarking with ${toolCount} simulated tools...`);
    
    const startInit = Date.now();
    
    // Simulate tool metadata
    for (let i = this.toolMetadata.size; i < toolCount; i++) {
      const category = ['file', 'text', 'data', 'crypto', 'system', 'web', 'ai'][i % 7];
      this.toolMetadata.set(`tool_${i}`, {
        path: `/fake/path/tool_${i}.ts`,
        category,
        tags: [`tag${i % 10}`, `feature${i % 5}`],
        description: `Simulated tool ${i} for ${category} operations`
      });
    }
    
    const initTime = Date.now() - startInit;
    
    // Benchmark search
    const startSearch = Date.now();
    await this.search('file operations', 10);
    const searchTime = Date.now() - startSearch;
    
    const stats = this.getPerformanceStats();
    const memoryEfficiency = stats.tools.loaded / stats.tools.total;
    
    console.log(`📊 Benchmark Results:`);
    console.log(`   Init time: ${initTime}ms`);
    console.log(`   Search time: ${searchTime}ms`);
    console.log(`   Memory efficiency: ${(memoryEfficiency * 100).toFixed(1)}%`);
    
    return { initTime, searchTime, memoryEfficiency };
  }
}
