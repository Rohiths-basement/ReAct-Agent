import { z } from 'zod';
import { ToolSpec } from '../types.js';

const schema = z.object({
  text: z.string(),
  find: z.string(),
  replace: z.string(),
  caseSensitive: z.boolean().default(false),
  regex: z.boolean().default(false),
  replaceAll: z.boolean().default(true)
});

const tool: ToolSpec<typeof schema> = {
  name: 'text_replace',
  description: 'Replace text patterns with new content. Supports regex and case-insensitive matching.',
  schema,
  async run({ text, find, replace, caseSensitive, regex, replaceAll }) {
    let result: string;
    let replacements = 0;
    
    if (regex) {
      const flags = caseSensitive ? (replaceAll ? 'g' : '') : (replaceAll ? 'gi' : 'i');
      const re = new RegExp(find, flags);
      result = text.replace(re, (match) => {
        replacements++;
        return replace;
      });
    } else {
      if (replaceAll) {
        const searchText = caseSensitive ? text : text.toLowerCase();
        const searchFind = caseSensitive ? find : find.toLowerCase();
        let index = 0;
        result = text;
        
        while ((index = searchText.indexOf(searchFind, index)) !== -1) {
          result = result.substring(0, index) + replace + result.substring(index + find.length);
          replacements++;
          index += replace.length;
        }
      } else {
        const searchText = caseSensitive ? text : text.toLowerCase();
        const searchFind = caseSensitive ? find : find.toLowerCase();
        const index = searchText.indexOf(searchFind);
        
        if (index !== -1) {
          result = text.substring(0, index) + replace + text.substring(index + find.length);
          replacements = 1;
        } else {
          result = text;
        }
      }
    }
    
    return { 
      originalLength: text.length,
      newLength: result.length,
      replacements,
      result
    };
  }
};

export default tool;
