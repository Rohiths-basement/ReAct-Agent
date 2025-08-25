export type StepKind = 'thought' | 'tool' | 'observation' | 'final' | 'approval-request' | 'approval-response' | 'interruption';

export type Step = {
  id: string;
  runId: string;
  kind: StepKind;
  ts: number;
  data: any;
};

export type Run = {
  runId: string;
  task: string;
  createdAt: number;
  updatedAt: number;
  status: 'running' | 'paused' | 'done' | 'failed';
  steps: Step[];
};

export type PlannerAction =
  | { type: 'use_tool'; tool: string; args: any; rationale: string }
  | { type: 'ask_human'; question: string; rationale: string }
  | { type: 'final_answer'; output: string; rationale: string };

