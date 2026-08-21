#!/usr/bin/env node
/**
 * tools/mcp-bridge.mjs — drive the x-agent MCP server without Claude Code.
 *
 * Spawns the built server (x-agent/mcp/dist) over stdio and exposes it on a
 * local HTTP endpoint, so shell scripts, CI jobs, proofs and other agents can
 * call the wp_* tools with nothing but curl:
 *
 *   node tools/mcp-bridge.mjs [--port 9490] [--cwd <dir>]
 *
 *   curl -s localhost:9490/tools
 *   curl -s -X POST localhost:9490/call \
 *        -H 'content-type: application/json' \
 *        -d '{"tool":"wp_connect","args":{}}'
 *
 * One server process lives for the bridge's lifetime, so the warm browser
 * session, manifest caches and epoch state behave exactly as they do under a
 * real MCP client. `--cwd` (default: the repo root) is the directory whose
 * `.x-agent.json` the server reads. Build the server first:
 * `cd x-agent/mcp && npm install && npm run build`.
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP_DIR = path.join(REPO, 'x-agent', 'mcp');
const SERVER = path.join(MCP_DIR, 'dist', 'mcp', 'src', 'server.js');

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const PORT = Number(argOf('--port', '9490'));
const CWD = path.resolve(argOf('--cwd', REPO));

// Resolve the SDK from the server's own node_modules so the bridge needs no
// install step of its own.
const sdk = (rel) => import(pathToFileURL(path.join(MCP_DIR, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', rel)).href);
const { Client } = await sdk('client/index.js');
const { StdioClientTransport } = await sdk('client/stdio.js');

const transport = new StdioClientTransport({
    command: 'node',
    args: [SERVER],
    cwd: CWD,
    env: {
        ...process.env,
        X_AGENT_PLUGIN_ROOT: path.join(REPO, 'x-agent'),
        X_AGENT_DATA_DIR: process.env.X_AGENT_DATA_DIR ?? path.join(REPO, 'tools', '.runtime', 'x-agent-data'),
    },
    stderr: 'pipe',
});

const client = new Client({ name: 'x-agent-bridge', version: '1.0.0' });
await client.connect(transport);
transport.stderr?.on('data', (d) => process.stderr.write(d));

const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
        try {
            if (req.method === 'GET' && req.url === '/tools') {
                const list = await client.listTools();
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify(list.tools.map((t) => t.name)));
                return;
            }
            if (req.method !== 'POST' || req.url !== '/call') {
                res.writeHead(404, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ bridge_error: 'Use GET /tools or POST /call {tool,args}.' }));
                return;
            }
            const { tool, args: toolArgs } = JSON.parse(body || '{}');
            const result = await client.callTool(
                { name: tool, arguments: toolArgs ?? {} },
                undefined,
                { timeout: 600_000, resetTimeoutOnProgress: true },
            );
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ bridge_error: String(err?.message ?? err) }));
        }
    });
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`x-agent bridge on http://127.0.0.1:${PORT}  (GET /tools, POST /call {tool,args})`);
    console.log(`server cwd: ${CWD}  (reads .x-agent.json there)`);
});
