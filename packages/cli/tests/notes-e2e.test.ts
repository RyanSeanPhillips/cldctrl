/**
 * End-to-end test for the cockpit NOTES system.
 *
 * Boots the REAL built dashboard server (`dist/index.js serve`) against an isolated
 * temp config dir (CLDCTRL_CONFIG_DIR), then drives the notes pipeline entirely over
 * HTTP — exactly as the browser does:
 *
 *   create notepad (/api/scratch keyed) → write body (/api/file) → mint extra note
 *   (/api/notes/new) → adopt an agent scratchpad (/api/notes/record) → list with
 *   scope + full-text query (/api/notes).
 *
 * It deliberately does NOT launch a Claude session / PTY (no resume), so it's safe to
 * run unattended and never opens VS Code or a browser. Run: `npm test`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(here, '../dist/index.js');

const PROJ_A = 'C:/proj/alpha';
const PROJ_B = 'C:/proj/beta';
const SESS_A = 'SESS-ALPHA-1';
const SESS_B = 'SESS-BETA-1';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

let child: ChildProcess;
let tmpDir: string;
let base: string;
let stderr = '';
// paths the seed step creates, for assertions
const P: Record<string, string> = {};

async function get(p: string): Promise<any> {
  const r = await fetch(base + p);
  return r.json();
}
async function post(p: string, body: unknown): Promise<any> {
  const r = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CLDCTRL': '1' },
    body: JSON.stringify(body),
  });
  return r.json();
}
/** notes list as a set of normalized paths, for membership assertions. */
async function listPaths(params: Record<string, string> = {}): Promise<Set<string>> {
  const qs = new URLSearchParams(params).toString();
  const j = await get('/api/notes' + (qs ? '?' + qs : ''));
  return new Set((j.notes as Array<{ path: string }>).map((n) => norm(n.path)));
}
async function listNotes(params: Record<string, string> = {}): Promise<Array<{ path: string; title: string; preview: string }>> {
  const qs = new URLSearchParams(params).toString();
  return (await get('/api/notes' + (qs ? '?' + qs : ''))).notes;
}

