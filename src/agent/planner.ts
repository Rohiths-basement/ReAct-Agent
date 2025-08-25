import { LLM } from '../llm/interfaces.js';
import { ToolRegistry } from '../tools/registry.js';
import { PlannerAction } from './types.js';

export class Planner {
  constructor(private llm: LLM, private registry: ToolRegistry) {}

  async proposeNext(task: string, history: string[], topK: number): Promise<PlannerAction> {
    // Get broader candidate set for better tool coverage
    const searchQuery = this.buildSearchQuery(task, history);
    const candidates = await this.registry.search(searchQuery, Math.max(topK, 15));
    
    // Try intelligent fallback first to handle multi-step reasoning
    const intelligent = this.intelligentFallback(task, history, candidates);
    if (intelligent) return intelligent;

    // Try heuristic for simple patterns
    const heuristic = this.heuristicFallback(task, history, candidates);
    if (heuristic) return heuristic;

    // Build comprehensive tool catalog
    const catalog = candidates.map(t => `- ${t.name}: ${t.description}`).join('\n');
    const prompt = this.buildReActPrompt(task, history, catalog, topK);
    
    const raw = await this.llm.complete(prompt);
    const json = extractJson(raw);
    
    if (!json || !['use_tool','ask_human','final_answer'].includes(json.type)) {
      // Enhanced fallback: try to infer intent from task
      const fallback = this.intelligentFallback(task, history, candidates);
      if (fallback) return fallback;
      return { type: 'ask_human', question: 'I need more specific guidance. What should I do next?', rationale: 'LLM output not parseable' };
    }
    
    // Validate tool exists, on-demand load if needed
    if (json.type === 'use_tool') {
      const tool = await this.registry.getOrLoad(json.tool);
      if (!tool) {
        const fallback = this.intelligentFallback(task, history, candidates);
        if (fallback) return fallback;
        return { type: 'ask_human', question: `Tool "${json.tool}" is unavailable. How should I proceed?`, rationale: 'Unknown tool' };
      }
    }
    
    return json as PlannerAction;
  }

  private buildSearchQuery(task: string, history: string[]): string {
    const recentHistory = history.slice(-3).join(' ');
    return `${task} ${recentHistory}`.slice(0, 500);
  }

  private buildReActPrompt(task: string, history: string[], catalog: string, topK: number): string {
    const historyText = history.length > 0 ? history.join('\n').slice(0, 1500) : 'No previous steps.';
    
    return `You are an autonomous ReAct agent. Your goal is to complete tasks efficiently using available tools.

TASK: ${task}

RECENT HISTORY:
${historyText}

AVAILABLE TOOLS (top-${topK}):
${catalog}

INSTRUCTIONS:
1. Choose the MOST APPROPRIATE tool to make progress on the task
2. If you have enough information to provide a final answer, do so
3. Only ask humans for clarification if absolutely necessary
4. Be autonomous and decisive

Respond with EXACTLY ONE of these JSON formats:
{ "type": "use_tool", "tool": "tool_name", "args": {...}, "rationale": "why this tool helps" }
{ "type": "final_answer", "output": "complete answer", "rationale": "why this completes the task" }
{ "type": "ask_human", "question": "specific question", "rationale": "why human input is needed" }`;
  }

