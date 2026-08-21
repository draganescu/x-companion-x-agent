/**
 * ============================================================================
 * SEAM CONTRACT — read this before adding a tool module.
 * ============================================================================
 *
 * Two tracks implement tools in this one package without ever editing each
 * other's files:
 *
 *   CORE track  (owns this file)  : config, errors, schemas, companion client,
 *                                   registry, tools/{connect,manifest,patterns,
 *                                   validate,parse,render,specValidate,tokens,
 *                                   snapshot}.ts
 *   SESSION track (does NOT edit this file) : session.ts, oracle.ts, factory.ts,
 *                                   tools/{compile,verify,screenshot,
 *                                   blockScaffold,blockBuildTest,blockInstall}.ts
 *
 * ---------------------------------------------------------------------------
 * 1. Every tool handler receives `(input, ctx: Ctx)`.
 * ---------------------------------------------------------------------------
 * `Ctx` always carries:
 *     config        : XConfig               resolved connection config
 *     companion     : CompanionClient       THE ONLY HTTP SURFACE (see companion.ts)
 *     manifestCache : ManifestCache         cached Manifest + 10s fingerprint probe
 *     logger        : Logger                stderr-only; stdout is the MCP transport
 *     runtime       : Runtime               per-process state (see below)
 *   and two OPTIONAL slots the session track populates:
 *     session?      : unknown               warm Playwright browser + harness page
 *     factory?      : unknown               block scaffold/build/smoke/package
 *
 * ---------------------------------------------------------------------------
 * 2. Two ways for the session track to type its slots. Pick either.
 * ---------------------------------------------------------------------------
 * (a) DECLARATION MERGING — no edit to this file. In `session.ts`:
 *
 *         import type {} from './context.js';
 *         export interface HarnessSession { compile(...): Promise<...>; close(): Promise<void>; }
 *         declare module './context.js' {
 *           interface Ctx { session?: HarnessSession }
 *         }
 *
 *     The `session?: unknown` member below is intentionally OPTIONAL and typed
 *     `unknown` so a merged re-declaration narrows it without conflict.
 *
 * (b) PROVIDER HOOKS — preferred, because it also gets you lazy construction and
 *     disposal on `wp_disconnect`. In `session.ts`, at module top level:
 *
 *         registerSessionProvider({
 *           create: async (ctx) => new HarnessSession(ctx),   // called on demand
 *           dispose: async (s) => (s as HarnessSession).close(),
 *           // called when the epoch moves so the page can reload:
 *           onEpochChange: async (s, fingerprint) => (s as HarnessSession).reload(fingerprint),
 *         });
 *
 *     then inside a handler:  const session = await getSession(ctx) as HarnessSession;
 *
 *     `registerFactoryProvider` / `getFactory` are the same shape for factory.ts.
 *     Registration is idempotent-by-last-write and must happen at module load
 *     (i.e. at the top of the module the registry dynamically imports).
 *
 * ---------------------------------------------------------------------------
 * 3. NEVER write `fetch` outside companion.ts.
 * ---------------------------------------------------------------------------
 * `ctx.companion` exposes every CONTRACT.md §5 route, plus `harnessUrl()`,
 * `harnessUrlAlternate()`, `basicCredentials()`, `authHeader()` for Playwright
 * and `installBlockFromFile()` / `installBlockBytes()` for the multipart POST.
 *
 * ---------------------------------------------------------------------------
 * 4. NEVER throw a bare error out of a handler.
 * ---------------------------------------------------------------------------
 * Throw `XError` from errors.ts (or one of the `err*` constructors). The
 * registry converts it to the CONTRACT.md §7 envelope `{code,message,hint}`.
 * ============================================================================
 */
import {
  CompanionClient,
  ManifestCache,
  stderrLogger,
  type Logger,
} from './companion.js';
import { resolveConfig, configIdentity, type ConnectionArgs, type XConfig } from './config.js';

