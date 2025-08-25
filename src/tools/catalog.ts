import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ToolSpec } from './types.js';

export interface ToolCatalogEntry {
  name: string;
  description: string;
  category: string;
  tags: string[];
  filePath: string;
  sensitive?: boolean;
  dependencies?: string[];
  loaded?: boolean;
}

export interface ToolCategory {
  name: string;
  description: string;
  priority: number;
  tools: string[];
}

export class ToolCatalog {
  private catalog = new Map<string, ToolCatalogEntry>();
  private categories = new Map<string, ToolCategory>();
  private loadedTools = new Map<string, ToolSpec<any>>();
  private embeddings = new Map<string, number[]>();

  constructor(private toolsDir: string) {
    this.initializeCategories();
  }

  private initializeCategories() {
    const categories: ToolCategory[] = [
      { name: 'core', description: 'Essential tools always loaded', priority: 1, tools: ['calculator'] },
      { name: 'file', description: 'File system operations', priority: 2, tools: [] },
      { name: 'text', description: 'Text processing and manipulation', priority: 3, tools: [] },
      { name: 'data', description: 'Data transformation and formatting', priority: 4, tools: [] },
      { name: 'crypto', description: 'Cryptographic and encoding utilities', priority: 5, tools: [] },
      { name: 'system', description: 'System information and utilities', priority: 6, tools: [] },
      { name: 'web', description: 'Web and network operations', priority: 7, tools: [] },
      { name: 'ai', description: 'AI and LLM-powered tools', priority: 8, tools: [] },
      { name: 'custom', description: 'User-defined and dynamic tools', priority: 9, tools: [] }
    ];

    for (const cat of categories) {
      this.categories.set(cat.name, cat);
    }
  }

  async scanTools(): Promise<void> {
    const implDir = join(this.toolsDir, 'impl');
    const files = await readdir(implDir);
    
    for (const file of files) {
      if (!file.endsWith('.ts')) continue;
      
      const toolName = file.replace('.ts', '');
      const filePath = join(implDir, file);
      
      // Categorize based on naming patterns
      const category = this.categorizeByName(toolName);
      const tags = this.generateTags(toolName);
      
      const entry: ToolCatalogEntry = {
        name: toolName,
        description: await this.extractDescription(filePath),
        category,
        tags,
        filePath,
        loaded: false
      };
      
      this.catalog.set(toolName, entry);
      this.categories.get(category)?.tools.push(toolName);
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

  private generateTags(toolName: string): string[] {
    const tags: string[] = [];
    if (toolName.includes('read')) tags.push('read', 'input');
    if (toolName.includes('write')) tags.push('write', 'output');
    if (toolName.includes('search')) tags.push('search', 'find');
    if (toolName.includes('format')) tags.push('format', 'transform');
    if (toolName.includes('generate')) tags.push('generate', 'create');
    if (toolName.includes('encode')) tags.push('encode', 'decode');
    return tags;
  }

  private async extractDescription(filePath: string): Promise<string> {
    try {
      // Simple regex to extract description from tool files
      const fs = await import('node:fs/promises');
      const content = await fs.readFile(filePath, 'utf-8');
      const match = content.match(/description:\s*['"`]([^'"`]+)['"`]/);
      return match?.[1] || 'No description available';
    } catch {
      return 'No description available';
    }
  }

  async loadTool(toolName: string): Promise<ToolSpec<any> | null> {
    if (this.loadedTools.has(toolName)) {
      return this.loadedTools.get(toolName)!;
    }

    const entry = this.catalog.get(toolName);
    if (!entry) return null;

    try {
      const module = await import(entry.filePath);
      const tool = module.default as ToolSpec<any>;
      this.loadedTools.set(toolName, tool);
      entry.loaded = true;
      return tool;
    } catch (error) {
      console.warn(`Failed to load tool ${toolName}:`, error);
      return null;
    }
  }

  async loadCategory(categoryName: string): Promise<ToolSpec<any>[]> {
    const category = this.categories.get(categoryName);
    if (!category) return [];

    const tools: ToolSpec<any>[] = [];
    for (const toolName of category.tools) {
      const tool = await this.loadTool(toolName);
      if (tool) tools.push(tool);
    }
    return tools;
  }

  async loadCoreTools(): Promise<ToolSpec<any>[]> {
    return this.loadCategory('core');
  }

  async searchTools(query: string, maxResults = 10): Promise<string[]> {
    const results: Array<{ name: string; score: number }> = [];
    const queryLower = query.toLowerCase();

    for (const [name, entry] of this.catalog) {
      let score = 0;
      
      // Exact name match
      if (name === queryLower) score += 100;
      else if (name.includes(queryLower)) score += 50;
      
      // Description match
      if (entry.description.toLowerCase().includes(queryLower)) score += 30;
      
      // Tag matches
      for (const tag of entry.tags) {
        if (tag.includes(queryLower)) score += 20;
      }
      
      // Category match
      if (entry.category === queryLower) score += 15;
      
      if (score > 0) {
        results.push({ name, score });
      }
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map(r => r.name);
  }

  getToolInfo(toolName: string): ToolCatalogEntry | null {
    return this.catalog.get(toolName) || null;
  }

  listCategories(): ToolCategory[] {
    return Array.from(this.categories.values()).sort((a, b) => a.priority - b.priority);
  }

  listToolsByCategory(categoryName: string): ToolCatalogEntry[] {
    const category = this.categories.get(categoryName);
    if (!category) return [];
    
    return category.tools
      .map(name => this.catalog.get(name))
      .filter(Boolean) as ToolCatalogEntry[];
  }

  getLoadedToolsCount(): number {
    return this.loadedTools.size;
  }

  getTotalToolsCount(): number {
    return this.catalog.size;
  }

  async preloadByUsage(usageStats: Map<string, number>, topN = 20): Promise<void> {
    const sortedTools = Array.from(usageStats.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([name]) => name);

    for (const toolName of sortedTools) {
      await this.loadTool(toolName);
    }
  }
}
