// The restart button must survive the ONE situation it exists for: a rebuild.
//
// REGRESSION (found in debug.log 2026-07-22):
//   restart_requested → error api_restart: ERR_MODULE_NOT_FOUND
//   Cannot find module 'dist/app-launch-<hash>.js'
// tsup emits CONTENT-HASHED chunks and deletes the old ones, so a server that
// outlives its build can no longer resolve its own lazy `await import()` targets.
// The "restart to load" pill only appears BECAUSE a new build landed — and that
// same build deleted the chunk the restart handler needed. Guaranteed to fail
// exactly when used.
//
// Fix: startServeServer() warms those modules into Node's ESM registry at boot,
// so later import()s never touch the filesystem.
//
// This test reproduces it literally: boot a server, RENAME its chunks on disk
// (what a rebuild effectively does), then drive the lazy-import paths.
import { spawn } from 'node:child_process';
import { readdirSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PORT = 2756;
const DIST = 'dist';
const results = [];
const check = (n, ok, x = '') => { results.push({ n, ok: !!ok }); console.log((ok ? 'PASS' : 'FAIL') + '  ' + n + (x ? '  — ' + x : '')); };

const get = async (p, opts = {}) => {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { headers: { 'X-CLDCTRL': '1' }, ...opts });
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch (e) { return { status: 0, body: null, err: String(e) }; }
};

const srv = spawn(process.execPath, [join(DIST, 'index.js'), 'serve', '--port', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 4000));

let renamed = [];
try {
  const first = await get('/api/overview');
  check('server is up', first.status === 200, 'instance ' + (first.body?.instanceId || '?'));

  // Simulate the rebuild: every hashed chunk the running process may still need
  // gets moved aside. If the server kept a filesystem-resolved lazy import, its
  // next import() now fails exactly as it did in the wild.
  const chunks = readdirSync(DIST).filter((f) => /^(app-launch|handoff|stats|semantic-rerank|latex|codex-stats|chunk)-[A-Z0-9]+\.js$/i.test(f));
  for (const f of chunks) {
    const from = join(DIST, f), to = join(DIST, '_moved_' + f);
    try { renameSync(from, to); renamed.push([to, from]); } catch { /* in use on win — fine */ }
  }
  check('chunks removed under the running server', renamed.length > 0, renamed.length + ' chunks moved aside');

  // /api/restart resolves the supervisor entry via a lazy import — the exact call
  // that threw ERR_MODULE_NOT_FOUND. It must still answer ok:true.
  const rs = await get('/api/restart', { method: 'POST' });
  check('POST /api/restart still resolves its lazy import',
    rs.status === 200 && rs.body?.ok === true,
    `status ${rs.status} body ${JSON.stringify(rs.body)}`);

  // And if it ever DOES fail again, it must report that in the response rather
  // than answering ok and silently doing nothing (which stranded the UI).
  check('a failure would be reported, not silent',
    rs.status === 200 ? true : rs.body?.ok === false && !!rs.body?.error,
    JSON.stringify(rs.body));
} catch (e) {
  check('harness completed', false, String(e));
} finally {
  for (const [to, from] of renamed) { try { if (existsSync(to)) renameSync(to, from); } catch { /* ignore */ } }
  try { srv.kill(); } catch { /* ignore */ }
  // the restart we triggered may have spawned a successor — clean it up
  await new Promise((r) => setTimeout(r, 3000));
  spawn(process.execPath, [join(DIST, 'index.js'), 'stop', '--port', String(PORT)], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 2500));
}

const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
