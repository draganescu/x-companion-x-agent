// Boot holder: the boot.mjs CLI has no --slot flag, and the
// default core-only-toolchain slot may be a developer's live persistent
// instance (never touch it). This holds a programmatic boot({slot}) alive on a
// dedicated slot until killed; stop via tools/playground/stop.mjs --port.
import { boot } from '../../tools/playground/boot.mjs';

const [cmd, slot, portStr, pluginDir] = process.argv.slice(2);
if (cmd !== 'hold' || !slot || !portStr) {
    console.error('usage: node site-holder.mjs hold <slot> <port> [plugin-dir]');
    process.exit(2);
}

const env = await boot({
    profile: 'core-only',
    posture: 'toolchain',
    port: Number(portStr),
    plugins: [pluginDir || './x-companion'],
    slot,
    quiet: true,
});
console.error(`[accept] playground held on ${env.url} (slot ${slot})`);

const bail = async () => {
    try { await env.stop(); } finally { process.exit(0); }
};
process.on('SIGTERM', bail);
process.on('SIGINT', bail);
setInterval(() => {}, 60_000); // keep the event loop alive
