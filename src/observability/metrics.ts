import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppConfig } from '../config.js';

interface Metric {
  name: string;
  value: number;
  timestamp: number;
  labels?: Record<string, string>;
}

interface Trace {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operationName: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  status: 'success' | 'error' | 'pending';
  tags: Record<string, any>;
  logs: Array<{ timestamp: number; message: string; level: 'info' | 'warn' | 'error' }>;
}

export class MetricsCollector {
  private metrics: Metric[] = [];
  private traces: Map<string, Trace> = new Map();
  private counters: Map<string, number> = new Map();
  private histograms: Map<string, number[]> = new Map();

  constructor(private cfg: AppConfig) {}

  // Counter metrics
  incrementCounter(name: string, labels?: Record<string, string>): void {
    const key = `${name}:${JSON.stringify(labels || {})}`;
    this.counters.set(key, (this.counters.get(key) || 0) + 1);
    this.recordMetric(name, this.counters.get(key)!, labels);
  }

  // Histogram metrics for durations, sizes, etc.
  recordHistogram(name: string, value: number, labels?: Record<string, string>): void {
    const key = `${name}:${JSON.stringify(labels || {})}`;
    const values = this.histograms.get(key) || [];
    values.push(value);
    this.histograms.set(key, values);
    this.recordMetric(name, value, labels);
  }

  // Gauge metrics for current values
  recordGauge(name: string, value: number, labels?: Record<string, string>): void {
    this.recordMetric(name, value, labels);
  }

  private recordMetric(name: string, value: number, labels?: Record<string, string>): void {
    this.metrics.push({
      name,
      value,
      timestamp: Date.now(),
      labels
    });

    // Keep only recent metrics (last 1000)
    if (this.metrics.length > 1000) {
      this.metrics = this.metrics.slice(-1000);
    }
  }

  // Distributed tracing
  startTrace(operationName: string, parentSpanId?: string): string {
    const traceId = this.generateId();
    const spanId = this.generateId();
    
    const trace: Trace = {
      traceId,
      spanId,
      parentSpanId,
      operationName,
      startTime: Date.now(),
      status: 'pending',
      tags: {},
      logs: []
    };

    this.traces.set(spanId, trace);
    return spanId;
  }

  finishTrace(spanId: string, status: 'success' | 'error' = 'success', tags?: Record<string, any>): void {
    const trace = this.traces.get(spanId);
    if (trace) {
      trace.endTime = Date.now();
      trace.duration = trace.endTime - trace.startTime;
      trace.status = status;
      if (tags) {
        trace.tags = { ...trace.tags, ...tags };
      }

      // Record duration metric
      this.recordHistogram(`trace_duration`, trace.duration, {
        operation: trace.operationName,
        status
      });
    }
  }

  addTraceLog(spanId: string, message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    const trace = this.traces.get(spanId);
    if (trace) {
      trace.logs.push({
        timestamp: Date.now(),
        message,
        level
      });
    }
  }

  addTraceTags(spanId: string, tags: Record<string, any>): void {
    const trace = this.traces.get(spanId);
    if (trace) {
      trace.tags = { ...trace.tags, ...tags };
    }
  }

  // Performance analytics
  getPerformanceReport(): {
    toolUsage: Array<{ tool: string; count: number; avgDuration: number; successRate: number }>;
    taskMetrics: { avgSteps: number; avgDuration: number; successRate: number };
    systemMetrics: { memoryUsage: number; uptime: number };
    recentErrors: Array<{ operation: string; error: string; timestamp: number }>;
  } {
    const toolStats = new Map<string, { count: number; totalDuration: number; successes: number }>();
    const taskStats = { totalSteps: 0, totalDuration: 0, totalTasks: 0, successes: 0 };
    const errors: Array<{ operation: string; error: string; timestamp: number }> = [];

    // Analyze traces
    for (const trace of this.traces.values()) {
      if (trace.operationName.startsWith('tool:')) {
        const toolName = trace.operationName.replace('tool:', '');
        const stats = toolStats.get(toolName) || { count: 0, totalDuration: 0, successes: 0 };
        stats.count++;
        if (trace.duration) stats.totalDuration += trace.duration;
        if (trace.status === 'success') stats.successes++;
        toolStats.set(toolName, stats);
      }

      if (trace.operationName === 'task_execution') {
        taskStats.totalTasks++;
        if (trace.duration) taskStats.totalDuration += trace.duration;
        if (trace.tags.steps) taskStats.totalSteps += trace.tags.steps;
        if (trace.status === 'success') taskStats.successes++;
      }

      if (trace.status === 'error') {
        errors.push({
          operation: trace.operationName,
          error: trace.tags.error || 'Unknown error',
          timestamp: trace.startTime
        });
      }
    }

    const toolUsage = Array.from(toolStats.entries()).map(([tool, stats]) => ({
      tool,
      count: stats.count,
      avgDuration: stats.count > 0 ? stats.totalDuration / stats.count : 0,
      successRate: stats.count > 0 ? stats.successes / stats.count : 0
    }));

    return {
      toolUsage: toolUsage.sort((a, b) => b.count - a.count),
      taskMetrics: {
        avgSteps: taskStats.totalTasks > 0 ? taskStats.totalSteps / taskStats.totalTasks : 0,
        avgDuration: taskStats.totalTasks > 0 ? taskStats.totalDuration / taskStats.totalTasks : 0,
        successRate: taskStats.totalTasks > 0 ? taskStats.successes / taskStats.totalTasks : 0
      },
      systemMetrics: {
        memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024, // MB
        uptime: process.uptime()
      },
      recentErrors: errors.slice(-10)
    };
  }

