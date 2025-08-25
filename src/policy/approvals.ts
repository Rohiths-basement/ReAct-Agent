import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

export type ApprovalMode = 'auto' | 'always' | 'sensitive';

export async function maybeApprove(mode: ApprovalMode, actionSummary: string, sensitive: boolean): Promise<boolean> {
  if (mode === 'auto') return true;
  if (mode === 'sensitive' && !sensitive) return true;
  const rl = readline.createInterface({ input, output });
  const ans = await rl.question(`\nApproval needed: ${actionSummary}\nApprove? [y/N] `);
  rl.close();
  return ans.trim().toLowerCase().startsWith('y');
}

