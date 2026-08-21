#!/usr/bin/env node
/**
 * x-agent MCP server — stdio transport.
 *
 * stdout is the MCP wire. Nothing but JSON-RPC may be written there; every log
 * line goes to stderr through `stderrLogger`, and every log line is passed
 * through `redact()` so the WordPress application password can never appear.
 *
 * Contract for tool calls:
 *   - input is validated against the tool's zod input schema before the handler
 *     runs; a failure is `{code:'invalid_input'}`, never a throw
 *   - the handler's return value is validated against the zod output schema; a
 *     failure is `{code:'internal'}` naming the offending path, so a broken tool
 *     is caught here rather than confusing the caller
 *   - every error leaves as the CONTRACT.md §7 envelope {code, message, hint}
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { TOOLS, loadExternalHandlers, findTool, isUnimplemented, type ToolDef } from './registry.js';
import { Runtime } from './context.js';
import { toEnvelope, XError, redact } from './errors.js';
import { stderrLogger, type Logger } from './companion.js';

export const SERVER_NAME = 'x-agent';
export const SERVER_VERSION = '0.1.0';

/** zod -> JSON Schema for the wire. Uses zod v4's built-in converter. */
export function toJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  try {
    return z.toJSONSchema(schema, {
      target: 'draft-7',
      io: 'input',
      unrepresentable: 'any',
    }) as Record<string, unknown>;
  } catch {
    return { type: 'object' };
  }
}

export function describeTool(tool: ToolDef): Record<string, unknown> {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: toJsonSchema(tool.inputSchema),
    outputSchema: toJsonSchema(tool.outputSchema),
  };
}

export interface CallResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

/**
 * One tool invocation, fully guarded. Exported so tests can drive tools without
 * standing up a transport.
 */
export async function callTool(name: string, args: unknown, runtime: Runtime): Promise<CallResult> {
  const tool = findTool(name);
  if (!tool) {
    return errorResult(
      new XError('invalid_input', `Unknown tool "${name}".`, `Known tools: ${TOOLS.map((t) => t.name).join(', ')}`),
    );
  }

  try {
    const parsed = tool.inputSchema.safeParse(args ?? {});
    if (!parsed.success) {
      const detail = parsed.error.issues
        .slice(0, 6)
        .map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
        .join('; ');
      throw new XError(
        'invalid_input',
        `Arguments for ${name} failed validation: ${detail}`,
        'Re-read the tool input schema and call again with corrected arguments.',
        { tool: name },
      );
    }

    // Handlers receive the ORIGINAL arguments, not the stripped parse output,
    // so tools whose job is to report schema violations still see every key.
    //
    // Ctx is built in `optional` mode for tools that need no connection AND for
    // tools whose handler module is not present, so those two cases report
    // `not_implemented` / their own local result instead of being masked by a
    // config error. In optional mode config/companion/manifestCache are accessor
    // traps that throw the real structured config error if actually touched.
    const optional = tool.local === true || isUnimplemented(tool.name);
    const ctx = runtime.ctx(connectionArgsFrom(args), { optional });
    const result = await tool.handler(args ?? {}, ctx);

    const out = tool.outputSchema.safeParse(result);
    if (!out.success) {
      const detail = out.error.issues
        .slice(0, 6)
        .map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
        .join('; ');
      throw new XError(
        'internal',
        `Tool ${name} produced output that does not match its own output schema: ${detail}`,
        'This is an agent-side bug; report it with the tool name and arguments.',
        { tool: name },
      );
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result as Record<string, unknown>,
    };
  } catch (e) {
    return errorResult(e);
  }
}

function errorResult(e: unknown): CallResult {
  const envelope = toEnvelope(e);
  return {
    // No structuredContent on the error path: it would not match the tool's
    // declared output schema and strict clients reject that.
    content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
    isError: true,
  };
}

function connectionArgsFrom(args: unknown): { url?: string; user?: string; app_password?: string } {
  if (!args || typeof args !== 'object') return {};
  const a = args as Record<string, unknown>;
  const out: { url?: string; user?: string; app_password?: string } = {};
  if (typeof a.url === 'string') out.url = a.url;
  if (typeof a.user === 'string') out.user = a.user;
  if (typeof a.app_password === 'string') out.app_password = a.app_password;
  return out;
}

/* ------------------------------------------------------------------- wiring */

export interface CreateServerOptions {
  runtime?: Runtime;
  logger?: Logger;
}

export async function createServer(opts: CreateServerOptions = {}): Promise<{ server: Server; runtime: Runtime }> {
  const logger = opts.logger ?? stderrLogger(process.env.X_AGENT_DEBUG === '1');
  const runtime = opts.runtime ?? new Runtime({ logger });

  const report = await loadExternalHandlers({ logger });
  if (report.missing.length) {
    logger.info(
      `${report.missing.length} tool handler(s) not present in this build; they list normally and return {code:"not_implemented"} when called: ${report.missing.join(', ')}`,
    );
  }
  for (const f of report.failed) logger.warn(`tool module ${f.module} failed to load: ${redact(f.error)}`);

  const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS.map(describeTool) }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    return (await callTool(name, args, runtime)) as never;
  });

  return { server, runtime };
}

export async function main(): Promise<void> {
  const logger = stderrLogger(process.env.X_AGENT_DEBUG === '1');
  const { server, runtime } = await createServer({ logger });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info(`x-agent MCP server ready on stdio with ${TOOLS.length} tools`);

  const shutdown = async () => {
    try {
      await runtime.disconnect();
    } catch {
      /* best effort */
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/** Only auto-start when this file is the process entry point. */
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  const normalise = (p: string) => p.split(/[/\\]/).pop() ?? '';
  return normalise(new URL(import.meta.url).pathname) === normalise(entry);
})();

if (invokedDirectly) {
  main().catch((e) => {
    process.stderr.write(`[x-agent fatal] ${redact((e as Error).message)}\n`);
    process.exit(1);
  });
}
