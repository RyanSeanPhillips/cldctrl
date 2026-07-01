// E2E: `cc serve --demo` must (a) serve synthetic data and (b) be INERT against
// the real machine — every launch/file/notes/etc endpoint stubbed, no real data.
import { spawn } from 'node:child_process';
const PORT = 2633;
const srv = spawn(process.execPath, ['dist/index.js', 'serve', '--port', String(PORT), '--demo'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const base = 'http://127.0.0.1:' + PORT;
const H = { 'x-cldctrl': '1', 'content-type': 'application/json' };
const ok = (b) => (b ? 'PASS' : 'FAIL'); const R = {};
const get = async (p) => (await fetch(base + p)).json().catch(() => ({}));
const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(body || {}) })).json().catch(() => ({}));
try {
  // (a) Synthetic reads.
  const ov = await get('/api/overview');
  R['overview: synthetic OSS projects'] = Array.isArray(ov.projects) && ov.projects.some((p) => p.name === 'next.js') && ov.projects.some((p) => p.name === 'pytorch');
  R['overview: multi-vendor sessions'] = Array.isArray(ov.sessions) && new Set(ov.sessions.map((s) => s.vendor)).size >= 2;
  const st = await get('/api/stats?days=7');
  R['stats: populated (totalTokens>0, turns, consults)'] = st.totalTokens > 0 && Array.isArray(st.turns) && st.turns.length > 0 && st.consults && st.consults.codex > 0;
  const se = await get('/api/search?q=streaming');
  R['search: cross-vendor synthetic results'] = Array.isArray(se.results) && se.results.some((r) => r.vendor === 'codex') && se.results.some((r) => r.vendor === 'claude');

  // (b) Machine endpoints INERT — must NOT act, must NOT return real data.
  const launch = await post('/api/launch', { path: 'C:/Windows', prompt: 'x' });
  R['launch: disabled (no real launch)'] = launch.disabled === true && !launch.success;
  const file = await get('/api/file?path=' + encodeURIComponent('C:/Windows/win.ini'));
  R['file GET: inert (no real file content)'] = file.disabled === true && file.content === undefined;
  const reveal = await post('/api/reveal', { path: 'C:/Windows' });
  R['reveal: disabled'] = reveal.disabled === true;
  const proj = await get('/api/project/sessions?path=' + encodeURIComponent('C:/Users'));
  R['project detail: empty (no real sessions)'] = Array.isArray(proj.sessions) && proj.sessions.length === 0;
} catch (e) { console.log('ERR', String(e)); R['threw'] = false; }
console.log('\n=== RESULTS ===');
for (const [k, v] of Object.entries(R)) console.log(ok(v).padEnd(5), k);
srv.kill();
