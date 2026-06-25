// E2E: CodexSource — verify Codex CLI sessions are indexed into the unified
// conversation search (search_conversations spans Claude + Codex).
import { spawn } from 'node:child_process';

const PORT = 2622;
const srv = spawn(process.execPath, ['dist/index.js', 'serve', '--port', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));

async function search(q) {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/search?q=${encodeURIComponent(q)}`, { headers: { 'X-CLDCTRL': '1' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return (await r.json()).results || [];
}

const ok = (b) => (b ? 'PASS' : 'FAIL');
const results = {};
try {
  // First call also triggers index build (Codex rollouts parsed). Give a beat, retry.
  let all = [];
  for (const q of ['session_index', 'biometrics', 'rollout', 'cldctrl', 'codex']) {
    const r = await search(q);
    all.push(...r);
  }
  const byVendor = {};
  for (const r of all) byVendor[r.vendor] = (byVendor[r.vendor] || 0) + 1;
  const codexHits = all.filter((r) => r.vendor === 'codex');
  const claudeHits = all.filter((r) => r.vendor === 'claude');

  results['search returns results'] = all.length > 0;
  results['results carry a vendor field'] = all.every((r) => r.vendor === 'codex' || r.vendor === 'claude');
  results['Codex sessions are indexed (vendor=codex present)'] = codexHits.length > 0;
  results['Claude sessions still indexed (vendor=claude present)'] = claudeHits.length > 0;
  // a codex hit should resolve a project from its cwd + carry a real sessionId + snippet
  const c = codexHits[0];
  if (c) {
    results['codex hit has sessionId'] = /^[0-9a-f-]{30,}$/i.test(c.sessionId);
    results['codex hit has a snippet'] = typeof c.snippet === 'string' && c.snippet.length > 0;
    results['codex hit has a project/path'] = !!(c.projectPath || c.project);
  }
  console.log('vendor histogram across queries:', JSON.stringify(byVendor));
  console.log('sample codex hit:', c ? JSON.stringify({ vendor: c.vendor, sessionId: c.sessionId, project: c.project, projectPath: c.projectPath, date: c.date, snippet: c.snippet.slice(0, 80) }, null, 0) : '(none)');
} catch (err) {
  console.log('ERROR:', String(err));
}

console.log('\n=== RESULTS ===');
for (const [k, v] of Object.entries(results)) console.log(ok(v).padEnd(5), k);
srv.kill();
