/**
 * Privacy guard for the crash-telemetry scrubber. These assert the ONE property
 * that matters: nothing identifying (home path, username, project/dir names,
 * data-file names, secret tokens) can survive into a beacon payload. If this
 * ever fails, the fix is the scrubber — do NOT relax the test.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { __scrubForTest as scrub, reportError, setErrorReportingEnabled, __resetForTest } from '../src/core/error-report.js';

beforeEach(() => __resetForTest());

describe('scrub() — free-text / message mode (keepBasename=false)', () => {
  const msgScrub = (s: string) => scrub(s, false);

  it('collapses a Windows absolute path to <path> (no dirs, no basename)', () => {
    const out = msgScrub(String.raw`open 'C:\Users\alice\Dropbox\Taxes\ssn-2025.pdf'`);
    expect(out).not.toMatch(/alice|Dropbox|Taxes|ssn-2025/);
    expect(out).toMatch(/<path>|<redacted>/); // collapsed, then quote-redacted
  });

  it('collapses an UNQUOTED absolute path to <path>', () => {
    const out = msgScrub(String.raw`spawn C:\Users\alice\Dropbox\Taxes\ssn-2025.pdf ENOENT`);
    expect(out).not.toMatch(/alice|Dropbox|Taxes|ssn-2025/);
    expect(out).toContain('<path>');
  });

  it('collapses POSIX + /home + /Users paths', () => {
    expect(msgScrub('/home/bob/app/private/keys.json')).not.toMatch(/bob|private|keys/);
    expect(msgScrub('/Users/carol/work/report.docx')).not.toMatch(/carol|report/);
  });

  it('strips secret-like tokens and long hex', () => {
    expect(msgScrub('auth sk-ant-abc123DEF456 failed')).toContain('<token>');
    expect(msgScrub('etag deadbeefdeadbeefdeadbeef0000')).toContain('<hex>');
  });

  it('redacts JWTs, emails, AWS keys, github/openai tokens', () => {
    expect(msgScrub('tok eyJhbGciOi.eyJlbWFpbCI6.sig')).toContain('<jwt>');
    expect(msgScrub('login failed for alice@example.com')).not.toContain('alice@example.com');
    expect(msgScrub('key AKIAIOSFODNN7EXAMPLE')).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(msgScrub('token ghp_16CharsOfSecretHere00')).toContain('<token>');
  });

  it('redacts key=value secrets and hostnames/IPs', () => {
    expect(msgScrub('connection: password=hunter2 db=AcmePayroll')).not.toMatch(/hunter2/);
    expect(msgScrub('connect ETIMEDOUT db-prod.corp.internal:5432')).not.toContain('db-prod.corp.internal');
    expect(msgScrub('refused 10.1.2.3:8080')).toContain('<ip>');
  });

  it('redacts any remaining quoted substring', () => {
    expect(msgScrub(`Cannot find module 'my-secret-plugin'`)).not.toContain('my-secret-plugin');
  });
});

describe('reportError() — hardening from adversarial review', () => {
  const cap = async (mutate: (e: Error) => void) => {
    const https = await import('node:https');
    let body = '';
    const orig = https.default.request;
    // @ts-expect-error stub
    https.default.request = () => ({ on() { return this; }, write(b: string) { body += b; }, end() {}, destroy() {} });
    delete process.env.DO_NOT_TRACK; delete process.env.CLDCTRL_NO_TELEMETRY;
    setErrorReportingEnabled(true);
    const e = new Error('boom'); mutate(e);
    reportError(e, 'cli', 'test');
    // @ts-expect-error restore
    https.default.request = orig;
    return body;
  };

  it('allowlists a hostile Error.name (no secret in name/label)', async () => {
    const body = await cap((e) => {
      e.name = 'AliceApiKey sk-live-secret123456';
      e.stack = 'x\n    at run (node:internal/process/task_queues:95:5)';
    });
    expect(body).not.toContain('sk-live-secret123456');
    expect(body).toContain('"err_name":"Error"');
  });

  it('treats a NON-app stack frame as <ext> (no user data-file name)', async () => {
    const body = await cap((e) => {
      e.name = 'Error';
      e.stack = [
        'Error: boom',
        '    at load (//corp-fs/finance/acquisition-plan.xlsx:9:1)',
        '    at read (file:///C:/Users/alice/Secret/passwords.kdbx:4:2)',
        '    at C:/Users/alice/Secret/customer-list.js:12:3',
      ].join('\n');
    });
    expect(body).not.toMatch(/acquisition-plan|passwords|customer-list|alice|Secret|corp-fs/);
    expect(body).toContain('<ext>');
  });

  it('drops the function name on an external frame (round-2 leak)', async () => {
    const body = await cap((e) => {
      e.name = 'Error';
      e.stack = 'Error: boom\n    at AcmePayrollImporter.load (C:/Users/alice/SecretProject/customer-list.js:12:3)';
    });
    expect(body).not.toMatch(/AcmePayrollImporter|SecretProject|customer-list|alice/);
  });

  it('collapses a custom Error.name to a known name (round-2 leak)', async () => {
    const body = await cap((e) => { e.name = 'AcmePayrollError'; });
    expect(body).not.toContain('AcmePayroll');
    expect(body).toContain('"err_name":"Error"');
  });

  it('clamps a hostile err_kind to the fixed vocabulary', async () => {
    const https = await import('node:https');
    let body = '';
    const orig = https.default.request;
    // @ts-expect-error stub
    https.default.request = () => ({ on() { return this; }, write(b: string) { body += b; }, end() {}, destroy() {} });
    setErrorReportingEnabled(true);
    // @ts-expect-error hostile kind
    reportError(new Error('x'), 'cli', 'password=hunter2 tenant=Acme');
    // @ts-expect-error restore
    https.default.request = orig;
    expect(body).not.toMatch(/hunter2|Acme/);
    expect(body).toContain('"err_kind":"uncaught"');
  });

  it('captures a clean err_code from a real ENOENT', async () => {
    const body = await cap(() => {}); // real ENOENT case is covered above; here just assert field presence
    void body;
    const https = await import('node:https');
    let out = '';
    const orig = https.default.request;
    // @ts-expect-error stub
    https.default.request = () => ({ on() { return this; }, write(b: string) { out += b; }, end() {}, destroy() {} });
    setErrorReportingEnabled(true);
    const e = new Error('read fail') as NodeJS.ErrnoException; e.code = 'ENOENT';
    reportError(e, 'cli', 'test');
    // @ts-expect-error restore
    https.default.request = orig;
    expect(out).toContain('"err_code":"ENOENT"');
  });
});

describe('scrub() — stack mode (keepBasename=true)', () => {
  it('keeps the source basename but never the directory/user', () => {
    const out = scrub(String.raw`at fn (C:\Users\alice\proj\packages\cli\src\core\git.ts:12:3)`, true);
    expect(out).toContain('git.ts');
    expect(out).not.toMatch(/alice|proj|packages|Users/);
  });
});

describe('reportError() — end-to-end payload on a REAL OS error', () => {
  it('emits no PII for a genuine ENOENT under the home dir', async () => {
    // Force-enable so the assertion isn't vacuously satisfied by a dev's own
    // opt-out or a DO_NOT_TRACK env var in the test shell.
    delete process.env.DO_NOT_TRACK;
    delete process.env.CLDCTRL_NO_TELEMETRY;
    setErrorReportingEnabled(true);
    // Intercept the beacon so nothing hits the network; capture the body.
    const https = await import('node:https');
    let body = '';
    const orig = https.default.request;
    // @ts-expect-error test stub
    https.default.request = () => ({ on() { return this; }, write(b: string) { body += b; }, end() {}, destroy() {} });

    const secret = path.join(os.homedir(), 'Dropbox', 'MyClient-Acme', 'passwords.kdbx');
    let err: unknown;
    try { fs.readFileSync(secret); } catch (e) { err = e; }
    reportError(err, 'tui', 'test');

    // @ts-expect-error restore
    https.default.request = orig;

    const user = os.userInfo().username;
    for (const needle of [user, 'Dropbox', 'MyClient-Acme', 'passwords', os.homedir()]) {
      expect(body, `leaked "${needle}"`).not.toContain(needle);
    }
    // Still carries the useful, non-identifying signal.
    expect(body).toContain('"err_name":"Error"');
    expect(body).toContain('ENOENT');
  });
});
