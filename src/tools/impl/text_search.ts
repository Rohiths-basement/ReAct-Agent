import { z } from 'zod';
import { ToolSpec } from '../types.js';

const schema = z.object({
  text: z.string(),
  pattern: z.string(),
  caseSensitive: z.boolean().default(false),
  regex: z.boolean().default(false),
  maxMatches: z.number().min(1).max(1000).default(100)
});

const tool: ToolSpec<typeof schema> = {
  name: 'text_search',
  description: 'Search for patterns in text. Supports regex and case-insensitive matching.',
  schema,
  async run({ text, pattern, caseSensitive, regex, maxMatches }) {
    const matches: Array<{ match: string; index: number; line: number; context: string }> = [];
    
    if (regex) {
      const flags = caseSensitive ? 'g' : 'gi';
      const re = new RegExp(pattern, flags);
      const lines = text.split('\n');
      
      for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        const line = lines[lineNum];
        let match;
        while ((match = re.exec(line)) !== null && matches.length < maxMatches) {
          matches.push({
            match: match[0],
            index: match.index,
            line: lineNum + 1,
            context: line.trim()
          });
        }
      }
    } else {
      const searchText = caseSensitive ? text : text.toLowerCase();
      const searchPattern = caseSensitive ? pattern : pattern.toLowerCase();
      const lines = text.split('\n');
      
      for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        const line = lines[lineNum];
        const searchLine = caseSensitive ? line : line.toLowerCase();
        let index = 0;
        
        while ((index = searchLine.indexOf(searchPattern, index)) !== -1 && matches.length < maxMatches) {
          matches.push({
            match: line.substring(index, index + pattern.length),
            index,
            line: lineNum + 1,
            context: line.trim()
          });
          index += pattern.length;
        }
      }
    }
    
    return { pattern, matches, totalMatches: matches.length, truncated: matches.length >= maxMatches };
  }
};

export default tool;