export interface Ctx {
  config: XConfig;
  companion: CompanionClient;
  manifestCache: ManifestCache;
  logger: Logger;
  runtime: Runtime;
  /** Populated by the session track (see seam contract note 2). */
  session?: unknown;
  /** Populated by the session track (see seam contract note 2). */
  factory?: unknown;
}

/* ------------------------------------------------------------- providers */

export interface Provider<T = unknown> {
  create: (ctx: Ctx) => Promise<T> | T;
  dispose?: (instance: T) => Promise<void> | void;
  onEpochChange?: (instance: T, fingerprint: string) => Promise<void> | void;
}

let sessionProvider: Provider | undefined;
let factoryProvider: Provider | undefined;

export function registerSessionProvider(p: Provider): void {
  sessionProvider = p as Provider;
}
export function registerFactoryProvider(p: Provider): void {
  factoryProvider = p as Provider;
}
export function hasSessionProvider(): boolean {
  return sessionProvider !== undefined;
}
export function hasFactoryProvider(): boolean {
  return factoryProvider !== undefined;
}
/** Test hook. */
export function clearProviders(): void {
  sessionProvider = undefined;
  factoryProvider = undefined;
}

/* ---------------------------------------------------------------- runtime */

export interface RuntimeOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Per-process state: the resolved connection, its client, its caches, and the
 * lazily created session/factory instances. `wp_connect` pins connection
 * overrides here; `wp_disconnect` tears everything down.
 */
export class Runtime {
  readonly logger: Logger;
  private readonly opts: RuntimeOptions;

  private overrides: ConnectionArgs = {};
  private identity?: string;
  private client?: CompanionClient;
  private cache?: ManifestCache;
  private sessionInstance?: unknown;
  private factoryInstance?: unknown;
  private lastEpochSeenBySession?: string;

  constructor(opts: RuntimeOptions = {}) {
    this.opts = opts;
    this.logger = opts.logger ?? stderrLogger(process.env.X_AGENT_DEBUG === '1');
  }

  /** Pin connection arguments for subsequent tool calls (wp_connect). */
  setOverrides(args: ConnectionArgs): void {
    const clean: ConnectionArgs = {};
    if (args.url) clean.url = args.url;
    if (args.user) clean.user = args.user;
    if (args.app_password) clean.app_password = args.app_password;
    this.overrides = clean;
  }

  /**
   * Build the Ctx for one tool call. `args` (tool arguments) beat the pinned
   * wp_connect overrides, which beat `.x-agent.json`, which beats env.
   */
  ctx(args: ConnectionArgs = {}, opts: { optional?: boolean } = {}): Ctx {
    if (opts.optional) {
      try {
        return this.ctx(args);
      } catch (e) {
        return this.stubCtx(e as Error);
      }
    }
    const merged: ConnectionArgs = {
      url: args.url ?? this.overrides.url,
      user: args.user ?? this.overrides.user,
      app_password: args.app_password ?? this.overrides.app_password,
    };
    const resolveOpts: { cwd?: string; env?: NodeJS.ProcessEnv } = {};
    if (this.opts.cwd) resolveOpts.cwd = this.opts.cwd;
    if (this.opts.env) resolveOpts.env = this.opts.env;
    const config = resolveConfig(merged, resolveOpts);
    const id = configIdentity(config);

    if (!this.client || this.identity !== id) {
      if (this.identity !== id) void this.disposeInstances();
      const clientOpts: ConstructorParameters<typeof CompanionClient>[0] = { config, logger: this.logger };
      if (this.opts.fetchImpl) clientOpts.fetchImpl = this.opts.fetchImpl;
      this.client = new CompanionClient(clientOpts);
      this.cache = new ManifestCache(this.client);
      this.identity = id;
    }

    const ctx: Ctx = {
      config,
      companion: this.client,
      manifestCache: this.cache!,
      logger: this.logger,
      runtime: this,
    };
    if (this.sessionInstance !== undefined) ctx.session = this.sessionInstance;
    if (this.factoryInstance !== undefined) ctx.factory = this.factoryInstance;
    return ctx;
  }

