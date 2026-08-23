/**
 * Connection config resolution.
 *
 * Precedence, per field, highest first (agent spec `environment.config`):
 *   1. tool arguments             ({url, user, app_password} on wp_connect etc.)
 *   2. `.x-agent.json` in CWD     ({url|site_url, user, app_password})
 *   3. env vars                   X_WP_URL, X_WP_USER, X_WP_APP_PASSWORD
 *
 * The app password is NEVER written anywhere by this package. It is registered
 * with errors.ts#registerSecret the moment it is resolved so that every logged
 * URL, header and error message is scrubbed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { XError, registerSecret } from './errors.js';
export const CONFIG_FILENAME = '.x-agent.json';
/* ------------------------------------------------------------- https policy */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);
/**
 * Plain http:// is refused unless the host is loopback-ish or a `playground`
 * host (any dot-separated label equal to `playground`, which covers
 * playground.wordpress.net and *.playground.* dev hosts).
 */
export function isInsecureAllowedHost(hostname) {
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (LOCAL_HOSTNAMES.has(h) || LOCAL_HOSTNAMES.has(hostname.toLowerCase()))
        return true;
    if (h.endsWith('.localhost'))
        return true;
    if (h.split('.').includes('playground'))
        return true;
    return false;
}
export function assertTransportAllowed(rawUrl) {
    let u;
    try {
        u = new URL(rawUrl);
    }
    catch {
        throw new XError('invalid_input', `"${rawUrl}" is not a valid absolute URL.`, 'Pass the full site URL including scheme, e.g. https://example.com');
    }
    if (u.protocol === 'https:')
        return u;
    if (u.protocol === 'http:') {
        if (isInsecureAllowedHost(u.hostname))
            return u;
        throw new XError('https_required', `Refusing to send an application password over plain http:// to "${u.hostname}".`, 'Use https:// for the site URL. Plain http is only allowed for localhost, 127.0.0.1, [::1], *.localhost and playground hosts.', { host: u.hostname });
    }
    throw new XError('invalid_input', `Unsupported URL scheme "${u.protocol}".`, 'The site URL must be http:// (local only) or https://.');
}
/** Strip trailing slashes and any embedded userinfo. */
export function normaliseSiteUrl(u) {
    const clean = new URL(u.toString());
    clean.username = '';
    clean.password = '';
    clean.hash = '';
    clean.search = '';
    let s = clean.toString();
    while (s.endsWith('/'))
        s = s.slice(0, -1);
    return s;
}
export function readConfigFile(cwd) {
    const file = path.join(cwd, CONFIG_FILENAME);
    if (!fs.existsSync(file))
        return { data: {} };
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch (e) {
        throw new XError('invalid_input', `${CONFIG_FILENAME} in ${cwd} is not valid JSON: ${e.message}`, `Fix the JSON in ${file} or delete it and use the X_WP_* environment variables.`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new XError('invalid_input', `${CONFIG_FILENAME} must contain a JSON object.`, `Fix ${file}.`);
    }
    return { data: parsed, file };
}
/* ------------------------------------------------------------------ resolve */
function pick(args, file, env) {
    if (typeof args === 'string' && args.trim() !== '')
        return { value: args.trim(), source: 'arguments' };
    if (typeof file === 'string' && file.trim() !== '')
        return { value: file.trim(), source: 'file' };
    if (typeof env === 'string' && env.trim() !== '')
        return { value: env.trim(), source: 'env' };
    return { source: 'missing' };
}
export function resolveConfig(args = {}, opts = {}) {
    const cwd = opts.cwd ?? process.cwd();
    const env = opts.env ?? process.env;
    const { data: file, file: configFile } = readConfigFile(cwd);
    const url = pick(args.url, file.url ?? file.site_url, env.X_WP_URL);
    const user = pick(args.user, file.user, env.X_WP_USER);
    const pass = pick(args.app_password, file.app_password, env.X_WP_APP_PASSWORD);
    const missing = [
        url.source === 'missing' ? 'url (X_WP_URL)' : null,
        user.source === 'missing' ? 'user (X_WP_USER)' : null,
        pass.source === 'missing' ? 'app_password (X_WP_APP_PASSWORD)' : null,
    ].filter(Boolean);
    if (missing.length) {
        throw new XError('invalid_input', `Missing connection config: ${missing.join(', ')}.`, `Pass {url, user, app_password} to wp_connect, or create ${CONFIG_FILENAME} in the working directory, or set X_WP_URL / X_WP_USER / X_WP_APP_PASSWORD.`, { missing });
    }
    const parsed = opts.allowInsecure ? new URL(url.value) : assertTransportAllowed(url.value);
    registerSecret(pass.value);
    const cfg = {
        site_url: normaliseSiteUrl(parsed),
        user: user.value,
        app_password: pass.value,
        sources: { url: url.source, user: user.source, app_password: pass.source },
    };
    if (configFile)
        cfg.config_file = configFile;
    // Image-generation pass (optional): a Gemini key in the same file/env chain.
    const gemini = pick(undefined, file.gemini_api_key, env.GEMINI_API_KEY);
    if (gemini.value) {
        registerSecret(gemini.value);
        cfg.gemini_api_key = gemini.value;
    }
    const imageModel = pick(undefined, file.image_model, env.X_AGENT_IMAGE_MODEL);
    if (imageModel.value)
        cfg.image_model = imageModel.value;
    return cfg;
}
/** Stable identity for "is this the same connection?" — never includes the password. */
export function configIdentity(cfg) {
    return `${cfg.site_url}|${cfg.user}`;
}
/** Safe-to-log view of the config. */
export function describeConfig(cfg) {
    return {
        site_url: cfg.site_url,
        user: cfg.user,
        app_password: '***',
        sources: cfg.sources,
        config_file: cfg.config_file ?? null,
    };
}
//# sourceMappingURL=config.js.map