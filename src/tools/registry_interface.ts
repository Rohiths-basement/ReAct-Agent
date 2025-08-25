import { ToolSpec } from './types.js';

export interface IToolRegistry {
  get(name: string): ToolSpec<any> | undefined;
  search(query: string, topK?: number): Promise<ToolSpec<any>[]>;
  list(): ToolSpec<any>[];
  getOrLoad?(name: string): Promise<ToolSpec<any> | undefined>;
  initialize?(): Promise<void>;
  loadFromDirectory?(): Promise<void>;
  buildEmbeddingIndex?(): Promise<void>;
}

// Adapter to make SmartToolRegistry compatible with existing Agent code
export class RegistryAdapter implements IToolRegistry {
  constructor(private registry: any) {}

  get(name: string): ToolSpec<any> | undefined {
    return this.registry.get(name);
  }

  async search(query: string, topK = 10): Promise<ToolSpec<any>[]> {
    return this.registry.search(query, topK);
  }

  list(): ToolSpec<any>[] {
    return this.registry.list();
  }

  async getOrLoad(name: string): Promise<ToolSpec<any> | undefined> {
    if (this.registry.getOrLoad) {
      return this.registry.getOrLoad(name);
    }
    return undefined;
  }

  async initialize(): Promise<void> {
    if (this.registry.initialize) {
      await this.registry.initialize();
    }
  }

  async loadFromDirectory(): Promise<void> {
    if (this.registry.loadFromDirectory) {
      await this.registry.loadFromDirectory();
    }
  }

  async buildEmbeddingIndex(): Promise<void> {
    if (this.registry.buildEmbeddingIndex) {
      await this.registry.buildEmbeddingIndex();
    }
  }
}
