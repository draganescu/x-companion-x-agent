import { z } from 'zod';
import type { Ctx } from '../context.js';
import { ConnectionArgsShape, connectionArgs, defineTool } from './_shared.js';

const InputSchema = z.object({ ...ConnectionArgsShape });

const OutputSchema = z.object({
  site_url: z.string(),
  posture: z.enum(['toolchain', 'production']),
  fingerprint: z.string(),
  wp_version: z.string(),
  blocks_count: z.number(),
  suites: z.array(z.string()),
  interfaces_version: z.string(),
  url_form: z.enum(['pretty', 'plain', 'unknown']),
  config_sources: z.object({ url: z.string(), user: z.string(), app_password: z.string() }),
});

export const wpConnect = defineTool({
  name: 'wp_connect',
  title: 'Connect to a WordPress instance',
  description:
    'Resolve connection config (tool args > .x-agent.json > X_WP_* env), probe GET /fingerprint and GET /manifest, and cache the manifest keyed by fingerprint. Refuses plain http:// unless the host is localhost/127.0.0.1/[::1]/*.localhost/a playground host. The returned fingerprint is the epoch every TreeIR must carry.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  handler: async (input: unknown, ctx: Ctx) => {
    ctx.runtime.setOverrides(connectionArgs(input));
    const live = ctx.runtime.ctx(connectionArgs(input));
    await live.companion.fetchFingerprint();
    const manifest = await live.companion.fetchManifest();
    return {
      site_url: manifest.site_url,
      posture: manifest.posture,
      fingerprint: manifest.fingerprint,
      wp_version: manifest.wp_version,
      blocks_count: manifest.counts.blocks,
      suites: manifest.suites.map((s) => s.slug),
      interfaces_version: manifest.interfaces_version,
      url_form: live.companion.resolvedUrlForm,
      config_sources: {
        url: live.config.sources.url,
        user: live.config.sources.user,
        app_password: live.config.sources.app_password,
      },
    };
  },
});

const DisconnectInput = z.object({});
const DisconnectOutput = z.object({
  disconnected: z.boolean(),
  was_connected: z.boolean(),
  session_closed: z.boolean(),
  factory_closed: z.boolean(),
  caches_cleared: z.boolean(),
});

export const wpDisconnect = defineTool({
  name: 'wp_disconnect',
  title: 'Disconnect and drop all caches',
  description:
    'Close the warm Playwright harness session (if any), drop the block factory, clear the manifest/pattern/fingerprint caches and forget the pinned connection overrides. Use before switching instances or when the instance was rebuilt underneath the agent.',
  inputSchema: DisconnectInput,
  outputSchema: DisconnectOutput,
  local: true,
  handler: async (_input: unknown, ctx: Ctx) => {
    const r = await ctx.runtime.disconnect();
    return { disconnected: true, ...r };
  },
});

export const tools = [wpConnect, wpDisconnect];
