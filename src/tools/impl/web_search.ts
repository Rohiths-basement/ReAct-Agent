import { z } from 'zod';
import { ToolSpec } from '../types.js';

const schema = z.object({
  query: z.string().min(1),
  maxResults: z.number().min(1).max(10).default(5),
});

export default <ToolSpec<typeof schema>>{
  name: 'web_search',
  description: 'Search the web via Tavily API and return titles, URLs, and snippets.',
  schema,
  async run({ query, maxResults }) {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) throw new Error('Missing TAVILY_API_KEY');
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const results = (json.results || []).map((r: any) => ({
      title: r.title,
      url: r.url,
      snippet: r.content || r.snippet || '',
    }));
    return { query, results };
  }
}

