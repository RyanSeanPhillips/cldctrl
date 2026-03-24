#!/usr/bin/env node
/**
 * Convert ANSI snapshot output to a styled HTML file.
 * Usage: cc --demo --snapshot | node scripts/snapshot-to-html.mjs > docs/screenshot.html
 *    or: COLUMNS=120 LINES=40 cc --demo --snapshot 2>/dev/null | node scripts/snapshot-to-html.mjs > docs/screenshot.html
 */

import { readFileSync } from 'fs';

const input = readFileSync(0, 'utf-8');

// ANSI color code to CSS color mapping
const ANSI_COLORS = {
  '30': '#000', '31': '#c0392b', '32': '#27ae60', '33': '#f39c12',
  '34': '#2980b9', '35': '#8e44ad', '36': '#16a085', '37': '#bdc3c7',
  '90': '#7f8c8d', '91': '#e74c3c', '92': '#2ecc71', '93': '#f1c40f',
  '94': '#3498db', '95': '#9b59b6', '96': '#1abc9c', '97': '#ecf0f1',
};

// Parse 256-color and RGB ANSI codes
function parseAnsiColor(code) {
  const parts = code.split(';');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === '38' && parts[i + 1] === '2') {
      // RGB: 38;2;r;g;b
      const r = parts[i + 2], g = parts[i + 3], b = parts[i + 4];
      return { fg: `rgb(${r},${g},${b})`, skip: 4 };
    }
    if (p === '48' && parts[i + 1] === '2') {
      const r = parts[i + 2], g = parts[i + 3], b = parts[i + 4];
      return { bg: `rgb(${r},${g},${b})`, skip: 4 };
    }
    if (p === '38' && parts[i + 1] === '5') {
      return { fg: ansi256ToRgb(parseInt(parts[i + 2])), skip: 2 };
    }
    if (p === '48' && parts[i + 1] === '5') {
      return { bg: ansi256ToRgb(parseInt(parts[i + 2])), skip: 2 };
    }
  }
  return null;
}

function ansi256ToRgb(n) {
  if (n < 16) {
    const base = [
      '#000','#800','#080','#880','#008','#808','#088','#ccc',
      '#888','#f00','#0f0','#ff0','#00f','#f0f','#0ff','#fff',
    ];
    return base[n] || '#fff';
  }
  if (n < 232) {
    n -= 16;
    const r = Math.floor(n / 36) * 51;
    const g = Math.floor((n % 36) / 6) * 51;
    const b = (n % 6) * 51;
    return `rgb(${r},${g},${b})`;
  }
  const gray = (n - 232) * 10 + 8;
  return `rgb(${gray},${gray},${gray})`;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Convert ANSI string to HTML spans
function ansiToHtml(text) {
  let html = '';
  let fg = null, bg = null, bold = false, dim = false;
  const regex = /\x1b\[([0-9;]*)m/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    // Output text before this escape
    if (match.index > lastIndex) {
      const chunk = escapeHtml(text.slice(lastIndex, match.index));
      html += applyStyle(chunk, fg, bg, bold, dim);
    }
    lastIndex = regex.lastIndex;

    const codes = match[1].split(';').filter(Boolean);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === '0') { fg = null; bg = null; bold = false; dim = false; }
      else if (c === '1') bold = true;
      else if (c === '2') dim = true;
      else if (c === '22') { bold = false; dim = false; }
      else if (c === '39') fg = null;
      else if (c === '49') bg = null;
      else if (ANSI_COLORS[c]) fg = ANSI_COLORS[c];
      else if (c === '38' || c === '48') {
        // Extended color — parse remaining codes
        const remaining = codes.slice(i).join(';');
        const parsed = parseAnsiColor(remaining);
        if (parsed) {
          if (parsed.fg) fg = parsed.fg;
          if (parsed.bg) bg = parsed.bg;
          i += parsed.skip;
        }
      }
    }
  }

  // Remaining text
  if (lastIndex < text.length) {
    html += applyStyle(escapeHtml(text.slice(lastIndex)), fg, bg, bold, dim);
  }

  return html;
}

function applyStyle(text, fg, bg, bold, dim) {
  if (!text) return '';
  const styles = [];
  if (fg) styles.push(`color:${fg}`);
  if (bg) styles.push(`background-color:${bg}`);
  if (bold) styles.push('font-weight:bold');
  if (dim) styles.push('opacity:0.6');
  if (styles.length === 0) return text;
  return `<span style="${styles.join(';')}">${text}</span>`;
}

// Process lines
const lines = input.split('\n');
const htmlLines = lines.map(line => ansiToHtml(line)).join('\n');

const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>CLD CTRL Screenshot</title>
<style>
  body {
    margin: 0;
    padding: 0;
    background: #06080d;
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100vh;
  }
  .terminal {
    background: #06080d;
    color: #cccccc;
    font-family: 'Cascadia Code', 'JetBrains Mono', 'Fira Code', 'Consolas', 'Monaco', monospace;
    font-size: 14px;
    line-height: 1.3;
    padding: 16px 20px;
    border-radius: 12px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.6);
    white-space: pre;
    overflow: hidden;
  }
  /* Fake window chrome */
  .window {
    background: #1a1d23;
    border-radius: 12px;
    overflow: hidden;
    box-shadow: 0 12px 48px rgba(0,0,0,0.5);
  }
  .titlebar {
    background: #2a2d33;
    padding: 10px 16px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .dot { width: 12px; height: 12px; border-radius: 50%; }
  .dot-red { background: #ff5f57; }
  .dot-yellow { background: #febc2e; }
  .dot-green { background: #28c840; }
  .titlebar-text {
    color: #808080;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 13px;
    margin-left: 8px;
  }
</style>
</head>
<body>
<div class="window">
  <div class="titlebar">
    <div class="dot dot-red"></div>
    <div class="dot dot-yellow"></div>
    <div class="dot dot-green"></div>
    <span class="titlebar-text">CLD CTRL</span>
  </div>
  <div class="terminal">${htmlLines}</div>
</div>
</body>
</html>`;

process.stdout.write(html);
