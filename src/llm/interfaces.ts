export interface LLM {
  name: string;
  complete(prompt: string): Promise<string>;
}

export interface EmbeddingsProvider {
  embed(texts: string[]): Promise<number[][]>;
}

