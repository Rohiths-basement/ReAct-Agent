import { EmbeddingsProvider } from '../llm/interfaces.js';

export interface VectorIndex {
  toolName: string;
  embedding: number[];
  metadata: {
    category: string;
    tags: string[];
    description: string;
    usageCount: number;
    lastUsed: number;
  };
}

export class VectorToolSearch {
  private index: VectorIndex[] = [];
  private queryCache = new Map<string, { results: string[]; timestamp: number }>();
  private embeddingCache = new Map<string, number[]>();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  private readonly MAX_CACHE_SIZE = 1000;

  constructor(private embeddings: EmbeddingsProvider) {}

  async buildIndex(tools: Array<{ name: string; description: string; category: string; tags: string[] }>): Promise<void> {
    console.log(`Building vector index for ${tools.length} tools...`);
    
    // Batch embeddings for efficiency
    const batchSize = 20;
    const batches = this.createBatches(tools, batchSize);
    
    for (const batch of batches) {
      const texts = batch.map(t => `${t.name}: ${t.description} [${t.tags.join(', ')}]`);
      const embeddings = await this.embeddings.embed(texts);
      
      for (let i = 0; i < batch.length; i++) {
        const tool = batch[i];
        this.index.push({
          toolName: tool.name,
          embedding: embeddings[i],
          metadata: {
            category: tool.category,
            tags: tool.tags,
            description: tool.description,
            usageCount: 0,
            lastUsed: 0
          }
        });
      }
    }
    
    console.log(`✓ Vector index built with ${this.index.length} tools`);
  }

  async search(query: string, topK = 10, categoryFilter?: string): Promise<string[]> {
    // Check cache first
    const cacheKey = `${query}:${topK}:${categoryFilter || 'all'}`;
    const cached = this.queryCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.results;
    }

    // Get query embedding (with caching)
    let queryEmbedding = this.embeddingCache.get(query);
    if (!queryEmbedding) {
      queryEmbedding = (await this.embeddings.embed([query]))[0];
      this.embeddingCache.set(query, queryEmbedding);
      
      // Limit embedding cache size
      if (this.embeddingCache.size > this.MAX_CACHE_SIZE) {
        const firstKey = this.embeddingCache.keys().next().value;
        this.embeddingCache.delete(firstKey);
      }
    }

    // Filter by category if specified
    const candidates = categoryFilter 
      ? this.index.filter(item => item.metadata.category === categoryFilter)
      : this.index;

    // Calculate cosine similarities
    const similarities = candidates.map(item => ({
      toolName: item.toolName,
      similarity: this.cosineSimilarity(queryEmbedding!, item.embedding),
      usageBoost: this.calculateUsageBoost(item.metadata)
    }));

    // Sort by combined score (similarity + usage boost)
    similarities.sort((a, b) => {
      const scoreA = a.similarity + a.usageBoost;
      const scoreB = b.similarity + b.usageBoost;
      return scoreB - scoreA;
    });

    const results = similarities.slice(0, topK).map(s => s.toolName);
    
    // Cache results
    this.queryCache.set(cacheKey, { results, timestamp: Date.now() });
    this.cleanupCache();
    
    return results;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    
    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    return magnitude === 0 ? 0 : dotProduct / magnitude;
  }

  private calculateUsageBoost(metadata: { usageCount: number; lastUsed: number }): number {
    const now = Date.now();
    const daysSinceUsed = (now - metadata.lastUsed) / (1000 * 60 * 60 * 24);
    
    // Usage frequency boost (0-0.1)
    const usageBoost = Math.min(metadata.usageCount * 0.01, 0.1);
    
    // Recency boost (0-0.05, decays over 30 days)
    const recencyBoost = metadata.lastUsed > 0 
      ? Math.max(0, 0.05 * (1 - daysSinceUsed / 30))
      : 0;
    
    return usageBoost + recencyBoost;
  }

  recordUsage(toolName: string): void {
    const item = this.index.find(i => i.toolName === toolName);
    if (item) {
      item.metadata.usageCount++;
      item.metadata.lastUsed = Date.now();
    }
  }

  private createBatches<T>(items: T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }
    return batches;
  }

  private cleanupCache(): void {
    const now = Date.now();
    for (const [key, value] of this.queryCache) {
      if (now - value.timestamp > this.CACHE_TTL) {
        this.queryCache.delete(key);
      }
    }
  }

  getStats(): { indexSize: number; cacheHits: number; embeddingsCached: number } {
    return {
      indexSize: this.index.length,
      cacheHits: this.queryCache.size,
      embeddingsCached: this.embeddingCache.size
    };
  }

  // Precompute embeddings for common queries
  async warmupCache(commonQueries: string[]): Promise<void> {
    console.log(`Warming up cache with ${commonQueries.length} common queries...`);
    for (const query of commonQueries) {
      await this.search(query, 5); // Small topK for warmup
    }
  }
}
