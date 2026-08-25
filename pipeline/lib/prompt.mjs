// Interactive terminal prompts for the CLI. Non-TTY sessions (CI, agents)
// must pass flags instead — prompting into a pipe is a hang, not a question.
import readline from 'node:readline';
import { PipelineError } from './errors.mjs';

function assertTty(what) {
    if (!process.stdin.isTTY) {
        throw new PipelineError('preflight_failed', `"${what}" needs an interactive terminal`,
            'Pass the value as a flag instead (see --help).');
    }
}

export function ask(question, { fallback } = {}) {
    assertTty(question);
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(fallback ? `${question} [${fallback}]: ` : `${question}: `, (answer) => {
            rl.close();
            resolve(answer.trim() || fallback || '');
        });
    });
}

export function askHidden(question) {
    assertTty(question);
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        process.stdout.write(`${question}: `);
        rl._writeToOutput = function writeMuted(s) {
            if (s.includes('\n')) this.output.write('\n');
            else this.output.write('*');
        };
        rl.question('', (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}
