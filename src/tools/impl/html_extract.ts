import { z } from 'zod';
import { ToolSpec } from '../types.js';
import { htmlToText } from 'html-to-text';

const schema = z.object({
  url: z.string().url(),
  maxChars: z.number().min(200).max(50_000).default(5_000),
});

export default <ToolSpec<typeof schema>>{
  name: 'html_extract',
  description: 'Fetch a webpage and return readable plain text (strips HTML).',
  schema,
  async run({ url, maxChars }) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const title = (html.match(/<title>(.*?)<\/title>/i)?.[1] || '').trim();
    const text = htmlToText(html, { wordwrap: false });
    return { url, title, text: text.slice(0, maxChars) };
  }
}