  // Export metrics in Prometheus format
  exportPrometheusMetrics(): string {
    const lines: string[] = [];
    const metricGroups = new Map<string, Metric[]>();

    // Group metrics by name
    for (const metric of this.metrics) {
      const group = metricGroups.get(metric.name) || [];
      group.push(metric);
      metricGroups.set(metric.name, group);
    }

    for (const [name, metrics] of metricGroups) {
      lines.push(`# HELP ${name} Agent metric`);
      lines.push(`# TYPE ${name} gauge`);
      
      for (const metric of metrics.slice(-1)) { // Latest value only
        const labels = metric.labels ? 
          Object.entries(metric.labels).map(([k, v]) => `${k}="${v}"`).join(',') : '';
        const labelStr = labels ? `{${labels}}` : '';
        lines.push(`${name}${labelStr} ${metric.value} ${metric.timestamp}`);
      }
    }

    return lines.join('\n');
  }

  // Export traces in Jaeger format
  exportJaegerTraces(): any[] {
    return Array.from(this.traces.values()).map(trace => ({
      traceID: trace.traceId,
      spanID: trace.spanId,
      parentSpanID: trace.parentSpanId,
      operationName: trace.operationName,
      startTime: trace.startTime * 1000, // Jaeger expects microseconds
      duration: (trace.duration || 0) * 1000,
      tags: Object.entries(trace.tags).map(([key, value]) => ({
        key,
        value: String(value)
      })),
      logs: trace.logs.map(log => ({
        timestamp: log.timestamp * 1000,
        fields: [
          { key: 'level', value: log.level },
          { key: 'message', value: log.message }
        ]
      }))
    }));
  }

  // Save metrics to file
  saveMetrics(): void {
    try {
      const metricsDir = join(this.cfg.DATA_DIR, 'metrics');
      if (!existsSync(metricsDir)) {
        require('fs').mkdirSync(metricsDir, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      
      // Save Prometheus metrics
      writeFileSync(
        join(metricsDir, `metrics-${timestamp}.prom`),
        this.exportPrometheusMetrics()
      );

      // Save performance report
      writeFileSync(
        join(metricsDir, `performance-${timestamp}.json`),
        JSON.stringify(this.getPerformanceReport(), null, 2)
      );

      console.log(`📊 Metrics saved to ${metricsDir}`);
    } catch (err) {
      console.warn('Failed to save metrics:', err);
    }
  }

  private generateId(): string {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  }

  // Get real-time metrics for dashboard
  getRealTimeMetrics(): {
    activeTraces: number;
    recentMetrics: Metric[];
    systemHealth: 'healthy' | 'degraded' | 'critical';
  } {
    const activeTraces = Array.from(this.traces.values()).filter(t => t.status === 'pending').length;
    const recentMetrics = this.metrics.slice(-20);
    
    // Simple health check based on error rate
    const recentErrors = Array.from(this.traces.values())
      .filter(t => t.startTime > Date.now() - 300000) // Last 5 minutes
      .filter(t => t.status === 'error').length;
    
    const recentTotal = Array.from(this.traces.values())
      .filter(t => t.startTime > Date.now() - 300000).length;
    
    const errorRate = recentTotal > 0 ? recentErrors / recentTotal : 0;
    
    let systemHealth: 'healthy' | 'degraded' | 'critical' = 'healthy';
    if (errorRate > 0.5) systemHealth = 'critical';
    else if (errorRate > 0.2) systemHealth = 'degraded';

    return {
      activeTraces,
      recentMetrics,
      systemHealth
    };
  }
}
