/**
 * proof/report-html.mjs — renders proof/results.json into a shareable HTML report.
 *
 * Reads the structured run output, never REPORT.md, so the page cannot drift from
 * what the suite actually observed. Regenerate with:  node proof/report-html.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'results.json'), 'utf8'));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const { results, totals, env } = data;
const observations = results.reduce((n, r) => n + r.steps.length, 0);
const byId = (id) => results.find((r) => r.id === id);
const numeric = [...results].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
const runOrder = results.map((r) => r.id);
const orderDiverges = runOrder.join() !== numeric.map((r) => r.id).join();
const slowest = [...results].sort((a, b) => b.ms - a.ms)[0];

const statusChip = (s) =>
  `<span class="chip chip--${s}">${s === 'pass' ? 'pass' : s === 'fail' ? 'FAIL' : 'skip'}</span>`;

const rows = (steps) => steps.map((st) => `
        <tr class="${st.ok ? '' : 'row--bad'}">
          <td class="mark" aria-hidden="true">${st.ok ? '✓' : '✗'}</td>
          <td class="what">${esc(st.what)}</td>
          <td class="val"><div class="valwrap">${esc(st.observed)}</div></td>
        </tr>`).join('');

const cards = results.map((r, i) => `
      <article class="scen" id="${r.id.toLowerCase()}">
        <header class="scen__head">
          <div class="scen__id">
            <span class="scen__num">${r.id}</span>
            <span class="scen__seq">run ${i + 1} of ${results.length}</span>
          </div>
          <div class="scen__meta">
            ${statusChip(r.status)}
            <span class="scen__inst">${esc(r.needs)}</span>
            <span class="scen__ms">${r.ms.toLocaleString()} ms</span>
          </div>
        </header>
        <h3 class="scen__title">${esc(r.title)}</h3>
        <p class="scen__proves">${esc(r.proves)}</p>
        ${r.detail ? `<pre class="detail">${esc(r.detail)}</pre>` : ''}
        <div class="tablewrap">
          <table class="obs">
            <caption class="sr-only">Observations recorded by ${r.id}</caption>
            <tbody>${rows(r.steps)}</tbody>
          </table>
        </div>
      </article>`).join('');

const indexRows = numeric.map((r) => `
          <tr>
            <td class="idx__id"><a href="#${r.id.toLowerCase()}">${r.id}</a></td>
            <td class="idx__title">${esc(r.title)}</td>
            <td class="idx__proves">${esc(r.proves)}</td>
            <td class="idx__obs">${r.steps.length}</td>
            <td>${statusChip(r.status)}</td>
          </tr>`).join('');

const html = `<title>Block Toolchain Proof Run</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Serif:wght@600;700&display=swap">
<style>
  :root {
    --paper:#FBFBFD; --surface:#FFFFFF; --sunk:#F2F3F8;
    --ink:#12141C; --slate:#5A6178; --faint:#878DA0;
    --rule:#E4E6EE; --rule-strong:#CDD1DE;
    --accent:#3858E9; --accent-soft:#EBEEFF;
    --pass:#1B7A5A; --pass-soft:#E2F3EC;
    --fail:#B3261E; --fail-soft:#FBE9E7;
    --skip:#8A6A16; --skip-soft:#F7EFD9;
    --shadow:0 1px 2px rgba(18,20,28,.05), 0 8px 24px -12px rgba(18,20,28,.18);
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --paper:#0D0F16; --surface:#151824; --sunk:#1B1F2E;
      --ink:#E7E9F2; --slate:#A2A9BE; --faint:#79809A;
      --rule:#252A3A; --rule-strong:#333A50;
      --accent:#8098FF; --accent-soft:#1C2240;
      --pass:#4CC29A; --pass-soft:#12291F;
      --fail:#F2867C; --fail-soft:#2E1614;
      --skip:#D7B25A; --skip-soft:#2A2211;
      --shadow:0 1px 2px rgba(0,0,0,.4), 0 10px 28px -14px rgba(0,0,0,.7);
    }
  }
  :root[data-theme="dark"] {
    --paper:#0D0F16; --surface:#151824; --sunk:#1B1F2E;
    --ink:#E7E9F2; --slate:#A2A9BE; --faint:#79809A;
    --rule:#252A3A; --rule-strong:#333A50;
    --accent:#8098FF; --accent-soft:#1C2240;
    --pass:#4CC29A; --pass-soft:#12291F;
    --fail:#F2867C; --fail-soft:#2E1614;
    --skip:#D7B25A; --skip-soft:#2A2211;
    --shadow:0 1px 2px rgba(0,0,0,.4), 0 10px 28px -14px rgba(0,0,0,.7);
  }

  *,*::before,*::after{box-sizing:border-box}
  body{
    margin:0; background:var(--paper); color:var(--ink);
    font-family:"IBM Plex Sans",system-ui,-apple-system,Segoe UI,sans-serif;
    font-size:16px; line-height:1.6; -webkit-font-smoothing:antialiased;
  }
  .wrap{max-width:78rem;margin:0 auto;padding:clamp(1.5rem,4vw,4rem) clamp(1rem,4vw,3rem) 6rem}
  .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
  a{color:var(--accent)}
  a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:3px}

  /* ── masthead ─────────────────────────────────────────────── */
  .eyebrow{
    font-family:"IBM Plex Mono",ui-monospace,monospace; font-size:.72rem; font-weight:500;
    letter-spacing:.16em; text-transform:uppercase; color:var(--faint); margin:0 0 1rem;
  }
  h1{
    font-family:"IBM Plex Serif",Georgia,serif; font-weight:700;
    font-size:clamp(2rem,5vw,3.1rem); line-height:1.1; letter-spacing:-.02em;
    text-wrap:balance; margin:0 0 .9rem;
  }
  .standfirst{max-width:62ch;color:var(--slate);font-size:1.06rem;margin:0 0 2.5rem}
  .standfirst strong{color:var(--ink);font-weight:600}

  .verdict{
    display:grid; grid-template-columns:repeat(auto-fit,minmax(9.5rem,1fr)); gap:1px;
    background:var(--rule); border:1px solid var(--rule); border-radius:10px;
    overflow:hidden; box-shadow:var(--shadow); margin-bottom:1rem;
  }
  .stat{background:var(--surface);padding:1.1rem 1.25rem}
  .stat__n{
    font-family:"IBM Plex Mono",ui-monospace,monospace; font-variant-numeric:tabular-nums;
    font-size:1.85rem; font-weight:600; letter-spacing:-.02em; line-height:1.1; display:block;
  }
  .stat--pass .stat__n{color:var(--pass)}
  .stat__k{
    display:block; margin-top:.35rem; font-size:.72rem; font-weight:500; letter-spacing:.1em;
    text-transform:uppercase; color:var(--faint);
  }
  .runmeta{
    display:flex; flex-wrap:wrap; gap:.4rem 1.5rem; padding:0 .15rem;
    font-family:"IBM Plex Mono",ui-monospace,monospace; font-size:.78rem; color:var(--slate);
  }
  .runmeta b{color:var(--faint);font-weight:500}

  /* ── order strip ──────────────────────────────────────────── */
  .order{margin:2.75rem 0 0;padding:1.25rem 1.4rem;background:var(--sunk);border-radius:10px;border:1px solid var(--rule)}
  .order h2{font-family:"IBM Plex Sans",sans-serif;font-size:.72rem;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);margin:0 0 .75rem}
  .seq{display:flex;flex-wrap:wrap;gap:.35rem;margin:0 0 .8rem;padding:0;list-style:none}
  .seq li{
    font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:.78rem;font-weight:500;
    padding:.2rem .5rem;border-radius:5px;background:var(--surface);border:1px solid var(--rule-strong);color:var(--slate);
  }
  .seq li.moved{border-color:var(--accent);color:var(--accent);background:var(--accent-soft)}
  .order p{margin:0;font-size:.9rem;color:var(--slate);max-width:70ch}

  /* ── index ────────────────────────────────────────────────── */
  h2.section{
    font-family:"IBM Plex Serif",Georgia,serif;font-size:1.5rem;font-weight:600;
    letter-spacing:-.01em;margin:3.5rem 0 1.1rem;
  }
  .tablewrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
  table{border-collapse:collapse;width:100%;font-size:.9rem}
  .idx{background:var(--surface);border:1px solid var(--rule);border-radius:10px;overflow:hidden;box-shadow:var(--shadow)}
  .idx th{
    text-align:left;font-size:.68rem;font-weight:600;letter-spacing:.1em;text-transform:uppercase;
    color:var(--faint);padding:.75rem 1rem;border-bottom:1px solid var(--rule);white-space:nowrap;
  }
  .idx td{padding:.7rem 1rem;border-bottom:1px solid var(--rule);vertical-align:top}
  .idx tr:last-child td{border-bottom:0}
  .idx__id a{font-family:"IBM Plex Mono",ui-monospace,monospace;font-weight:600;text-decoration:none}
  .idx__title{font-weight:500;min-width:15rem}
  .idx__proves{color:var(--slate);min-width:24rem}
  .idx__obs{font-family:"IBM Plex Mono",ui-monospace,monospace;font-variant-numeric:tabular-nums;color:var(--faint);text-align:right}

  .chip{
    display:inline-block;font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:.68rem;
    font-weight:600;letter-spacing:.06em;padding:.16rem .45rem;border-radius:4px;white-space:nowrap;
  }
  .chip--pass{color:var(--pass);background:var(--pass-soft)}
  .chip--fail{color:var(--fail);background:var(--fail-soft)}
  .chip--skip{color:var(--skip);background:var(--skip-soft)}

  /* ── scenario cards ───────────────────────────────────────── */
  .scen{
    background:var(--surface);border:1px solid var(--rule);border-radius:10px;
    padding:1.4rem 1.5rem 1.1rem;margin:1rem 0;box-shadow:var(--shadow);scroll-margin-top:1.5rem;
  }
  .scen__head{display:flex;flex-wrap:wrap;gap:.75rem;align-items:baseline;justify-content:space-between;margin-bottom:.55rem}
  .scen__id{display:flex;gap:.7rem;align-items:baseline}
  .scen__num{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:1rem;font-weight:600;color:var(--accent)}
  .scen__seq,.scen__inst,.scen__ms{
    font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:.72rem;color:var(--faint);
    font-variant-numeric:tabular-nums;
  }
  .scen__meta{display:flex;gap:.85rem;align-items:baseline}
  .scen__title{font-family:"IBM Plex Serif",Georgia,serif;font-size:1.22rem;font-weight:600;margin:0 0 .35rem;letter-spacing:-.01em;text-wrap:balance}
  .scen__proves{margin:0 0 1rem;color:var(--slate);font-size:.94rem;max-width:78ch}
  .detail{
    background:var(--fail-soft);color:var(--fail);border-radius:6px;padding:.8rem 1rem;
    font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:.8rem;overflow-x:auto;margin:0 0 1rem;
  }

  .obs{font-size:.84rem}
  .obs td{padding:.4rem .7rem;border-top:1px solid var(--rule);vertical-align:top}
  .obs tr:first-child td{border-top:0}
  .mark{width:1.4rem;color:var(--pass);font-weight:600;text-align:center}
  .row--bad .mark{color:var(--fail)}
  .what{color:var(--slate);min-width:16rem}
  .val{font-family:"IBM Plex Mono",ui-monospace,monospace;color:var(--ink);font-size:.8rem}
  .valwrap{max-height:11rem;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;max-width:46rem}

  footer{margin-top:4rem;padding-top:1.5rem;border-top:1px solid var(--rule);color:var(--faint);font-size:.85rem}
  footer code{font-family:"IBM Plex Mono",ui-monospace,monospace;color:var(--slate)}
  @media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
  @media (max-width:640px){ .what{min-width:9rem} .idx__proves{min-width:16rem} }
