/**
 * Session parsing and stats tests.
 */

import { describe, it, expect } from 'vitest';
import { formatTokenCount } from '../src/core/sessions.js';

describe('formatTokenCount', () => {
  it('should format millions', () => {
    expect(formatTokenCount(1_500_000)).toBe('1.5M');
    expect(formatTokenCount(2_000_000)).toBe('2.0M');
  });

  it('should format thousands', () => {
    expect(formatTokenCount(42_000)).toBe('42k');
    expect(formatTokenCount(1_500)).toBe('2k'); // rounds
  });

  it('should show raw number for small values', () => {
    expect(formatTokenCount(500)).toBe('500');
    expect(formatTokenCount(0)).toBe('0');
  });
});
