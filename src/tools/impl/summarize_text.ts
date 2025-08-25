import { z } from 'zod';
import { ToolSpec } from '../types.js';
import OpenAI from 'openai';

const schema = z.object({
  text: z.string().min(1),
  instruction: z.string().default('Summarize in 5 bullets.'),
});

export default <ToolSpec<typeof schema>>{
  name: 'summarize_text',
  description: 'Use the LLM to summarize provided text per instruction.',
  schema,
  async run({ text, instruction }) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('Missing OPENAI_API_KEY');
    const client = new OpenAI({ apiKey });
    const res = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a concise assistant.' },
        { role: 'user', content: `${instruction}\n\nText:\n${text.slice(0, 12000)}` }
      ],
      temperature: 0.2,
    });
    return { output: res.choices[0]?.message?.content || '' };
  }
}