</style>

<div class="wrap">
  <p class="eyebrow">x-companion &nbsp;·&nbsp; x-agent &nbsp;·&nbsp; interop verification</p>
  <h1>Do the two plugins actually work together?</h1>
  <p class="standfirst">
    Every row on this page was produced by running <strong>x-companion</strong> and <strong>x-agent</strong>
    against each other on a real WordPress instance — a live Playground sandbox, the real MCP tool
    entrypoint, and a real browser compiling block trees through the instance's own
    <code>save()</code> functions. Nothing here is mocked, and nothing is asserted without a recorded value.
  </p>

  <div class="verdict">
    <div class="stat stat--pass"><span class="stat__n">${totals.pass}/${totals.total}</span><span class="stat__k">scenarios pass</span></div>
    <div class="stat"><span class="stat__n">${observations}</span><span class="stat__k">observations</span></div>
    <div class="stat"><span class="stat__n">${totals.fail}</span><span class="stat__k">failed</span></div>
    <div class="stat"><span class="stat__n">${totals.skip}</span><span class="stat__k">skipped</span></div>
    <div class="stat"><span class="stat__n">${esc(env.duration)}</span><span class="stat__k">wall clock</span></div>
  </div>
  <div class="runmeta">
    <span><b>wordpress</b> ${esc(env.WordPress)}</span>
    <span><b>instances</b> ${esc(env.instances)}</span>
    <span><b>generated</b> ${esc(env.generated)}</span>
    <span><b>command</b> bash proof/run-all.sh</span>
  </div>

  <section class="order">
    <h2>Execution order</h2>
    <ul class="seq">${runOrder.map((id) => `<li class="${id === 'P10' ? 'moved' : ''}">${id}</li>`).join('')}</ul>
    <p>
      ${orderDiverges
        ? `Order is deliberately not numeric. <strong>P10</strong> writes design tokens, which rewrites the
           site's global styles — and P9 and P15 measure geometry and computed colour against specs captured
           from the untouched theme. Both passed alone and failed in sequence before this was pinned, so P10
           runs last and the reasoning lives in <code>proof/scenarios.ts</code> rather than in someone's memory.`
        : `Scenarios run in numeric order.`}
    </p>
  </section>

  <h2 class="section">The scenarios</h2>
  <div class="tablewrap">
    <table class="idx">
      <thead><tr><th>id</th><th>scenario</th><th>what it proves</th><th>obs</th><th>status</th></tr></thead>
      <tbody>${indexRows}</tbody>
    </table>
  </div>

  <h2 class="section">Recorded observations</h2>
  ${cards}

  <footer>
    <p>
      Regenerate with <code>bash proof/run-all.sh</code>, then <code>node proof/report-html.mjs</code>.
      This page is rendered from <code>proof/results.json</code> — the suite's structured output — so it
      cannot drift from what was actually observed. Slowest scenario this run:
      <code>${slowest.id}</code> at ${slowest.ms.toLocaleString()} ms.
    </p>
  </footer>
</div>
`;

const out = path.join(__dirname, 'report.html');
fs.writeFileSync(out, html);
console.log(`wrote ${path.relative(process.cwd(), out)}  (${(html.length / 1024).toFixed(1)} KB, ${results.length} scenarios, ${observations} observations)`);
