/**
 * Automated test for diffRenderer core logic.
 * Tests frame extraction, ANSI stripping, line splitting, and diffing.
 * Run: node test-renderer.mjs
 */

// ── Replicate the core functions from diffRenderer.ts ─────

const STRIP_PATTERNS = [
  /\x1b\[[\d;]*[Hf]/g,    // cursor positioning (CUP/HVP)
  /\x1b\[\d*J/g,           // clear screen / scrollback
  /\x1b\[2K/g,             // erase entire line
  /\x1b\[\d*[ABCD]/g,      // cursor up/down/forward/backward
  /\x1b\[\d*G/g,           // cursor to column
  /\x1b\[\?25[lh]/g,       // cursor show/hide
  /\x1b\[\?\d+[hl]/g,      // private mode set/reset (DEC modes)
];

function stripControlSequences(str) {
  let result = str;
  for (const pattern of STRIP_PATTERNS) {
    result = result.replace(pattern, '');
  }
  return result;
}

function extractLastFrame(raw) {
  let frameStart = 0;

  const clearIdx = raw.lastIndexOf('\x1b[2J');
  if (clearIdx >= 0) {
    const homeIdx = raw.indexOf('\x1b[H', clearIdx);
    if (homeIdx >= 0) {
      frameStart = Math.max(frameStart, homeIdx + 3);
    }
  }

  const colOneIdx = raw.lastIndexOf('\x1b[G');
  if (colOneIdx >= 0) {
    frameStart = Math.max(frameStart, colOneIdx + 3);
  }

  return raw.substring(frameStart);
}

function processBuffer(raw, maxRows) {
  let frame = extractLastFrame(raw);
  frame = stripControlSequences(frame);

  const allLines = frame.split('\n');
  if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
    allLines.pop();
  }

  const lines = allLines.slice(0, maxRows);
  while (lines.length < maxRows) lines.push('');

  return lines;
}

function buildDiffOutput(newLines, prevLines, maxRows) {
  const out = [];
  let changes = 0;
  for (let i = 0; i < maxRows; i++) {
    if (newLines[i] !== (prevLines[i] ?? '')) {
      out.push(`\x1b[${i + 1};1H\x1b[0m\x1b[2K${newLines[i]}\x1b[0m`);
      changes++;
    }
  }
  return { out, changes };
}

// ── Test framework ────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.log(`  FAIL: ${msg}`);
  }
}

function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    console.log(`  FAIL: ${msg}`);
    console.log(`    expected: ${e}`);
    console.log(`    actual:   ${a}`);
  }
}

// ══════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════

console.log('Testing stripControlSequences...');

assert(stripControlSequences('\x1b[H') === '', 'cursor home');
assert(stripControlSequences('\x1b[5;1H') === '', 'cursor position');
assert(stripControlSequences('\x1b[2J') === '', 'clear screen');
assert(stripControlSequences('\x1b[3J') === '', 'clear scrollback');
assert(stripControlSequences('\x1b[2K') === '', 'erase line');
assert(stripControlSequences('\x1b[1A') === '', 'cursor up');
assert(stripControlSequences('\x1b[A') === '', 'cursor up (no param)');
assert(stripControlSequences('\x1b[G') === '', 'cursor to col 1');
assert(stripControlSequences('\x1b[5G') === '', 'cursor to col 5');
assert(stripControlSequences('\x1b[?25l') === '', 'cursor hide');
assert(stripControlSequences('\x1b[?25h') === '', 'cursor show');
assert(stripControlSequences('\x1b[?2026h') === '', 'DEC 2026 begin');
assert(stripControlSequences('\x1b[?2026l') === '', 'DEC 2026 end');
assert(stripControlSequences('\x1b[?1049h') === '', 'alt screen enter');
assert(stripControlSequences('\x1b[?1049l') === '', 'alt screen exit');

// SGR codes MUST be preserved
assert(stripControlSequences('\x1b[0m') === '\x1b[0m', 'SGR reset preserved');
assert(stripControlSequences('\x1b[1m') === '\x1b[1m', 'SGR bold preserved');
assert(stripControlSequences('\x1b[38;2;204;204;204m') === '\x1b[38;2;204;204;204m', 'SGR rgb fg preserved');
assert(stripControlSequences('\x1b[48;2;35;95;40m') === '\x1b[48;2;35;95;40m', 'SGR rgb bg preserved');
assert(stripControlSequences('\x1b[39m') === '\x1b[39m', 'SGR default fg preserved');
assert(stripControlSequences('\x1b[49m') === '\x1b[49m', 'SGR default bg preserved');

// Mixed control + SGR
assertEq(
  stripControlSequences('\x1b[HHello\x1b[38;2;255;0;0mWorld\x1b[0m'),
  'Hello\x1b[38;2;255;0;0mWorld\x1b[0m',
  'mixed: control stripped, SGR preserved'
);

// Full erase line preamble
assertEq(
  stripControlSequences('\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\x1b[G'),
  '',
  'full erase preamble stripped completely'
);

// Overflow prefix
assertEq(
  stripControlSequences('\x1b[2J\x1b[3J\x1b[H'),
  '',
  'overflow prefix stripped completely'
);

console.log('Testing extractLastFrame...');

// Simple overflow
assertEq(
  extractLastFrame('\x1b[2J\x1b[3J\x1b[HHello\nWorld\n'),
  'Hello\nWorld\n',
  'overflow: content extracted'
);

// Simple non-overflow (log-update)
assertEq(
  extractLastFrame('\x1b[2K\x1b[1A\x1b[2K\x1b[GHello\nWorld\n'),
  'Hello\nWorld\n',
  'non-overflow: content extracted after \\x1b[G'
);

// No frame boundary (first render)
assertEq(
  extractLastFrame('Hello\nWorld\n'),
  'Hello\nWorld\n',
  'no boundary: entire buffer used'
);

// Two overflow frames — take the latest
{
  const f1 = '\x1b[2J\x1b[3J\x1b[HFrame1\nLine2\n';
  const f2 = '\x1b[2J\x1b[3J\x1b[HFrame2\nLine2b\n';
  assertEq(
    extractLastFrame(f1 + f2),
    'Frame2\nLine2b\n',
    'two overflow frames: latest extracted'
  );
}

// Overflow then non-overflow
{
  const f1 = '\x1b[2J\x1b[3J\x1b[HFrame1\nLine2\n';
  const f2 = '\x1b[2K\x1b[1A\x1b[2K\x1b[GFrame2\nLine2b\n';
  assertEq(
    extractLastFrame(f1 + f2),
    'Frame2\nLine2b\n',
    'overflow then non-overflow: latest (non-overflow) extracted'
  );
}

// Non-overflow then overflow
{
  const f1 = '\x1b[2K\x1b[1A\x1b[2K\x1b[GFrame1\nLine2\n';
  const f2 = '\x1b[2J\x1b[3J\x1b[HFrame2\nLine2b\n';
  assertEq(
    extractLastFrame(f1 + f2),
    'Frame2\nLine2b\n',
    'non-overflow then overflow: latest (overflow) extracted'
  );
}

// Erase-only write (log.clear() — no content after \x1b[G)
assertEq(
  extractLastFrame('\x1b[2K\x1b[1A\x1b[2K\x1b[G'),
  '',
  'erase-only: empty content after \\x1b[G'
);

// Erase + content in same buffer (log.clear then log.render)
// log.clear: \x1b[2K\x1b[1A\x1b[2K\x1b[G
// log.render (after clear, previousLineCount=0): just content\n (no erase prefix)
{
  const erase = '\x1b[2K\x1b[1A\x1b[2K\x1b[G';
  const content = 'Line1\nLine2\nLine3\n';
  assertEq(
    extractLastFrame(erase + content),
    content,
    'erase + content buffer: content extracted'
  );
}

console.log('Testing processBuffer (full pipeline)...');

// Simple content (no frame boundary)
{
  const lines = processBuffer('Line1\nLine2\nLine3\n', 5);
  assertEq(lines, ['Line1', 'Line2', 'Line3', '', ''], 'simple: 3 lines padded to 5');
}

// Overflow frame with SGR
{
  const raw = '\x1b[2J\x1b[3J\x1b[H\x1b[38;2;204;204;204mProject\x1b[39m\n\x1b[1mBold\x1b[0m\n';
  const lines = processBuffer(raw, 4);
  assertEq(lines[0], '\x1b[38;2;204;204;204mProject\x1b[39m', 'overflow SGR: line 0 preserved');
  assertEq(lines[1], '\x1b[1mBold\x1b[0m', 'overflow SGR: line 1 preserved');
  assertEq(lines[2], '', 'overflow SGR: line 2 empty');
  assertEq(lines[3], '', 'overflow SGR: line 3 empty');
}

// Non-overflow frame with embedded cursor positioning (shouldn't be there but testing)
{
  const raw = '\x1b[2K\x1b[1A\x1b[2K\x1b[G\x1b[?25lLine1\x1b[0m\nLine2\n';
  const lines = processBuffer(raw, 3);
  assertEq(lines[0], 'Line1\x1b[0m', 'non-overflow: cursor hide stripped from content');
  assertEq(lines[1], 'Line2', 'non-overflow: line 2 correct');
}

// Multiple frames — only latest matters
{
  const f1 = '\x1b[2J\x1b[3J\x1b[HOld\nOld2\n';
  const f2 = '\x1b[2K\x1b[1A\x1b[2K\x1b[GNew\nNew2\n';
  const lines = processBuffer(f1 + f2, 3);
  assertEq(lines[0], 'New', 'multi-frame: line 0 from latest');
  assertEq(lines[1], 'New2', 'multi-frame: line 1 from latest');
}

// Truncation to maxRows
{
  const content = Array.from({length: 40}, (_, i) => `Line${i}`).join('\n') + '\n';
  const raw = '\x1b[2J\x1b[3J\x1b[H' + content;
  const lines = processBuffer(raw, 10);
  assertEq(lines.length, 10, 'truncation: exactly maxRows lines');
  assertEq(lines[0], 'Line0', 'truncation: first line correct');
  assertEq(lines[9], 'Line9', 'truncation: last visible line correct');
}

// Empty buffer
{
  const lines = processBuffer('', 3);
  assertEq(lines, ['', '', ''], 'empty: all empty');
}

// Control-only (no content)
{
  const lines = processBuffer('\x1b[2K\x1b[1A\x1b[2K\x1b[G', 3);
  assertEq(lines, ['', '', ''], 'control-only: all empty');
}

console.log('Testing buildDiffOutput...');

// First render: all lines changed
{
  const newLines = ['A', 'B', 'C'];
  const prevLines = ['', '', ''];
  const { changes } = buildDiffOutput(newLines, prevLines, 3);
  assertEq(changes, 3, 'first render: all 3 lines changed');
}

// One line changed
{
  const newLines = ['A', 'B-new', 'C'];
  const prevLines = ['A', 'B', 'C'];
  const { changes, out } = buildDiffOutput(newLines, prevLines, 3);
  assertEq(changes, 1, 'one change: 1 diff');
  // Verify the output contains SGR reset BEFORE \x1b[2K and AFTER content
  assert(out[0].includes('\x1b[0m\x1b[2K'), 'one change: leading SGR reset before erase');
  assert(out[0].endsWith('\x1b[0m'), 'one change: trailing SGR reset after content');
  assert(out[0].includes('B-new'), 'one change: correct content');
  assert(out[0].startsWith('\x1b[2;1H'), 'one change: correct row position (row 2)');
}

// No changes
{
  const newLines = ['A', 'B', 'C'];
  const prevLines = ['A', 'B', 'C'];
  const { changes } = buildDiffOutput(newLines, prevLines, 3);
  assertEq(changes, 0, 'no changes: zero diffs');
}

// Multiple non-adjacent changes (the SGR bleed scenario)
{
  const prevLines = [
    '\x1b[48;2;35;95;40mGreen BG line\x1b[0m',  // row 1: green background
    'Normal line 2',                                 // row 2: unchanged
    'Normal line 3',                                 // row 3: unchanged
    'Normal line 4',                                 // row 4: unchanged
    '\x1b[48;2;255;0;0mRed BG line\x1b[0m',       // row 5: red background
  ];
  const newLines = [
    '\x1b[48;2;35;95;40mGreen BG CHANGED\x1b[0m', // row 1: changed
    'Normal line 2',                                 // row 2: unchanged
    'Normal line 3',                                 // row 3: unchanged
    'Normal line 4',                                 // row 4: unchanged
    '\x1b[48;2;255;0;0mRed BG CHANGED\x1b[0m',    // row 5: changed
  ];
  const { changes, out } = buildDiffOutput(newLines, prevLines, 5);
  assertEq(changes, 2, 'non-adjacent: 2 lines changed');

  // Verify row 1 output
  assert(out[0].startsWith('\x1b[1;1H'), 'non-adjacent: first change at row 1');
  assert(out[0].includes('\x1b[0m\x1b[2K'), 'non-adjacent: row 1 has leading SGR reset');
  assert(out[0].endsWith('\x1b[0m'), 'non-adjacent: row 1 has trailing SGR reset');

  // Verify row 5 output
  assert(out[1].startsWith('\x1b[5;1H'), 'non-adjacent: second change at row 5');
  assert(out[1].includes('\x1b[0m\x1b[2K'), 'non-adjacent: row 5 has leading SGR reset');
  assert(out[1].endsWith('\x1b[0m'), 'non-adjacent: row 5 has trailing SGR reset');

  // Critical: verify no SGR from row 1's content leaks into row 5's erase
  // Row 5's output should be: \x1b[5;1H\x1b[0m\x1b[2K{content}\x1b[0m
  // The \x1b[0m BEFORE \x1b[2K ensures erase uses default background
  const row5Out = out[1];
  const eraseIdx = row5Out.indexOf('\x1b[2K');
  const resetBeforeErase = row5Out.substring(0, eraseIdx);
  assert(
    resetBeforeErase.endsWith('\x1b[0m'),
    'non-adjacent: SGR is reset immediately before row 5 erase (no green BG bleed)'
  );
}

console.log('Testing realistic Ink write patterns...');

// Simulate: Ink overflow write (output >= terminal rows)
{
  // Ink writes: \x1b[2J\x1b[3J\x1b[H + rendered output + \n
  const rendered = Array.from({length: 34}, (_, i) =>
    `\x1b[38;2;204;204;204mLine ${i}\x1b[39m`
  ).join('\n');
  const raw = `\x1b[2J\x1b[3J\x1b[H${rendered}\n`;
  const lines = processBuffer(raw, 34);

  assertEq(lines.length, 34, 'ink overflow: 34 lines');
  assertEq(lines[0], '\x1b[38;2;204;204;204mLine 0\x1b[39m', 'ink overflow: line 0 correct');
  assertEq(lines[33], '\x1b[38;2;204;204;204mLine 33\x1b[39m', 'ink overflow: line 33 correct');
}

// Simulate: Ink non-overflow write (log-update)
{
  // log-update.render: eraseLines(prevCount) + content + \n
  const eraseLines = (count) => {
    let clear = '';
    for (let i = 0; i < count; i++) {
      clear += '\x1b[2K';
      if (i < count - 1) clear += '\x1b[1A';
    }
    if (count) clear += '\x1b[G';
    return clear;
  };

  const rendered = Array.from({length: 20}, (_, i) =>
    `\x1b[38;2;204;204;204mLine ${i}\x1b[39m`
  ).join('\n');
  const raw = eraseLines(20) + rendered + '\n';
  const lines = processBuffer(raw, 24);

  assertEq(lines[0], '\x1b[38;2;204;204;204mLine 0\x1b[39m', 'ink non-overflow: line 0 correct');
  assertEq(lines[19], '\x1b[38;2;204;204;204mLine 19\x1b[39m', 'ink non-overflow: line 19 correct');
  assertEq(lines[20], '', 'ink non-overflow: line 20 empty (padded)');
}

// Simulate: Ink hasStaticOutput path (clear + static + render)
// This produces 3 writes: clear, static output, then render
{
  const eraseLines = (count) => {
    let clear = '';
    for (let i = 0; i < count; i++) {
      clear += '\x1b[2K';
      if (i < count - 1) clear += '\x1b[1A';
    }
    if (count) clear += '\x1b[G';
    return clear;
  };

  // Write 1: log.clear() — erases N lines
  const write1 = eraseLines(10);
  // Write 2: static output (e.g., console.log output)
  const write2 = 'Static output\n';
  // Write 3: log.render(content) — no erase prefix (previousLineCount was reset to 0 by clear)
  const write3 = 'Main content\nLine 2\n';

  // All three accumulate in buffer
  const raw = write1 + write2 + write3;
  const lines = processBuffer(raw, 5);

  // After extractLastFrame: \x1b[G is in write1, so everything after it is:
  // 'Static output\nMain content\nLine 2\n'
  // After stripping: same (no control sequences in content)
  // After splitting: ['Static output', 'Main content', 'Line 2']
  assertEq(lines[0], 'Static output', 'static path: static output on line 0');
  assertEq(lines[1], 'Main content', 'static path: main content on line 1');
  assertEq(lines[2], 'Line 2', 'static path: line 2 correct');
}

// Simulate: rapid re-renders (3 frames in one tick)
{
  const eraseLines = (count) => {
    let clear = '';
    for (let i = 0; i < count; i++) {
      clear += '\x1b[2K';
      if (i < count - 1) clear += '\x1b[1A';
    }
    if (count) clear += '\x1b[G';
    return clear;
  };

  const frame1 = eraseLines(5) + 'F1-L0\nF1-L1\nF1-L2\nF1-L3\nF1-L4\n';
  const frame2 = eraseLines(5) + 'F2-L0\nF2-L1\nF2-L2\nF2-L3\nF2-L4\n';
  const frame3 = eraseLines(5) + 'F3-L0\nF3-L1\nF3-L2\nF3-L3\nF3-L4\n';

  const raw = frame1 + frame2 + frame3;
  const lines = processBuffer(raw, 5);

  // Should get frame 3 (the latest)
  assertEq(lines[0], 'F3-L0', 'rapid: latest frame line 0');
  assertEq(lines[4], 'F3-L4', 'rapid: latest frame line 4');
}

// Simulate: overflow followed by non-overflow in same tick
{
  const eraseLines = (count) => {
    let clear = '';
    for (let i = 0; i < count; i++) {
      clear += '\x1b[2K';
      if (i < count - 1) clear += '\x1b[1A';
    }
    if (count) clear += '\x1b[G';
    return clear;
  };

  // First render: overflow
  const frame1 = '\x1b[2J\x1b[3J\x1b[HOverflow\nContent\n';
  // Second render: non-overflow (after content size drops)
  const frame2 = eraseLines(2) + 'NonOverflow\nContent2\n';

  const raw = frame1 + frame2;
  const lines = processBuffer(raw, 5);

  assertEq(lines[0], 'NonOverflow', 'overflow+nonoverflow: latest (non-overflow) content');
  assertEq(lines[1], 'Content2', 'overflow+nonoverflow: latest line 2');
}

// ── Integration-style test: full render cycle ─────────────
console.log('Testing full render cycle simulation...');

{
  let prevLines = [];
  const maxRows = 5;
  const terminalOutput = []; // What the real terminal would receive

  function simulateFlush(raw) {
    const lines = processBuffer(raw, maxRows);
    const hasContent = lines.some(l => l.length > 0);
    if (!hasContent) return;

    const { out, changes } = buildDiffOutput(lines, prevLines, maxRows);
    if (changes > 0) {
      terminalOutput.push(...out);
    }
    prevLines = lines;
    return { lines, changes };
  }

  // Frame 1: initial render
  const r1 = simulateFlush('\x1b[2J\x1b[3J\x1b[H\x1b[1mHeader\x1b[0m\nProject A\nProject B\n\nStatus: OK\n');
  assertEq(r1.changes, 5, 'cycle: frame 1 writes all 5 rows');

  // Frame 2: only status changes
  const r2 = simulateFlush('\x1b[2J\x1b[3J\x1b[H\x1b[1mHeader\x1b[0m\nProject A\nProject B\n\nStatus: CHANGED\n');
  assertEq(r2.changes, 1, 'cycle: frame 2 only 1 row changed (status)');

  // Frame 3: header animation tick (bold off)
  const r3 = simulateFlush('\x1b[2J\x1b[3J\x1b[HHeader\nProject A\nProject B\n\nStatus: CHANGED\n');
  assertEq(r3.changes, 1, 'cycle: frame 3 only 1 row changed (header SGR)');

  // Frame 4: identical — no changes
  const r4 = simulateFlush('\x1b[2J\x1b[3J\x1b[HHeader\nProject A\nProject B\n\nStatus: CHANGED\n');
  assertEq(r4.changes, 0, 'cycle: frame 4 no changes (identical)');

  // Verify SGR reset pattern in all diff output
  for (let i = 0; i < terminalOutput.length; i++) {
    const line = terminalOutput[i];
    assert(
      line.includes('\x1b[0m\x1b[2K'),
      `cycle: output ${i} has SGR reset before erase`
    );
    assert(
      line.endsWith('\x1b[0m'),
      `cycle: output ${i} has SGR reset at end`
    );
  }
}

// ══════════════════════════════════════════════════════════
// Results
// ══════════════════════════════════════════════════════════
console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}\n`);
process.exit(failed > 0 ? 1 : 0);
