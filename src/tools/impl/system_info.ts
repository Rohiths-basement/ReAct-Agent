import { z } from 'zod';
import { ToolSpec } from '../types.js';
import { platform, arch, cpus, totalmem, freemem, uptime, hostname } from 'node:os';
import { cwd, version, env } from 'node:process';

const schema = z.object({
  details: z.enum(['basic', 'full']).default('basic')
});

const tool: ToolSpec<typeof schema> = {
  name: 'system_info',
  description: 'Get system information including OS, CPU, memory, and Node.js details.',
  schema,
  async run({ details }) {
    const basic = {
      platform: platform(),
      arch: arch(),
      hostname: hostname(),
      nodeVersion: version,
      cwd: cwd(),
      uptime: Math.floor(uptime())
    };

    if (details === 'basic') {
      return basic;
    }

    const cpu = cpus();
    return {
      ...basic,
      cpu: {
        model: cpu[0]?.model || 'Unknown',
        cores: cpu.length,
        speed: cpu[0]?.speed || 0
      },
      memory: {
        total: Math.round(totalmem() / 1024 / 1024),
        free: Math.round(freemem() / 1024 / 1024),
        used: Math.round((totalmem() - freemem()) / 1024 / 1024)
      },
      env: {
        nodeEnv: env.NODE_ENV || 'development',
        path: env.PATH?.split(':').length || 0,
        shell: env.SHELL || 'unknown'
      }
    };
  }
};

export default tool;
