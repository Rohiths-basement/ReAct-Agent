import { LLM } from '../llm/interfaces.js';
import { ToolSpec } from '../tools/types.js';

function extractJson(s: string): any | null {
  const match = s.match(/\{[\s\S]*\}$/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

export class ArgInferencer {
  constructor(private llm: LLM) {}

  async infer(tool: ToolSpec<any>, task: string, history: string[], providedArgs: any): Promise<any | null> {
    // Simple heuristics first
    const name = tool.name.toLowerCase();
    if (!providedArgs || typeof providedArgs === 'string') {
      if (name.includes('web_search')) {
        return { query: typeof providedArgs === 'string' && providedArgs.trim() ? providedArgs : task, maxResults: 5 };
      }
      if (name.includes('summarize')) {
        const text = history.join('\n').slice(0, 4000);
        return { text: text || task, instruction: 'Summarize succinctly with key bullets' };
      }
      if (name.includes('calculator')) {
        // Prefer provided string as expression; else derive from task
        const raw = typeof providedArgs === 'string' && providedArgs.trim() ? providedArgs : task;
        const head = raw.split(/(\bvs\b|\bversus\b)/i)[0];
        const candidate = (head || raw).trim();
        // Keep only math-safe chars then normalize
        let expr = candidate.replace(/[^-+*/^()\d.\s]/g, ' ');
        expr = expr.replace(/\s+/g, ' ').trim();
        // Preserve decimals only when between digits
        expr = expr.replace(/(\d)\.(\d)/g, '$1__DOT__$2');
        expr = expr.replace(/\./g, '');
        expr = expr.replace(/__DOT__/g, '.');
        // Basic sanity: require number-operator-number
        if (/\d\s*[+\-*/^]\s*\d/.test(expr)) {
          return { expr };
        }
      }
    }

    // Attempt schema-aware LLM inference
    const schemaKeys = this.introspectSchemaKeys(tool);
    const schemaHint = schemaKeys.length ? `Required/expected keys: ${schemaKeys.join(', ')}` : 'Infer reasonable arguments';

    const prompt = [
      `You are helping to call a tool by constructing its JSON args object.`,
      `Tool name: ${tool.name}`,
      `Tool description: ${tool.description}`,
      `${schemaHint}`,
      `TASK: ${task}`,
      `RECENT CONTEXT:`,
      history.slice(-6).join('\n').slice(0, 1200) || 'None',
      `If partial args were provided, use them as hints: ${JSON.stringify(providedArgs ?? {})}`,
      `Return ONLY a valid JSON object with the args. No explanations.`,
    ].join('\n\n');

    try {
      const out = await this.llm.complete(prompt);
      const json = extractJson(out);
      if (json && typeof json === 'object') return json;
    } catch { /* ignore */ }
    return null;
  }

  private introspectSchemaKeys(tool: ToolSpec<any>): string[] {
    try {
      const anySchema: any = tool.schema as any;
      if (anySchema?._def?.typeName === 'ZodObject') {
        const shape = anySchema._def.shape();
        return Object.keys(shape || {});
      }
      // For unions or other types, we can't reliably introspect
    } catch { /* ignore */ }
    return [];
  }
}
