/**
 * Slug generation tests — MUST match PowerShell Get-ProjectSlug output.
 * PowerShell: $path.Replace(':', '-').Replace('\', '-').Replace('/', '-').Replace(' ', '-').Replace('_', '-')
 *
 * Verified against actual ~/.claude/projects/ directory names on disk.
 * Key insight: C:\ produces C-- (colon→dash, backslash→dash)
 */

import { describe, it, expect } from 'vitest';
import { getProjectSlug } from '../src/core/projects.js';

describe('getProjectSlug', () => {
  it('should replace colons AND backslashes (producing C-- for C:\\)', () => {
    // C:\ → C (kept) + : (→-) + \ (→-) = C--
    expect(getProjectSlug('C:\\Users\\test')).toBe('C--Users-test');
  });

  it('should replace all backslashes globally', () => {
    expect(getProjectSlug('C:\\Users\\test\\project')).toBe('C--Users-test-project');
  });

  it('should replace forward slashes', () => {
    expect(getProjectSlug('/home/user/project')).toBe('-home-user-project');
  });

  it('should replace spaces', () => {
    expect(getProjectSlug('C:\\My Projects\\test')).toBe('C--My-Projects-test');
  });

  it('should replace underscores', () => {
    expect(getProjectSlug('C:\\my_project')).toBe('C--my-project');
  });

  it('should handle multiple separators in sequence', () => {
    // C:\ _test → C:-→C-- then \→- then space→- then _→-
    expect(getProjectSlug('C:\\ _test')).toBe('C----test');
  });

  // Verified against actual ~/.claude/projects/ directory names
  it('should match actual slug: neuronforge', () => {
    expect(getProjectSlug('C:\\Users\\rphil2\\Dropbox\\neuronforge'))
      .toBe('C--Users-rphil2-Dropbox-neuronforge');
  });

  it('should match actual slug: python scripts path', () => {
    expect(getProjectSlug('C:\\Users\\rphil2\\Dropbox\\python scripts\\breath_analysis\\pyqt6'))
      .toBe('C--Users-rphil2-Dropbox-python-scripts-breath-analysis-pyqt6');
  });

  it('should match actual slug: netsims path', () => {
    expect(getProjectSlug('C:\\Users\\rphil2\\Dropbox\\spk_shape\\for sushmita\\netsims\\Fig5'))
      .toBe('C--Users-rphil2-Dropbox-spk-shape-for-sushmita-netsims-Fig5');
  });

  it('should match actual slug: CageMetrics', () => {
    expect(getProjectSlug('C:\\Users\\rphil2\\Dropbox\\CageMetrics'))
      .toBe('C--Users-rphil2-Dropbox-CageMetrics');
  });
});