  private heuristicFallback(task: string, history: string[], candidates: ReturnType<ToolRegistry['list']> extends infer T ? any[] : any[]): PlannerAction | null {
    const lc = task.toLowerCase();
    const names = new Set(candidates.map(c => c.name));
    
    // Stricter math detection: require number-operator-number pattern
    const splitOn = /(\bvs\b|\bversus\b)/i;
    const parts = task.split(splitOn);
    const hasVs = parts.length >= 3; // e.g., [left, 'vs', right]

    function cleanExpr(s: string): string {
      let x = s.replace(/[^-+*/^()\d.\s]/g, ' ');
      x = x.replace(/\s+/g, ' ').trim();
      x = x.replace(/(\d)\.(\d)/g, '$1__DOT__$2');
      x = x.replace(/\./g, '');
      x = x.replace(/__DOT__/g, '.');
      return x;
    }
    function hasCalcFor(expr: string): boolean {
      const esc = expr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`\\"expr\\":\\"${esc}\\"`);
      return history.some(h => h.includes('calculator') && re.test(h));
    }
    function getValueFor(expr: string): number | null {
      const esc = expr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`\\"expr\\":\\"${esc}\\",\\"value\\":\s*([-+]?\\d+(?:\\.\\d+)?)`);
      for (let i = history.length - 1; i >= 0; i--) {
        const m = history[i].match(re);
        if (m) return Number(m[1]);
      }
      return null;
    }

    if (hasVs && names.has('calculator')) {
      const leftRaw = parts[0];
      const rightRaw = parts.slice(2).join(' ');
      const left = cleanExpr(leftRaw);
      const right = cleanExpr(rightRaw);
      const leftOk = /\d\s*[+\-*/^]\s*\d/.test(left);
      const rightOk = /\d\s*[+\-*/^]\s*\d/.test(right);
      if (leftOk && !hasCalcFor(left)) {
        return { type: 'use_tool', tool: 'calculator', args: { expr: left }, rationale: 'Evaluate left side of comparison' } as PlannerAction;
      }
      if (rightOk && !hasCalcFor(right)) {
        return { type: 'use_tool', tool: 'calculator', args: { expr: right }, rationale: 'Evaluate right side of comparison' } as PlannerAction;
      }
      if (leftOk && rightOk) {
        const lv = getValueFor(left);
        const rv = getValueFor(right);
        if (lv != null && rv != null) {
          const rel = lv === rv ? 'equal to' : (lv < rv ? 'less than' : 'greater than');
          const final = `${left} = ${lv} vs ${right} = ${rv} ⇒ ${left} is ${rel} ${right}`;
          return { type: 'final_answer', output: final, rationale: 'Both sides evaluated; concluding comparison' } as PlannerAction;
        }
      }
      // If neither side looks valid, fall through to general logic
    }

    // Single-expression math evaluation fallback
    const head = task.split(splitOn)[0];
    const mathCandidate = head.trim().length >= 3 ? head : task;
    const cleaned = mathCandidate.replace(/[^-+*/^()\d.\s]/g, '');
    if (/\d\s*[+\-*/^]\s*\d/.test(cleaned) && names.has('calculator')) {
      let expr = cleaned.replace(/\s+/g, ' ').trim();
      expr = expr.replace(/(\d)\.(\d)/g, '$1__DOT__$2');
      expr = expr.replace(/\./g, '');
      expr = expr.replace(/__DOT__/g, '.');
      // Avoid repeating exact same calculator call if it already appears in history
      const already = history.some(h => h.includes('calculator') && h.includes(`"expr":"${expr}"`));
      if (!already) {
        return { type: 'use_tool', tool: 'calculator', args: { expr }, rationale: 'Heuristic math detection' } as PlannerAction;
      }
    }
    
    // Web search for information gathering
    if (/(search|find|look up|google|web|current|latest|version)/i.test(lc) && names.has('web_search')) {
      return { type: 'use_tool', tool: 'web_search', args: { query: task, maxResults: 5 }, rationale: 'Heuristic web search' } as PlannerAction;
    }
    
    // File operations
    if (/(read|open|load).*file/i.test(lc) && names.has('file_read')) {
      return { type: 'ask_human', question: 'Which file would you like me to read?', rationale: 'File operation needs path' } as PlannerAction;
    }
    
    return null;
  }

  private intelligentFallback(task: string, history: string[], candidates: ReturnType<ToolRegistry['list']> extends infer T ? any[] : any[]): PlannerAction | null {
    const lc = task.toLowerCase();
    const names = new Set(candidates.map(c => c.name));
    
    // Count different action types
    const webSearchCount = history.filter(h => h.includes('web_search')).length;
    const summarizeCount = history.filter(h => h.includes('summarize_text')).length;
    const hasWebResults = history.some(h => h.includes('web_search') && h.includes('results'));
    const hasSummary = history.some(h => h.includes('summarize_text') && h.includes('output'));
    
    // If we have a good summary, provide final answer
    if (hasSummary && summarizeCount >= 1) {
      const summaryContent = history.filter(h => h.includes('summarize_text') && h.includes('output')).pop();
      if (summaryContent && summaryContent.length > 100) {
        // Extract the actual summary output
        const match = summaryContent.match(/"output":"([^"]+)"/);
        if (match) {
          const summary = match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
          return { type: 'final_answer', output: summary, rationale: 'Task completed with summary' } as PlannerAction;
        }
      }
    }
    
    // If task asks for summarization and we have web results but no summary yet
    if (/(summarize|summary|brief|bullets)/i.test(lc) && hasWebResults && summarizeCount === 0 && names.has('summarize_text')) {
      const webContent = history.filter(h => h.includes('web_search') || h.includes('results')).join('\n');
      if (webContent.length > 200) {
        return { type: 'use_tool', tool: 'summarize_text', args: { text: webContent, instruction: task }, rationale: 'Summarizing gathered information' } as PlannerAction;
      }
    }
    
    // Avoid repeated actions - if we've done multiple of the same thing, try to conclude
    if (webSearchCount >= 3 && hasWebResults) {
      if (summarizeCount === 0 && names.has('summarize_text')) {
        const content = history.filter(h => h.includes('web_search') || h.length > 50).join('\n');
        return { type: 'use_tool', tool: 'summarize_text', args: { text: content, instruction: task }, rationale: 'Concluding with available information' } as PlannerAction;
      } else {
        // Provide final answer based on gathered info
        const info = history.filter(h => h.includes('results') || h.includes('Node')).join(' ');
        if (info.length > 50) {
          return { type: 'final_answer', output: `Based on the search results: ${info.slice(0, 500)}`, rationale: 'Providing answer with gathered information' } as PlannerAction;
        }
      }
    }
    
    // Information gathering for new tasks - enhanced for president/biographical questions
    const infoKeywords = ['find', 'search', 'get', 'fetch', 'current', 'latest', 'version', 'information', 'about', 'what is', 'who is', 'when was', 'born', 'president'];
    if (infoKeywords.some(kw => lc.includes(kw)) && webSearchCount < 2) {
      if (names.has('web_search')) {
        return { type: 'use_tool', tool: 'web_search', args: { query: task, maxResults: 5 }, rationale: 'Information gathering task' } as PlannerAction;
      }
    }
    
    return null;
  }
}

function extractJson(s: string): any | null {
  const match = s.match(/\{[\s\S]*\}$/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

