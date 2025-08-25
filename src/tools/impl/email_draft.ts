import { z } from 'zod';
import { ToolSpec } from '../types.js';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const schema = z.object({
  to: z.string().email(),
  from: z.string().email(),
  subject: z.string().max(200),
  body: z.string().max(100_000),
  dir: z.string().optional(),
});

function rfc822Date(d: Date) { return d.toUTCString(); }

export default <ToolSpec<typeof schema>>{
  name: 'email_draft',
  description: 'Create a .eml email draft on disk (not sent).',
  schema,
  sensitive: true,
  async run({ to, from, subject, body, dir }) {
    const outDir = dir || path.join(process.cwd(), 'data', 'outbox');
    await mkdir(outDir, { recursive: true });
    const now = new Date();
    const fn = `${now.toISOString().replace(/[:.]/g, '-')}.eml`;
    const headers = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `Date: ${rfc822Date(now)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      '',
    ].join('\r\n');
    const content = headers + body.replace(/\n/g, '\r\n');
    const full = path.join(outDir, fn);
    await writeFile(full, content, 'utf-8');
    return { path: full, bytes: Buffer.byteLength(content) };
  }
}

