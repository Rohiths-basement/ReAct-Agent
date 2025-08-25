import { z } from 'zod';

export interface ToolSpec<T extends z.ZodSchema> {
  name: string;
  description: string;
  schema: T;
  sensitive?: boolean;
  retry?: { retries: number; baseDelayMs: number };
  breaker?: { failureThreshold: number; cooldownMs: number };
  generated?: boolean;
  categories?: string[];
  priority?: number;
  run(args: z.infer<T>): Promise<any>;
};
