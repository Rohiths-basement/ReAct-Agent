import { ToolSpec } from './types.js';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export class LazyToolLoader {
  private loadedTools = new Map<string, ToolSpec<any>>();
  private toolPaths = new Map<string, string>();
  private coreTools = ['calculator', 'web_search', 'summarize_text'];

  constructor(private toolsDir: string) {}

  async initialize(): Promise<void> {
    // Scan tool files without loading them
    const implDir = resolve(this.toolsDir, 'impl');
    const files = await readdir(implDir);
    
    for (const file of files) {
      if (!file.endsWith('.ts')) continue;
      const toolName = file.replace('.ts', '');
      this.toolPaths.set(toolName, resolve(implDir, file));
    }

    // Load only core tools
    for (const toolName of this.coreTools) {
      if (this.toolPaths.has(toolName)) {
        await this.loadTool(toolName);
      }
    }
  }

  async get(toolName: string): Promise<ToolSpec<any> | null> {
    if (this.loadedTools.has(toolName)) {
      return this.loadedTools.get(toolName)!;
    }

    return this.loadTool(toolName);
  }

  private async loadTool(toolName: string): Promise<ToolSpec<any> | null> {
    const path = this.toolPaths.get(toolName);
    if (!path) return null;

    try {
      const fileUrl = pathToFileURL(path).href;
      const module = await import(fileUrl);
      const tool = module.default as ToolSpec<any>;
      this.loadedTools.set(toolName, tool);
      return tool;
    } catch (error) {
      console.warn(`Failed to load tool ${toolName}:`, error);
      return null;
    }
  }

  async search(query: string, topK = 10): Promise<ToolSpec<any>[]> {
    // Simple search: load tools that match query keywords
    const keywords = query.toLowerCase().split(/\s+/);
    const matchingTools: ToolSpec<any>[] = [];

    for (const [toolName] of this.toolPaths) {
      const matches = keywords.some(keyword => 
        toolName.includes(keyword) || 
        keyword.includes(toolName.split('_')[0])
      );

      if (matches) {
        const tool = await this.get(toolName);
        if (tool) matchingTools.push(tool);
      }

      if (matchingTools.length >= topK) break;
    }

    return matchingTools;
  }

  list(): ToolSpec<any>[] {
    return Array.from(this.loadedTools.values());
  }

  // Names of all discovered tools (metadata-only; not loaded)
  names(): string[] {
    return Array.from(this.toolPaths.keys());
  }

  getStats(): { total: number; loaded: number } {
    return {
      total: this.toolPaths.size,
      loaded: this.loadedTools.size
    };
  }
}