  /**
   * Ctx for a fully-local tool (wp_spec_validate, wp_disconnect) when no
   * connection config is resolvable. `config`/`companion`/`manifestCache` are
   * accessor traps that re-throw the original structured config error, so a
   * local tool that unexpectedly reaches for the network still fails with a
   * proper `{code:'invalid_input'}` envelope instead of a TypeError.
   */
  private stubCtx(cause: Error): Ctx {
    const thrower = () => {
      throw cause;
    };
    const c = { logger: this.logger, runtime: this } as unknown as Ctx;
    Object.defineProperty(c, 'config', { get: thrower, enumerable: true, configurable: true });
    Object.defineProperty(c, 'companion', { get: thrower, enumerable: true, configurable: true });
    Object.defineProperty(c, 'manifestCache', { get: thrower, enumerable: true, configurable: true });
    return c;
  }

  async getSession(ctx: Ctx): Promise<unknown> {
    if (!sessionProvider) return undefined;
    if (this.sessionInstance === undefined) {
      this.sessionInstance = await sessionProvider.create(ctx);
      this.lastEpochSeenBySession = ctx.companion.expectedFingerprint ?? '';
    } else {
      const fp = ctx.companion.expectedFingerprint ?? '';
      if (fp && fp !== this.lastEpochSeenBySession && sessionProvider.onEpochChange) {
        await sessionProvider.onEpochChange(this.sessionInstance, fp);
        this.lastEpochSeenBySession = fp;
      }
    }
    ctx.session = this.sessionInstance;
    return this.sessionInstance;
  }

  async getFactory(ctx: Ctx): Promise<unknown> {
    if (!factoryProvider) return undefined;
    if (this.factoryInstance === undefined) {
      this.factoryInstance = await factoryProvider.create(ctx);
    }
    ctx.factory = this.factoryInstance;
    return this.factoryInstance;
  }

  private async disposeInstances(): Promise<{ session_closed: boolean; factory_closed: boolean }> {
    let sessionClosed = false;
    let factoryClosed = false;
    if (this.sessionInstance !== undefined) {
      try {
        await sessionProvider?.dispose?.(this.sessionInstance);
      } catch (e) {
        this.logger.warn(`session dispose failed: ${(e as Error).message}`);
      }
      this.sessionInstance = undefined;
      this.lastEpochSeenBySession = undefined;
      sessionClosed = true;
    }
    if (this.factoryInstance !== undefined) {
      try {
        await factoryProvider?.dispose?.(this.factoryInstance);
      } catch (e) {
        this.logger.warn(`factory dispose failed: ${(e as Error).message}`);
      }
      this.factoryInstance = undefined;
      factoryClosed = true;
    }
    return { session_closed: sessionClosed, factory_closed: factoryClosed };
  }

  /** wp_disconnect: drop the warm session and clear every cache. */
  async disconnect(): Promise<{ session_closed: boolean; factory_closed: boolean; caches_cleared: boolean; was_connected: boolean }> {
    const wasConnected = this.client !== undefined;
    const closed = await this.disposeInstances();
    this.client?.reset();
    this.cache?.clear();
    this.client = undefined;
    this.cache = undefined;
    this.identity = undefined;
    this.overrides = {};
    return { ...closed, caches_cleared: true, was_connected: wasConnected };
  }
}

/** Convenience wrappers so tool modules do not reach into Runtime directly. */
export const getSession = (ctx: Ctx): Promise<unknown> => ctx.runtime.getSession(ctx);
export const getFactory = (ctx: Ctx): Promise<unknown> => ctx.runtime.getFactory(ctx);

export type { Logger } from './companion.js';
export { CompanionClient, ManifestCache } from './companion.js';
export type { XConfig, ConnectionArgs } from './config.js';
