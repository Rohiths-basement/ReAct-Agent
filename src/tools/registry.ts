import { readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { AppConfig } from '../config.js';
import { EmbeddingsProvider } from '../llm/interfaces.js';
import { ToolSpec } from './types.js';
import { LazyToolLoader } from './lazy_loader.js';

interface ToolIndex {
  version: string;
  model: string;
  tools: Array<{
    name: string;
    description: string;
    embedding: number[];
    categories: string[];
    priority: number;
  }>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolSpec<any>>();
  private embeddings: EmbeddingsProvider;
  private indexPath: string;
  private toolIndex: ToolIndex | null = null;
  private readonly BATCH_SIZE = 50;
  private names: string[] = [];
  private descs: string[] = [];
  private vecs: number[][] = [];
  private lazyLoader?: LazyToolLoader;

  constructor(private cfg: AppConfig, embeddings: EmbeddingsProvider) {
    this.embeddings = embeddings;
    this.indexPath = join(cfg.DATA_DIR, 'tools', 'index.json');
  }

  async loadTools(): Promise<void> {
    const toolsDir = join(process.cwd(), 'src', 'tools', 'impl');
    const files = await readdir(toolsDir);
    const tsFiles = files.filter(f => extname(f) === '.ts');

    console.log(`Loading ${tsFiles.length} tools...`);
    
    // Load tools in batches to handle large numbers efficiently
    const batches = this.createBatches(tsFiles, this.BATCH_SIZE);
    
    for (const batch of batches) {
      const toolPromises = batch.map(async (file: string) => {
        try {
          const modulePath = join(toolsDir, file);
          const fileUrl = pathToFileURL(modulePath).href;
          const module = await import(fileUrl);
          const tool = module.default as ToolSpec<any>;
          if (tool?.name && tool?.description) {
            // Enhance tool with metadata for better categorization
            const enhancedTool = this.enhanceTool(tool);
            this.tools.set(tool.name, enhancedTool);
            return tool;
          }
        } catch (err) {
          console.warn(`Failed to load tool ${file}:`, err);
        }
        return null;
      });

      await Promise.all(toolPromises);
    }

    console.log(`Loaded ${this.tools.size} tools successfully`);
    await this.buildEmbeddingIndex();
  }

  // Dynamically register tools (used by LazyToolLoader path)
  registerTools(tools: ToolSpec<any>[]): void {
    for (const tool of tools) {
      if (tool && tool.name) {
        const enhanced = this.enhanceTool(tool);
        this.tools.set(tool.name, enhanced);
      }
    }
  }

  // Rebuild embedding index after dynamic registration
  async rebuildIndex(): Promise<void> {
    await this.buildEmbeddingIndex();
  }

  // Attach a LazyToolLoader to enable on-demand loading during search/get
  attachLazyLoader(loader: LazyToolLoader): void {
    this.lazyLoader = loader;
  }

  private createBatches<T>(items: T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }
    return batches;
  }

  private enhanceTool(tool: ToolSpec<any>): ToolSpec<any> {
    // Add default reliability settings if not specified
    const enhanced = {
      ...tool,
      retry: tool.retry || { retries: 2, baseDelayMs: 400 },
      breaker: tool.breaker || { failureThreshold: 3, cooldownMs: 30000 },
      categories: this.categorizeToolByName(tool.name),
      priority: this.calculateToolPriority(tool)
    };
    
    return enhanced;
  }

  private categorizeToolByName(name: string): string[] {
    const categories: string[] = [];
    
    if (name.includes('web') || name.includes('http') || name.includes('fetch')) {
      categories.push('web', 'network');
    }
    if (name.includes('file') || name.includes('read') || name.includes('write')) {
      categories.push('filesystem', 'io');
    }
    if (name.includes('calc') || name.includes('math')) {
      categories.push('computation', 'math');
    }
    if (name.includes('search')) {
      categories.push('search', 'information');
    }
    if (name.includes('email') || name.includes('draft')) {
      categories.push('communication', 'email');
    }
    if (name.includes('json') || name.includes('csv')) {
      categories.push('data', 'parsing');
    }
    if (name.includes('summarize') || name.includes('text')) {
      categories.push('nlp', 'processing');
    }
    
    return categories.length > 0 ? categories : ['general'];
  }

  private calculateToolPriority(tool: ToolSpec<any>): number {
    let priority = 50; // Base priority
    
    // Higher priority for commonly used tools
    if (tool.name.includes('web_search')) priority += 30;
    if (tool.name.includes('file_read')) priority += 20;
    if (tool.name.includes('summarize')) priority += 25;
    if (tool.name.includes('calculator')) priority += 15;
    
    // Lower priority for sensitive tools in autonomous mode
    if (tool.sensitive) priority -= 10;
    
    return Math.max(0, Math.min(100, priority));
  }

  private async buildEmbeddingIndex(): Promise<void> {
    this.names = Array.from(this.tools.keys());
    this.descs = this.names.map(name => this.tools.get(name)!.description);
    
    const cachePath = join(this.cfg.DATA_DIR, 'tools', 'index.json');
    const embedKey = this.cfg.OPENAI_API_KEY ? this.cfg.OPENAI_EMBED_MODEL : 'local-512-v1';
    const descsHash = sha1(JSON.stringify(this.descs));
    const namesHash = sha1(JSON.stringify(this.names));

    let cached: { embed_key: string; descs_hash: string; names_hash: string; vecs: number[][] } | null = null;
    if (existsSync(cachePath)) {
      try {
        const raw = readFileSync(cachePath, 'utf-8');
        const j = JSON.parse(raw);
        if (j.embed_key === embedKey && j.descs_hash === descsHash && j.names_hash === namesHash) {
          cached = j;
        }
      } catch { /* ignore */ }
    }

    if (cached) {
      this.vecs = cached.vecs;
    } else {
      this.vecs = await this.embeddings.embed(this.descs);
      writeFileSync(cachePath, JSON.stringify({ embed_key: embedKey, descs_hash: descsHash, names_hash: namesHash, vecs: this.vecs }));
    }
  }

  list(): ToolSpec<any>[] { 
    return Array.from(this.tools.values()); 
  }

  get(name: string): ToolSpec<any> | undefined { 
    return this.tools.get(name); 
  }

  // On-demand: if tool not present, try to load via LazyToolLoader, register and reindex
  async getOrLoad(name: string): Promise<ToolSpec<any> | undefined> {
    const existing = this.tools.get(name);
    if (existing) return existing;
    if (!this.lazyLoader) return undefined;
    const loaded = await this.lazyLoader.get(name);
    if (loaded) {
      const enhanced = this.enhanceTool(loaded);
      this.tools.set(loaded.name, enhanced);
      await this.buildEmbeddingIndex();
      return enhanced;
    }
    return undefined;
  }

  async search(query: string, k: number): Promise<ToolSpec<any>[]> {
    // On-demand bridge: try to load likely tools before embedding search
    if (this.lazyLoader) {
      const candidates = await this.lazyLoader.search(query, Math.min(k * 2, 50));
      let added = 0;
      for (const t of candidates) {
        if (t && !this.tools.has(t.name)) {
          const enhanced = this.enhanceTool(t);
          this.tools.set(t.name, enhanced);
          added++;
        }
      }
      if (added > 0) {
        await this.buildEmbeddingIndex();
      }
    }

    if (this.vecs.length === 0 && this.tools.size > 0) {
      await this.buildEmbeddingIndex();
    }

    const qv = (await this.embeddings.embed([query]))[0];
    const scored = this.vecs.map((v, i) => ({ score: cosine(qv, v), i }));
    scored.sort((a, b) => b.score - a.score);
    const out: ToolSpec<any>[] = [];
    for (let j = 0; j < Math.min(k, scored.length); j++) {
      const toolName = this.names[scored[j].i];
      const tool = this.tools.get(toolName);
      if (tool) {
        out.push(tool);
      }
    }
    return out;
  }
}

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
