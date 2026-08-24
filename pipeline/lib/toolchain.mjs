// In-process consumption of the MCP tool handlers — the spec's recorded decision:
// not a fork, not a second server. One Runtime per run = one holder of epoch state,
// one config chain, one redaction layer.
import { Runtime } from '../../x-agent/mcp/dist/mcp/src/context.js';
import { callTool } from '../../x-agent/mcp/dist/mcp/src/server.js';
import { loadExternalHandlers, isUnimplemented } from '../../x-agent/mcp/dist/mcp/src/registry.js';
import { registerSecret } from '../../x-agent/mcp/dist/mcp/src/errors.js';
import { PipelineError } from './errors.mjs';

export async function createToolchain({ cwd = process.cwd(), providerKeys = {} } = {}) {
    await loadExternalHandlers();
    // loadExternalHandlers is a module-level one-shot; when another importer ran
    // it first, the report lies — the tool table is the truth.
    if (isUnimplemented('wp_compile')) {
        throw new PipelineError('preflight_failed', 'external tool handlers did not load (wp_compile is a placeholder)',
            'Rebuild x-agent/mcp (npm run build) — dist may be stale.');
    }
    for (const v of Object.values(providerKeys)) {
        if (typeof v === 'string' && v.length >= 4) registerSecret(v);
    }
    const runtime = new Runtime({ cwd });
    return {
        runtime,
        async call(name, args = {}) {
            // Watchdog: a tool call that outlives every internal timeout is a
            // bug worth a name in the log, not a silent stall.
            const started = Date.now();
            const watchdog = setInterval(() => {
                console.error(`[x-pipeline] still waiting on ${name} after ${Math.round((Date.now() - started) / 1000)}s`);
            }, 60_000);
            try {
                const res = await callTool(name, args, runtime);
                return { ok: !res.isError, data: JSON.parse(res.content[0].text) };
            } finally {
                clearInterval(watchdog);
            }
        },
        async dispose() {
            await runtime.disconnect();
        },
    };
}
