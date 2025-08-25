import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppConfig } from '../config.js';

interface TaskOutcome {
  taskId: string;
  task: string;
  tools: string[];
  steps: number;
  duration: number;
  success: boolean;
  userFeedback?: 'positive' | 'negative' | 'neutral';
  errorType?: string;
  timestamp: number;
}

interface ToolPerformance {
  name: string;
  successRate: number;
  avgDuration: number;
  usageCount: number;
  lastUsed: number;
  contextSuccess: Record<string, number>; // success rate by task context
}

interface LearningModel {
  version: string;
  toolPerformance: Record<string, ToolPerformance>;
  taskPatterns: Record<string, {
    preferredTools: string[];
    avgSteps: number;
    successRate: number;
    commonFailures: string[];
  }>;
  userPreferences: {
    preferredApprovalMode: string;
    toolPreferences: Record<string, number>; // tool -> preference score
    taskTypePreferences: Record<string, string[]>; // task type -> preferred tools
  };
  adaptations: Array<{
    type: 'tool_priority' | 'tool_selection' | 'parameter_tuning';
    description: string;
    impact: number;
    timestamp: number;
  }>;
}

export class AdaptiveLearning {
  private model: LearningModel;
  private modelPath: string;
  private outcomes: TaskOutcome[] = [];

  constructor(private cfg: AppConfig) {
    this.modelPath = join(cfg.DATA_DIR, 'learning', 'model.json');
    this.model = this.loadModel();
  }

  private loadModel(): LearningModel {
    if (existsSync(this.modelPath)) {
      try {
        return JSON.parse(readFileSync(this.modelPath, 'utf-8'));
      } catch (err) {
        console.warn('Failed to load learning model, starting fresh');
      }
    }

    return {
      version: '1.0',
      toolPerformance: {},
      taskPatterns: {},
      userPreferences: {
        preferredApprovalMode: 'sensitive',
        toolPreferences: {},
        taskTypePreferences: {}
      },
      adaptations: []
    };
  }

  private saveModel(): void {
    try {
      const dir = join(this.cfg.DATA_DIR, 'learning');
      if (!existsSync(dir)) {
        require('fs').mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.modelPath, JSON.stringify(this.model, null, 2));
    } catch (err) {
      console.warn('Failed to save learning model:', err);
    }
  }

  recordTaskOutcome(outcome: TaskOutcome): void {
    this.outcomes.push(outcome);
    this.updateToolPerformance(outcome);
    this.updateTaskPatterns(outcome);
    this.saveModel();
  }

  private updateToolPerformance(outcome: TaskOutcome): void {
    for (const toolName of outcome.tools) {
      const existing = this.model.toolPerformance[toolName] || {
        name: toolName,
        successRate: 0,
        avgDuration: 0,
        usageCount: 0,
        lastUsed: 0,
        contextSuccess: {}
      };

      const newCount = existing.usageCount + 1;
      const newSuccessRate = (existing.successRate * existing.usageCount + (outcome.success ? 1 : 0)) / newCount;
      const newAvgDuration = (existing.avgDuration * existing.usageCount + outcome.duration) / newCount;

      // Update context-specific success rate
      const taskContext = this.categorizeTask(outcome.task);
      const contextCount = existing.contextSuccess[taskContext] || 0;
      existing.contextSuccess[taskContext] = (contextCount + (outcome.success ? 1 : 0)) / (contextCount + 1);

      this.model.toolPerformance[toolName] = {
        ...existing,
        successRate: newSuccessRate,
        avgDuration: newAvgDuration,
        usageCount: newCount,
        lastUsed: outcome.timestamp
      };
    }
  }

  private updateTaskPatterns(outcome: TaskOutcome): void {
    const taskType = this.categorizeTask(outcome.task);
    const existing = this.model.taskPatterns[taskType] || {
      preferredTools: [],
      avgSteps: 0,
      successRate: 0,
      commonFailures: []
    };

    // Update preferred tools based on success
    if (outcome.success) {
      for (const tool of outcome.tools) {
        if (!existing.preferredTools.includes(tool)) {
          existing.preferredTools.push(tool);
        }
      }
    }

    // Update metrics
    const patternCount = (existing.avgSteps > 0 ? 1 : 0) + 1;
    existing.avgSteps = (existing.avgSteps + outcome.steps) / patternCount;
    existing.successRate = (existing.successRate + (outcome.success ? 1 : 0)) / patternCount;

    if (!outcome.success && outcome.errorType) {
      if (!existing.commonFailures.includes(outcome.errorType)) {
        existing.commonFailures.push(outcome.errorType);
      }
    }

    this.model.taskPatterns[taskType] = existing;
  }

