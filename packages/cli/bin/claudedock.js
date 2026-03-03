#!/usr/bin/env node

// Node.js version check — must be >= 18
const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  process.stderr.write(
    `\nCLD CTRL requires Node.js 18 or later.\n` +
    `You are running Node.js ${process.version}.\n` +
    `Please upgrade: https://nodejs.org/\n\n`
  );
  process.exit(1);
}

import('../dist/index.js').catch((err) => {
  process.stderr.write(`Failed to start CLD CTRL: ${err.message}\n`);
  process.exit(1);
});
