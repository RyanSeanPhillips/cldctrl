/**
 * Git status formatting tests.
 */

import { describe, it, expect } from 'vitest';
import { formatGitStatus } from '../src/core/git.js';
import type { GitStatus } from '../src/types.js';

describe('formatGitStatus', () => {
  it('should show [no git] for null', () => {
    expect(formatGitStatus(null)).toBe('[no git]');
    expect(formatGitStatus(undefined)).toBe('[no git]');
  });

  it('should show clean status', () => {
    const status: GitStatus = { branch: 'main', dirty: 0, ahead: 0, behind: 0, available: true };
    expect(formatGitStatus(status)).toBe('main ✓');
  });

  it('should show dirty count', () => {
    const status: GitStatus = { branch: 'main', dirty: 3, ahead: 0, behind: 0, available: true };
    expect(formatGitStatus(status)).toBe('main ●3');
  });

  it('should show ahead/behind', () => {
    const status: GitStatus = { branch: 'dev', dirty: 0, ahead: 2, behind: 1, available: true };
    expect(formatGitStatus(status)).toBe('dev ✓ ↑2 ↓1');
  });

  it('should show all indicators combined', () => {
    const status: GitStatus = { branch: 'feature', dirty: 5, ahead: 3, behind: 0, available: true };
    expect(formatGitStatus(status)).toBe('feature ●5 ↑3');
  });
});
