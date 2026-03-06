/**
 * Sixel image rendering for terminals that support it (Windows Terminal 1.22+).
 * Small rocket icon: 32x32 source from docs/icon.png, 2x horizontal stretch.
 * Renders as ~4 character cells wide × ~2 rows tall.
 */

// Base64-encoded Sixel data for the small (32x32, 2x stretch) rocket icon
const ROCKET_SIXEL_B64 = 'G1BxIzE7Mjs4NTs0NzsyIzI7Mjs1NTs3MTs4NiMzOzI7MTAwOzc4OzE2IzQ7Mjs3ODsyMDs4IzU7Mjs1NTsxMjs0IzE/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/P19fX18/P19fX18/Pz8/Pz8/Pz8/JC0jMT8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/X19vb3d3e3tdXX5+fn5+fn5+Xl5MTD8/Pz8/Pz8/Pz8kIzI/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/X18/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/JC0jMT8/Pz8/Pz8/Pz8/Pz8/Q0NNTU1NY2N9fX19e3t9fX5+fn5+fn5+Xl5NTUZGQkJAQD8/Pz8/Pz8/Pz8/Pz8/Pz8kIzI/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/QEA/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/JC0jMT8/Pz8/Pz8/Pz8/Pz8/Pz9fX3JyRkZGRl5eXl5OTkZGdnZ+fnV1Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8kIzM/Pz8/Pz8/Pz8/Pz9HR1tbV1dHR3d3R0c/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/JCM0Pz8/Pz8/Pz8/P29vb29fXz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/PyQtIzQ/Pz8/Pz8/Pz8/Pz9AQD8/RUVFRT8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/JCMxPz8/Pz8/Pz8/Pz8/Pz9CQkBAPz8/Pz8/Pz8/Pz8/Pz8/P0BAPz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/PyQjMz8/Pz8/Pz8/Pz8/Pz8/Pz8/P0BAQkJAQD8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8kIzU/Pz8/Pz8/Pz8/RUVFRT8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/JC0tG1w=';

let _rocketSixel: string | null = null;

/** Get the decoded Sixel string for the small rocket icon */
export function getRocketSixel(): string {
  if (!_rocketSixel) {
    _rocketSixel = Buffer.from(ROCKET_SIXEL_B64, 'base64').toString('binary');
  }
  return _rocketSixel;
}

/** Check if the terminal likely supports Sixel graphics */
export function supportsSixel(): boolean {
  // Windows Terminal 1.22+ supports Sixel
  if (process.env.WT_SESSION) return true;
  // WezTerm supports Sixel
  if (process.env.TERM_PROGRAM === 'WezTerm') return true;
  return false;
}

/**
 * Write the Sixel rocket at a specific screen position using cursor escape codes.
 * This bypasses Ink's rendering pipeline to avoid glitches.
 * @param row 1-based row position
 * @param col 1-based column position
 */
export function writeSixelAt(row: number, col: number): void {
  if (!supportsSixel()) return;
  const sixel = getRocketSixel();
  // Save cursor, move to position, write sixel, restore cursor
  process.stdout.write(`\x1b[s\x1b[${row};${col}H${sixel}\x1b[u`);
}
