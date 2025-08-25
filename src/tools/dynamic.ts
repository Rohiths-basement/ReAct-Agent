import { z } from 'zod';
import { ToolSpec } from './types.js';
import { ToolRegistry } from './registry.js';
import { LLM } from '../llm/interfaces.js';

interface DynamicToolSpec {
  name: string;
  description: string;
  parameters: Record<string, {
    type: 'string' | 'number' | 'boolean' | 'array' | 'object';
    description: string;
    required?: boolean;
    enum?: any[];
  }>;
  implementation: string; // JavaScript code
  examples: Array<{ input: any; output: any }>;
}

export class DynamicToolGenerator {
  private generatedTools = new Map<string, ToolSpec<any>>();

  constructor(private llm: LLM, private registry: ToolRegistry) {}

  // Generate a new tool based on natural language description
  async generateTool(description: string, examples?: Array<{ input: any; output: any }>): Promise<string> {
    const prompt = `Create a tool specification for: "${description}"

${examples ? `Examples:\n${examples.map(ex => `Input: ${JSON.stringify(ex.input)}\nOutput: ${JSON.stringify(ex.output)}`).join('\n\n')}` : ''}

Generate a JSON response with this structure:
{
  "name": "snake_case_tool_name",
  "description": "Clear description of what the tool does",
  "parameters": {
    "param_name": {
      "type": "string|number|boolean|array|object",
      "description": "Parameter description",
      "required": true|false,
      "enum": ["option1", "option2"] // optional
    }
  },
  "implementation": "// JavaScript function body that implements the tool\nfunction run(args) {\n  // Implementation here\n  return result;\n}"
}

Make the tool focused, reliable, and follow these patterns:
- Use descriptive parameter names
- Include proper error handling
- Return structured results
- Keep implementation simple and focused`;

    const response = await this.llm.complete(prompt);
    const toolSpec = this.parseToolSpec(response);
    
    if (toolSpec) {
      const tool = await this.createToolFromSpec(toolSpec);
      this.generatedTools.set(tool.name, tool);
      
      // Register with main registry
      (this.registry as any).tools.set(tool.name, tool);
      
      console.log(`🛠️  Generated dynamic tool: ${tool.name}`);
      return tool.name;
    }

    throw new Error('Failed to generate valid tool specification');
  }

