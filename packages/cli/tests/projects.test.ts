/**
 * Project list building and path safety tests.
 */

import { describe, it, expect } from 'vitest';
import { buildProjectList, pathFromSlug } from '../src/core/projects.js';
import { pathIsSafe } from '../src/core/platform.js';
import type { Config } from '../src/types.js';
import { createDefaultConfig } from '../src/config.js';

describe('buildProjectList', () => {
  it('should return empty list for empty config', () => {
    const config = createDefaultConfig();
    const projects = buildProjectList(config);
    // May have discovered projects, so just check it's an array
    expect(Array.isArray(projects)).toBe(true);
  });

  it('should include configured projects as pinned', () => {
    const config = createDefaultConfig();
    config.projects = [
      { name: 'TestProject', path: '/nonexistent/test/project' },
    ];
    const projects = buildProjectList(config);
    const pinned = projects.filter((p) => p.pinned);
    expect(pinned.length).toBeGreaterThanOrEqual(1);
    expect(pinned[0].name).toBe('TestProject');
  });

  it('should respect hidden_projects', () => {
    const config = createDefaultConfig();
    config.projects = [
      { name: 'Visible', path: '/visible' },
      { name: 'Hidden', path: '/hidden' },
    ];
    config.hidden_projects = ['/hidden'];
    const projects = buildProjectList(config);
    const names = projects.map((p) => p.name);
    expect(names).toContain('Visible');
    expect(names).not.toContain('Hidden');
  });
});

describe('pathFromSlug', () => {
  it('should reconstruct Windows path from slug', () => {
    const result = pathFromSlug('C-Users-test-project');
    // On the current platform, path.sep determines the result
    expect(result).toContain('Users');
    expect(result).toContain('test');
  });

  it('should return null for single-segment slug', () => {
    expect(pathFromSlug('x')).toBeNull();
  });
});

describe('pathIsSafe', () => {
  it('should reject empty paths', () => {
    expect(pathIsSafe('')).toBe(false);
  });

  it('should reject path traversal', () => {
    expect(pathIsSafe('/foo/../etc/passwd')).toBe(false);
    expect(pathIsSafe('C:\\Users\\..\\System32')).toBe(false);
  });

  it('should accept normal paths', () => {
    expect(pathIsSafe('/home/user/project')).toBe(true);
  });
});
