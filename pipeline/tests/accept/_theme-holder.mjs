// Boots a dedicated companion Playground for a theme-factory accept script and
// stays alive until killed. Usage: node _theme-holder.mjs <slot> <port>
// Writes tools/.runtime/<slot>.json; the caller traps and runs stop.mjs --port.
// Dedicated slots + ports ONLY: the default core-only-toolchain slot belongs to
// the owner's persistent instance and is never reused or stopped.
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const [slot, port] = [process.argv[2], Number(process.argv[3])];
if (!slot || !port) {
    console.error('usage: node _theme-holder.mjs <slot> <port>');
    process.exit(2);
}

const { boot } = await import(join(repo, 'tools', 'playground', 'boot.mjs'));
const inst = await boot({
    profile: 'core-only',
    posture: 'toolchain',
    port,
    slot,
    plugins: [join(repo, 'x-companion')],
    quiet: true,
});
console.log('READY', inst.url);
setInterval(() => {}, 60000);