  private categorizeTask(task: string): string {
    const lowerTask = task.toLowerCase();
    
    if (lowerTask.includes('search') || lowerTask.includes('find')) return 'search';
    if (lowerTask.includes('summarize') || lowerTask.includes('summary')) return 'summarization';
    if (lowerTask.includes('calculate') || lowerTask.includes('math')) return 'computation';
    if (lowerTask.includes('file') || lowerTask.includes('read') || lowerTask.includes('write')) return 'file_operations';
    if (lowerTask.includes('email') || lowerTask.includes('draft')) return 'communication';
    if (lowerTask.includes('web') || lowerTask.includes('http')) return 'web_operations';
    
    return 'general';
  }

  // Get optimized tool recommendations for a task
  getToolRecommendations(task: string, availableTools: string[]): Array<{ tool: string; confidence: number; reason: string }> {
    const taskType = this.categorizeTask(task);
    const pattern = this.model.taskPatterns[taskType];
    const recommendations: Array<{ tool: string; confidence: number; reason: string }> = [];

    for (const tool of availableTools) {
      let confidence = 0.5; // Base confidence
      let reason = 'General availability';

      const performance = this.model.toolPerformance[tool];
      if (performance) {
        // Factor in success rate
        confidence += performance.successRate * 0.3;
        
        // Factor in context-specific success
        if (performance.contextSuccess[taskType]) {
          confidence += performance.contextSuccess[taskType] * 0.2;
        }

        // Factor in recency (prefer recently successful tools)
        const daysSinceUsed = (Date.now() - performance.lastUsed) / (1000 * 60 * 60 * 24);
        if (daysSinceUsed < 7) {
          confidence += 0.1;
        }

        reason = `Success rate: ${Math.round(performance.successRate * 100)}%, Context fit: ${Math.round((performance.contextSuccess[taskType] || 0) * 100)}%`;
      }

      // Factor in task pattern preferences
      if (pattern && pattern.preferredTools.includes(tool)) {
        confidence += 0.2;
        reason += ', Previously successful for this task type';
      }

      // Factor in user preferences
      const userPref = this.model.userPreferences.toolPreferences[tool] || 0;
      confidence += userPref * 0.1;

      recommendations.push({ tool, confidence: Math.min(confidence, 1.0), reason });
    }

    return recommendations.sort((a, b) => b.confidence - a.confidence);
  }

  // Learn from user feedback
  recordUserFeedback(taskId: string, feedback: 'positive' | 'negative' | 'neutral', details?: string): void {
    const outcome = this.outcomes.find(o => o.taskId === taskId);
    if (outcome) {
      outcome.userFeedback = feedback;
      
      // Update user preferences based on feedback
      if (feedback === 'positive') {
        for (const tool of outcome.tools) {
          const current = this.model.userPreferences.toolPreferences[tool] || 0;
          this.model.userPreferences.toolPreferences[tool] = Math.min(current + 0.1, 1.0);
        }
      } else if (feedback === 'negative') {
        for (const tool of outcome.tools) {
          const current = this.model.userPreferences.toolPreferences[tool] || 0;
          this.model.userPreferences.toolPreferences[tool] = Math.max(current - 0.1, -1.0);
        }
      }

      this.recordAdaptation('tool_priority', `Adjusted tool preferences based on user feedback: ${feedback}`, feedback === 'positive' ? 0.1 : -0.1);
      this.saveModel();
    }
  }

  private recordAdaptation(type: 'tool_priority' | 'tool_selection' | 'parameter_tuning', description: string, impact: number): void {
    this.model.adaptations.push({
      type,
      description,
      impact,
      timestamp: Date.now()
    });

    // Keep only recent adaptations (last 100)
    if (this.model.adaptations.length > 100) {
      this.model.adaptations = this.model.adaptations.slice(-100);
    }
  }

  // Get learning insights for debugging/monitoring
  getInsights(): {
    totalTasks: number;
    overallSuccessRate: number;
    topPerformingTools: Array<{ name: string; successRate: number; usage: number }>;
    recentAdaptations: Array<{ description: string; impact: number; timestamp: number }>;
    taskTypePerformance: Record<string, { successRate: number; avgSteps: number }>;
  } {
    const totalTasks = this.outcomes.length;
    const successfulTasks = this.outcomes.filter(o => o.success).length;
    const overallSuccessRate = totalTasks > 0 ? successfulTasks / totalTasks : 0;

    const topPerformingTools = Object.values(this.model.toolPerformance)
      .filter(t => t.usageCount >= 3)
      .sort((a, b) => b.successRate - a.successRate)
      .slice(0, 10)
      .map(t => ({ name: t.name, successRate: t.successRate, usage: t.usageCount }));

    const recentAdaptations = this.model.adaptations.slice(-10);

    const taskTypePerformance: Record<string, { successRate: number; avgSteps: number }> = {};
    for (const [type, pattern] of Object.entries(this.model.taskPatterns)) {
      taskTypePerformance[type] = {
        successRate: pattern.successRate,
        avgSteps: pattern.avgSteps
      };
    }

    return {
      totalTasks,
      overallSuccessRate,
      topPerformingTools,
      recentAdaptations,
      taskTypePerformance
    };
  }
}
