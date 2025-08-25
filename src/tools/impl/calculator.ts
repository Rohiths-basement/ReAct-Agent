import { z } from 'zod';
import { ToolSpec } from '../types.js';

// Very simple calculator using Function constructor with strict whitelist
// Accepts expressions like: 2*(3+4)/5, sqrt(9) is not supported to keep surface small
const schema = z.object({ expr: z.string().min(1).max(200) });

function safeEval(expr: string): number {
  // normalize whitespace
  let exprNorm = expr.replace(/\s+/g, ' ').trim();
  // basic whitelist (allow all whitespace via prior normalization)
  if (!/^[\s0-9+\-*/().%^]+$/.test(exprNorm)) throw new Error('Disallowed characters');
  // keep decimal points only when between digits; drop stray dots (e.g., from words like "Node.js")
  let cleaned = exprNorm.replace(/(\d)\.(\d)/g, '$1__DOT__$2');
  cleaned = cleaned.replace(/\./g, '');
  cleaned = cleaned.replace(/__DOT__/g, '.');
  // must contain at least one digit
  if (!/\d/.test(cleaned)) throw new Error('No numeric expression');
  // exponent (^) is not JS; translate to ** for evaluation
  const js = cleaned.replace(/\^/g, '**');
  // eslint-disable-next-line no-new-func
  const val = Function(`"use strict"; return (${js});`)();
  if (typeof val !== 'number' || !isFinite(val)) throw new Error('Invalid result');
  return val;
}

const tool: ToolSpec<typeof schema> = {
  name: 'calculator',
  description: 'Evaluate a basic arithmetic expression with + - * / ( ) and ^.',
  schema,
  async run({ expr }) {
    const value = safeEval(expr);
    return { expr, value };
  }
};

export default tool;

