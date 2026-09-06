// `iwik mcp`: a stdio MCP server inside the runner CLI (ADR-0006) exposing
// the ten tools of contracts/agent-tools.md. There is no hosted endpoint:
// the transport is local, so the cloud never opens a channel into a member
// environment. Tool inputs and outputs are validated with the generated
// schemas (tools.ts); the tool list carries those same schemas verbatim.
//
// Dark-launch flag: IWIK_MCP_ENABLED (default off). Without it the server
// refuses to start and says why.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { toolNames, tools, toolSchemaDocument } from '@iwik/contracts';
import { RunnerError } from './errors.js';
import { runnerRoot } from './pack.js';
import { callTool, isToolName } from './tools.js';
import type { ToolContext } from './tools.js';

export const MCP_FLAG = 'IWIK_MCP_ENABLED';
export const SKILL_PATH = resolve(runnerRoot, 'SKILL.md');

export function mcpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[MCP_FLAG];
  if (raw === undefined) return false;
  return ['on', 'true', '1', 'yes', 'enabled'].includes(raw.trim().toLowerCase());
}

/** The refusal `iwik mcp` prints when the flag is off. */
export function mcpDisabledMessage(): string {
  return (
    `iwik mcp is disabled: ${MCP_FLAG} is not set (dark-launch flag, default off). ` +
    `The MCP adapter lets an agent read protocols, query the cooperative, plan and (under policy.json) run tests, ` +
    `preview and submit runs from this node. Start it with ${MCP_FLAG}=on iwik mcp once you have reviewed SKILL.md and policy.json.`
  );
}

export function runnerVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(runnerRoot, 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** SKILL.md, handed to the client as the server's instructions. */
export function skillText(): string {
  try {
    return readFileSync(SKILL_PATH, 'utf8');
  } catch {
    return '';
  }
}

/** The MCP tool list: name, description, and the committed schemas verbatim. */
export function toolList() {
  return toolNames.map((name) => {
    const definition = tools[name];
    return {
      name,
      title: name.replace(/_/g, ' '),
      description: `${definition.description} Scope: ${definition.scope}; side effect: ${definition.side_effect}.`,
      inputSchema: toolSchemaDocument(name, 'input'),
      outputSchema: toolSchemaDocument(name, 'output'),
      annotations: {
        readOnlyHint: definition.side_effect === 'read',
        destructiveHint: definition.side_effect === 'paid',
        idempotentHint: definition.side_effect === 'read',
        openWorldHint: definition.side_effect !== 'local_write',
      },
    };
  });
}

export function buildServer(ctx: ToolContext): Server {
  const server = new Server(
    { name: 'iwik', version: runnerVersion() },
    { capabilities: { tools: {} }, instructions: skillText() },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolList() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    if (!isToolName(name)) {
      throw new McpError(ErrorCode.MethodNotFound, `unknown tool: ${name}`);
    }
    const envelope = await callTool(name, request.params.arguments ?? {}, ctx);
    return {
      content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
      structuredContent: envelope,
    };
  });
  return server;
}

/** Start serving on stdio; resolves when the transport closes. */
export async function serveMcp(
  ctx: ToolContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!mcpEnabled(env)) throw new RunnerError('feature_disabled', mcpDisabledMessage());
  const server = buildServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolveDone) => {
    server.onclose = () => resolveDone();
  });
}
