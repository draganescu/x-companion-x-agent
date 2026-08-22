/**
 * Structured agent-side error envelope — CONTRACT.md §7.
 *
 * MCP tools NEVER throw a bare error to the client. Every failure leaves this
 * package as `{ code, message, hint }` (+ code-specific fields).
 *
 * `redact()` is the single chokepoint that keeps the WordPress application
 * password out of every log line, error message and tool output. Register the
 * password once (config.ts does this) and every string that passes through
 * `redact()` afterwards has it replaced with `***`.
 */

/** Codes pinned by CONTRACT.md §7 plus two agent-local additions (see fragment deviations[]). */
export const ERROR_CODES = [
  'https_required',
  'posture_forbidden',
  'harness_gap',
  'epoch_mismatch',
  'companion_unreachable',
  'companion_error',
  'invalid_input',
  'build_failed',
  'schema_policy',
  'smoke_failed',
  // agent-local additions, not on the wire to the companion:
  'not_implemented',
  'internal',
] as const;

export type XErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorEnvelope {
  code: XErrorCode;
  message: string;
  hint: string;
  [k: string]: unknown;
}

export class XError extends Error {
  readonly code: XErrorCode;
  readonly hint: string;
  readonly extra: Record<string, unknown>;

  constructor(code: XErrorCode, message: string, hint: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'XError';
    this.code = code;
    this.hint = hint;
    this.extra = extra;
  }

  toEnvelope(): ErrorEnvelope {
    return { code: this.code, message: redact(this.message), hint: this.hint, ...redactDeep(this.extra) };
  }
}

export function isXError(e: unknown): e is XError {
  return e instanceof XError || (typeof e === 'object' && e !== null && (e as XError).name === 'XError');
}

/** Never let an unknown throw escape as-is. */
export function toEnvelope(e: unknown): ErrorEnvelope {
  if (isXError(e)) return (e as XError).toEnvelope();
  const message = e instanceof Error ? e.message : String(e);
  return {
    code: 'internal',
    message: redact(message),
    hint: 'This is an unexpected agent-side failure; re-run with X_AGENT_DEBUG=1 for a stack trace.',
  };
}

/* ------------------------------------------------------------------ redact */

const SECRETS = new Set<string>();

/** Register a secret (the app password) so every later `redact()` scrubs it. */
export function registerSecret(secret: string | undefined | null): void {
  if (typeof secret === 'string' && secret.length >= 4) SECRETS.add(secret);
}

/** Test hook only. */
export function clearSecrets(): void {
  SECRETS.clear();
}

const BASIC_HEADER_RE = /(Basic\s+)[A-Za-z0-9+/=]+/gi;
const URL_USERINFO_RE = /(\/\/)([^/@\s:]+):([^/@\s]*)@/g;
const APP_PW_SHAPE_RE = /\b(?:[A-Za-z0-9]{4}\s){5}[A-Za-z0-9]{4}\b/g;

/**
 * Scrub credentials out of an arbitrary string: registered secrets, HTTP Basic
 * header values, `https://user:pass@host` userinfo, and the literal
 * `xxxx xxxx xxxx xxxx xxxx xxxx` shape WordPress application passwords use.
 */
export function redact(input: string): string {
  let out = String(input);
  for (const s of SECRETS) {
    if (!s) continue;
    out = out.split(s).join('***');
    // application passwords are commonly pasted with the spaces stripped
    const compact = s.replace(/\s+/g, '');
    if (compact.length >= 8 && compact !== s) out = out.split(compact).join('***');
  }
  out = out.replace(BASIC_HEADER_RE, '$1***');
  out = out.replace(URL_USERINFO_RE, '$1$2:***@');
  out = out.replace(APP_PW_SHAPE_RE, '***');
  return out;
}

/** Redact every string reachable inside a plain JSON value. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = /pass(word)?|secret|authorization|token/i.test(k) ? '***' : redactDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}

/* ------------------------------------------------------- common constructors */

export const errInvalidInput = (message: string, hint = 'Fix the tool arguments and call again.', extra: Record<string, unknown> = {}) =>
  new XError('invalid_input', message, hint, extra);

export const errNotImplemented = (tool: string) =>
  new XError(
    'not_implemented',
    `Tool "${tool}" is declared but its handler module is not present in this build.`,
    'This tool ships in the session/oracle/factory track (src/tools/{compile,verify,screenshot,blockScaffold,blockBuildTest,blockInstall}.ts). Install a build that includes it.',
    { tool },
  );

export const errPostureForbidden = (route: string) =>
  new XError(
    'posture_forbidden',
    `The connected instance has posture "production"; ${route} is an extend-tier route and is refused by design.`,
    'clone to sandbox via wp_snapshot then apply there',
    { route },
  );

export const errEpochMismatch = (expected: string, actual: string) =>
  new XError(
    'epoch_mismatch',
    `The instance fingerprint moved and stayed moved after one refresh+retry (expected ${expected}, instance reports ${actual}).`,
    'Call wp_manifest({refresh:true}), regenerate the tree with the new epoch, and retry.',
    { expected_fingerprint: expected, server_fingerprint: actual },
  );