beforeAll(async () => {
  if (!fs.existsSync(ENTRY)) throw new Error(`Build first — missing ${ENTRY}. Run \`npm run build\`.`);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cldctrl-notes-e2e-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [ENTRY, 'serve', '--port', String(port)], {
    env: { ...process.env, CLDCTRL_CONFIG_DIR: tmpDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr?.on('data', (d) => { stderr += d.toString(); });

  // wait until the notes endpoint answers
  const deadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < deadline) {
    try { const r = await fetch(base + '/api/notes'); if (r.ok) { ready = true; break; } } catch { /* not up yet */ }
    await sleep(200);
  }
  if (!ready) throw new Error('server did not become ready\n' + stderr);

  // ── seed ────────────────────────────────────────────────────
  // P1: a conversation's docked notepad (keyed), body mentions "kangaroos"
  P.p1 = (await post('/api/scratch', { key: 'resume:' + SESS_A, project: PROJ_A, conversation: SESS_A })).path;
  await post('/api/file', { path: P.p1, content: '# Kangaroo budget\nNotes about kangaroos and quarterly finance.' });
  // P2: an additional note for the same conversation
  P.p2 = (await post('/api/notes/new', { project: PROJ_A, conversation: SESS_A, title: 'Outline' })).path;
  await post('/api/file', { path: P.p2, content: 'Outline\nIntro, body, conclusion. Platypus.' });
  // P3: a DIFFERENT project's note, body has a unique token "zzqq"
  P.p3 = (await post('/api/scratch', { key: 'resume:' + SESS_B, project: PROJ_B, conversation: SESS_B })).path;
  await post('/api/file', { path: P.p3, content: '# Beta roadmap\nUnique token zzqq for beta only.' });
  // P4: an agent scratchpad (unkeyed) later ADOPTED into conversation A via record
  P.p4 = (await post('/api/scratch', { title: 'agent draft' })).path;
  await post('/api/file', { path: P.p4, content: 'Agent draft about kangaroos too.' });
  await post('/api/notes/record', { path: P.p4, project: PROJ_A, conversation: SESS_A });
}, 60_000);

afterAll(async () => {
  try { child?.kill(); } catch { /* ignore */ }
  await sleep(150);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('cockpit notes — end to end', () => {
  it('seeded four distinct note files', () => {
    const paths = new Set(Object.values(P).map(norm));
    expect(P.p1 && P.p2 && P.p3 && P.p4).toBeTruthy();
    expect(paths.size).toBe(4);
  });

  it('a keyed notepad is stable (same key → same file)', async () => {
    const again = (await post('/api/scratch', { key: 'resume:' + SESS_A, project: PROJ_A, conversation: SESS_A })).path;
    expect(norm(again)).toBe(norm(P.p1));
  });

  it('"all" lists every note', async () => {
    const all = await listPaths();
    for (const k of ['p1', 'p2', 'p3', 'p4']) expect(all.has(norm(P[k]))).toBe(true);
    expect(all.size).toBe(4);
  });

  it('project scope returns only that project (incl. an adopted scratchpad)', async () => {
    const a = await listPaths({ project: PROJ_A });
    expect(a.has(norm(P.p1))).toBe(true);
    expect(a.has(norm(P.p2))).toBe(true);
    expect(a.has(norm(P.p4))).toBe(true); // adopted via /api/notes/record
    expect(a.has(norm(P.p3))).toBe(false); // belongs to project B
    expect(a.size).toBe(3);

    const b = await listPaths({ project: PROJ_B });
    expect(b.has(norm(P.p3))).toBe(true);
    expect(b.size).toBe(1);
  });

  it('conversation scope returns only that conversation', async () => {
    const a = await listPaths({ conversation: SESS_A });
    expect(a.has(norm(P.p1))).toBe(true);
    expect(a.has(norm(P.p2))).toBe(true);
    expect(a.has(norm(P.p4))).toBe(true);
    expect(a.has(norm(P.p3))).toBe(false);

    const b = await listPaths({ conversation: SESS_B });
    expect([...b]).toEqual([norm(P.p3)]);
  });

  it('full-text query matches note BODIES (not just titles)', async () => {
    const hits = await listPaths({ q: 'kangaroos' });
    expect(hits.has(norm(P.p1))).toBe(true); // body: "...about kangaroos and..."
    expect(hits.has(norm(P.p4))).toBe(true); // body: "...about kangaroos too."
    expect(hits.has(norm(P.p2))).toBe(false);
    expect(hits.has(norm(P.p3))).toBe(false);
    expect(hits.size).toBe(2);

    // a unique body-only token finds exactly its note
    const z = await listPaths({ q: 'zzqq' });
    expect([...z]).toEqual([norm(P.p3)]);
  });

  it('full-text query returns a snippet preview around the match', async () => {
    const [hit] = (await listNotes({ q: 'zzqq' }));
    expect(hit).toBeTruthy();
    expect(hit.preview.toLowerCase()).toContain('zzqq');
  });

  it('query AND scope combine (project filter excludes a body match in another project)', async () => {
    const none = await listPaths({ q: 'zzqq', project: PROJ_A }); // zzqq lives in project B
    expect(none.size).toBe(0);
  });

  it('title-only match still surfaces the note', async () => {
    const hits = await listPaths({ q: 'roadmap' }); // "# Beta roadmap" title/body of P3
    expect(hits.has(norm(P.p3))).toBe(true);
  });

  it('no matches → empty list (not an error)', async () => {
    const j = await get('/api/notes?q=' + encodeURIComponent('zzz-no-such-token-xyzzy'));
    expect(j.ok).toBe(true);
    expect(j.notes).toEqual([]);
  });
});
