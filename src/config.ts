import * as dotenv from 'dotenv';
import { existsSync, mkdirSync } from 'node:fs';

dotenv.config();

export type AppConfig = {
  OPENAI_API_KEY?: string;
  OPENAI_MODEL: string;
  OPENAI_EMBED_MODEL: string;
  APPROVAL_MODE: 'auto' | 'always' | 'sensitive';
  MAX_STEPS: number;
  TOPK_TOOLS: number;
  DATA_DIR: string;
};

export function loadConfig(): AppConfig {
  const cfg: AppConfig = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || undefined,
    OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    OPENAI_EMBED_MODEL: process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small',
    APPROVAL_MODE: (process.env.APPROVAL_MODE as any) || 'sensitive',
    MAX_STEPS: Number(process.env.MAX_STEPS || 20),
    TOPK_TOOLS: Number(process.env.TOPK_TOOLS || 8),
    DATA_DIR: process.env.DATA_DIR || './data',
  };
  ensureDataDirs(cfg);
  return cfg;
}

export function ensureDataDirs(cfg: AppConfig) {
  if (!existsSync(cfg.DATA_DIR)) mkdirSync(cfg.DATA_DIR, { recursive: true });
  if (!existsSync(`${cfg.DATA_DIR}/runs`)) mkdirSync(`${cfg.DATA_DIR}/runs`, { recursive: true });
  if (!existsSync(`${cfg.DATA_DIR}/tools`)) mkdirSync(`${cfg.DATA_DIR}/tools`, { recursive: true });
}

