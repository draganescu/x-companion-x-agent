// The same core-REST lane the tools already use: a thin wrapper over
// tools/lib/rest-client.mjs (pretty/plain permalink fallback, Basic auth).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '../../tools/lib/rest-client.mjs';
import { PipelineError } from './errors.mjs';

export function readConnection(cwd, env = process.env) {
    let file = {};
    try {
        file = JSON.parse(readFileSync(join(cwd, '.x-agent.json'), 'utf8'));
    } catch {
        // env may carry the connection
    }
    const url = file.url ?? file.site_url ?? env.X_WP_URL;
    const user = file.user ?? env.X_WP_USER;
    const app_password = file.app_password ?? env.X_WP_APP_PASSWORD;
    if (!url || !user || !app_password) {
        throw new PipelineError('preflight_failed', 'no connection config for the core-REST lane',
            'Provide url/user/app_password via .x-agent.json or X_WP_* env vars.');
    }
    return { url, user, app_password };
}

export function createRest({ url, user, app_password }) {
    const client = createClient({ url, user, password: app_password });
    return async function rest(method, route, opts = {}) {
        const res = await client.call(method, route, opts);
        if (res.status >= 400) {
            throw new PipelineError('companion_error', `${method} ${route} -> ${res.status}`,
                (res.text ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').slice(0, 300));
        }
        return res.json ?? res.text;
    };
}