  private parseToolSpec(response: string): DynamicToolSpec | null {
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      
      const spec = JSON.parse(jsonMatch[0]);
      
      // Validate required fields
      if (!spec.name || !spec.description || !spec.parameters || !spec.implementation) {
        return null;
      }

      return spec as DynamicToolSpec;
    } catch (err) {
      console.warn('Failed to parse tool specification:', err);
      return null;
    }
  }

  private async createToolFromSpec(spec: DynamicToolSpec): Promise<ToolSpec<any>> {
    // Build Zod schema from parameters
    const schemaFields: Record<string, any> = {};
    
    for (const [name, param] of Object.entries(spec.parameters)) {
      let field: any;
      
      switch (param.type) {
        case 'string':
          field = z.string();
          if (param.enum) field = field.enum(param.enum);
          break;
        case 'number':
          field = z.number();
          break;
        case 'boolean':
          field = z.boolean();
          break;
        case 'array':
          field = z.array(z.any());
          break;
        case 'object':
          field = z.object({});
          break;
        default:
          field = z.any();
      }
      
      if (param.description) {
        field = field.describe(param.description);
      }
      
      if (!param.required) {
        field = field.optional();
      }
      
      schemaFields[name] = field;
    }

    const schema = z.object(schemaFields);

    // Create safe execution environment for the implementation
    const safeImplementation = this.createSafeImplementation(spec.implementation);

    return {
      name: spec.name,
      description: spec.description,
      schema,
      generated: true,
      async run(args: any) {
        try {
          return await safeImplementation(args);
        } catch (error) {
          throw new Error(`Dynamic tool execution failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    };
  }

  private createSafeImplementation(code: string): (args: any) => Promise<any> {
    // Create a safe execution context with limited globals
    const safeGlobals = {
      console: {
        log: (...args: any[]) => console.log('[Dynamic Tool]', ...args),
        warn: (...args: any[]) => console.warn('[Dynamic Tool]', ...args),
        error: (...args: any[]) => console.error('[Dynamic Tool]', ...args)
      },
      Math,
      Date,
      JSON,
      Promise,
      setTimeout: (fn: Function, ms: number) => setTimeout(fn, Math.min(ms, 10000)), // Max 10s
      fetch: async (url: string, options?: any) => {
        // Restricted fetch with timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);
        
        try {
          const response = await fetch(url, {
            ...options,
            signal: controller.signal
          });
          clearTimeout(timeoutId);
          return response;
        } catch (error) {
          clearTimeout(timeoutId);
          throw error;
        }
      }
    };

    return async function(args: any): Promise<any> {
      // Wrap the code in an async function
      const wrappedCode = `
        (async function(args, globals) {
          const { console, Math, Date, JSON, Promise, setTimeout, fetch } = globals;
          
          ${code}
          
          if (typeof run === 'function') {
            return await run(args);
          } else {
            throw new Error('Implementation must define a "run" function');
          }
        })
      `;

      try {
        const func = eval(wrappedCode);
        const result = await Promise.race([
          func(args, safeGlobals),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Tool execution timeout')), 30000)
          )
        ]);
        
        return result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Tool execution failed: ${errorMessage}`);
      }
    };
  }

  // Improve existing tools based on usage patterns
  async improveTool(toolName: string, feedback: string, examples?: Array<{ input: any; output: any }>): Promise<void> {
    const existingTool = this.generatedTools.get(toolName);
    if (!existingTool) {
      throw new Error(`Tool ${toolName} not found or not dynamically generated`);
    }

    const prompt = `Improve the existing tool "${toolName}" based on this feedback: "${feedback}"

Current tool description: ${existingTool.description}

${examples ? `New examples:\n${examples.map(ex => `Input: ${JSON.stringify(ex.input)}\nOutput: ${JSON.stringify(ex.output)}`).join('\n\n')}` : ''}

Generate an improved version with the same JSON structure as before, addressing the feedback while maintaining backward compatibility where possible.`;

    const response = await this.llm.complete(prompt);
    const improvedSpec = this.parseToolSpec(response);
    
    if (improvedSpec) {
      // Create new version
      improvedSpec.name = `${toolName}_v2`;
      const improvedTool = await this.createToolFromSpec(improvedSpec);
      
      this.generatedTools.set(improvedTool.name, improvedTool);
      (this.registry as any).tools.set(improvedTool.name, improvedTool);
      
      console.log(`🔧 Improved tool: ${toolName} -> ${improvedTool.name}`);
    }
  }

  // Generate tools for common missing capabilities
  async generateMissingTools(taskHistory: Array<{ task: string; tools: string[]; success: boolean }>): Promise<string[]> {
    const failedTasks = taskHistory.filter(t => !t.success);
    const missingCapabilities = this.analyzeMissingCapabilities(failedTasks);
    
    const generatedTools: string[] = [];
    
    for (const capability of missingCapabilities) {
      try {
        const toolName = await this.generateTool(capability.description, capability.examples);
        generatedTools.push(toolName);
      } catch (error) {
        console.warn(`Failed to generate tool for capability: ${capability.description}`, error);
      }
    }
    
    return generatedTools;
  }

  private analyzeMissingCapabilities(failedTasks: Array<{ task: string; tools: string[]; success: boolean }>) {
    const capabilities: Array<{ description: string; examples: Array<{ input: any; output: any }> }> = [];
    
    // Analyze common failure patterns
    const taskPatterns = new Map<string, number>();
    
    for (const task of failedTasks) {
      const taskType = this.categorizeTask(task.task);
      taskPatterns.set(taskType, (taskPatterns.get(taskType) || 0) + 1);
    }
    
    // Generate tools for common failure patterns
    for (const [pattern, count] of taskPatterns) {
      if (count >= 2) { // At least 2 failures of this type
        switch (pattern) {
          case 'data_processing':
            capabilities.push({
              description: 'Process and transform structured data (CSV, JSON, XML)',
              examples: [
                { input: { data: '[{"name":"John","age":30}]', format: 'json' }, output: { processed: true, count: 1 } }
              ]
            });
            break;
          case 'text_analysis':
            capabilities.push({
              description: 'Analyze text for sentiment, keywords, and entities',
              examples: [
                { input: { text: 'This is a great product!' }, output: { sentiment: 'positive', keywords: ['great', 'product'] } }
              ]
            });
            break;
          case 'api_integration':
            capabilities.push({
              description: 'Make HTTP requests to APIs with authentication and error handling',
              examples: [
                { input: { url: 'https://api.example.com/data', method: 'GET' }, output: { status: 200, data: {} } }
              ]
            });
            break;
        }
      }
    }
    
    return capabilities;
  }

  private categorizeTask(task: string): string {
    const lowerTask = task.toLowerCase();
    
    if (lowerTask.includes('csv') || lowerTask.includes('json') || lowerTask.includes('data')) return 'data_processing';
    if (lowerTask.includes('sentiment') || lowerTask.includes('analyze text')) return 'text_analysis';
    if (lowerTask.includes('api') || lowerTask.includes('request') || lowerTask.includes('endpoint')) return 'api_integration';
    if (lowerTask.includes('image') || lowerTask.includes('photo')) return 'image_processing';
    if (lowerTask.includes('email') || lowerTask.includes('notification')) return 'communication';
    
    return 'general';
  }

  getGeneratedTools(): Array<{ name: string; description: string; generated: boolean }> {
    return Array.from(this.generatedTools.values()).map(tool => ({
      name: tool.name,
      description: tool.description,
      generated: true
    }));
  }

  // Export generated tools for persistence
  exportGeneratedTools(): string {
    const tools = Array.from(this.generatedTools.values()).map(tool => ({
      name: tool.name,
      description: tool.description,
      // Note: We can't serialize the actual implementation, would need to store the original spec
    }));
    
    return JSON.stringify(tools, null, 2);
  }
}
