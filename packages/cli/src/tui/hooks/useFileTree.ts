/**
 * File tree state management: lazy directory loading, expand/collapse, navigation.
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { readDirectory, parseGitignore, openFileInEditor, readFilePreview, getFileIcon } from '../../core/filetree.js';
import { isDemoMode } from '../../core/demo-data.js';
import type { FileNode } from '../../core/filetree.js';

export interface FlatNode {
  node: FileNode;
  expanded: boolean;
  depth: number;
  hasChildren: boolean;
}

export interface FileTreeState {
  flatNodes: FlatNode[];
  expand: (index: number) => void;
  collapse: (index: number) => void;
  openFile: (index: number) => boolean;
  getPreview: (index: number) => string[] | null;
}

/**
 * Flatten the tree of expanded directories into a navigable list.
 */
function flattenTree(
  dirCache: Map<string, FileNode[]>,
  expanded: Set<string>,
): FlatNode[] {
  const result: FlatNode[] = [];

  function walk(parentRelative: string, depth: number) {
    const children = dirCache.get(parentRelative);
    if (!children) return;

    for (const node of children) {
      const isDir = node.type === 'directory';
      const isExpanded = isDir && expanded.has(node.relativePath);
      result.push({
        node,
        expanded: isExpanded,
        depth,
        hasChildren: isDir,
      });

      if (isExpanded) {
        walk(node.relativePath, depth + 1);
      }
    }
  }

  walk('', 0);
  return result;
}

// ── Demo file tree ────────────────────────────────────────
function makeDemoNode(name: string, relativePath: string, type: 'file' | 'directory', opts?: { isClaude?: boolean }): FileNode {
  const { icon, color } = getFileIcon(name);
  return { name, path: `/demo/${relativePath}`, relativePath, type, fileIcon: icon, iconColor: color, isClaude: opts?.isClaude };
}

function buildDemoTree(): { cache: Map<string, FileNode[]>; expanded: Set<string> } {
  const cache = new Map<string, FileNode[]>();
  cache.set('', [
    makeDemoNode('.claude', '.claude', 'directory'),
    makeDemoNode('src', 'src', 'directory'),
    makeDemoNode('tests', 'tests', 'directory'),
    makeDemoNode('docs', 'docs', 'directory'),
    makeDemoNode('CLAUDE.md', 'CLAUDE.md', 'file', { isClaude: true }),
    makeDemoNode('package.json', 'package.json', 'file'),
    makeDemoNode('tsconfig.json', 'tsconfig.json', 'file'),
    makeDemoNode('README.md', 'README.md', 'file'),
    makeDemoNode('.gitignore', '.gitignore', 'file'),
  ]);
  cache.set('src', [
    makeDemoNode('components', 'src/components', 'directory'),
    makeDemoNode('hooks', 'src/hooks', 'directory'),
    makeDemoNode('utils', 'src/utils', 'directory'),
    makeDemoNode('index.ts', 'src/index.ts', 'file'),
    makeDemoNode('config.ts', 'src/config.ts', 'file'),
    makeDemoNode('types.ts', 'src/types.ts', 'file'),
    makeDemoNode('App.tsx', 'src/App.tsx', 'file'),
  ]);
  cache.set('src/components', [
    makeDemoNode('Dashboard.tsx', 'src/components/Dashboard.tsx', 'file'),
    makeDemoNode('ProjectList.tsx', 'src/components/ProjectList.tsx', 'file'),
    makeDemoNode('StatusBar.tsx', 'src/components/StatusBar.tsx', 'file'),
    makeDemoNode('Settings.tsx', 'src/components/Settings.tsx', 'file'),
  ]);
  cache.set('src/hooks', [
    makeDemoNode('useKeyboard.ts', 'src/hooks/useKeyboard.ts', 'file'),
    makeDemoNode('useAppState.ts', 'src/hooks/useAppState.ts', 'file'),
  ]);
  cache.set('tests', [
    makeDemoNode('config.test.ts', 'tests/config.test.ts', 'file'),
    makeDemoNode('sessions.test.ts', 'tests/sessions.test.ts', 'file'),
  ]);
  const expanded = new Set(['', 'src', 'src/components']);
  return { cache, expanded };
}

// ── Hook ──────────────────────────────────────────────────
export function useFileTree(projectPath: string | null): FileTreeState {
  const demo = isDemoMode();
  const [demoData] = useState(() => demo ? buildDemoTree() : null);
  const [expanded, setExpanded] = useState<Set<string>>(() => demo && demoData ? demoData.expanded : new Set(['']));
  const [dirCache, setDirCache] = useState<Map<string, FileNode[]>>(() => demo && demoData ? demoData.cache : new Map());
  const prevPathRef = useRef<string | null>(null);

  // Parse gitignore once per project
  const isIgnored = useMemo(
    () => !demo && projectPath ? parseGitignore(projectPath) : null,
    [projectPath, demo],
  );

  // Load root directory when project changes (skip in demo mode)
  useEffect(() => {
    if (demo) return;
    if (!projectPath || !isIgnored) {
      setDirCache(new Map());
      setExpanded(new Set(['']));
      return;
    }

    // Reset when project changes
    if (prevPathRef.current !== projectPath) {
      prevPathRef.current = projectPath;
      const rootChildren = readDirectory(projectPath, projectPath, isIgnored);
      const newCache = new Map<string, FileNode[]>();
      newCache.set('', rootChildren);
      setDirCache(newCache);
      setExpanded(new Set(['']));
    }
  }, [projectPath, isIgnored, demo]);

  const flatNodes = useMemo(
    () => flattenTree(dirCache, expanded),
    [dirCache, expanded],
  );

  const expand = useCallback((index: number) => {
    const flat = flatNodes[index];
    if (!flat || flat.node.type !== 'directory' || !projectPath || !isIgnored) return;

    const relPath = flat.node.relativePath;

    // Lazy load directory contents if not cached
    if (!dirCache.has(relPath)) {
      const children = readDirectory(flat.node.path, projectPath, isIgnored);
      setDirCache(prev => {
        const next = new Map(prev);
        next.set(relPath, children);
        return next;
      });
    }

    setExpanded(prev => {
      if (prev.has(relPath)) return prev;
      const next = new Set(prev);
      next.add(relPath);
      return next;
    });
  }, [flatNodes, dirCache, projectPath, isIgnored]);

  const collapse = useCallback((index: number) => {
    const flat = flatNodes[index];
    if (!flat) return;

    if (flat.node.type === 'directory' && flat.expanded) {
      // Collapse this directory
      setExpanded(prev => {
        const next = new Set(prev);
        next.delete(flat.node.relativePath);
        return next;
      });
    }
  }, [flatNodes]);

  const openFile = useCallback((index: number) => {
    const flat = flatNodes[index];
    if (!flat) return false;

    if (flat.node.type === 'directory') {
      // Toggle expand for directories
      if (flat.expanded) {
        collapse(index);
      } else {
        expand(index);
      }
      return true;
    }

    return openFileInEditor(flat.node.path);
  }, [flatNodes, expand, collapse]);

  const getPreview = useCallback((index: number): string[] | null => {
    const flat = flatNodes[index];
    if (!flat || flat.node.type !== 'file') return null;
    return readFilePreview(flat.node.path, 15);
  }, [flatNodes]);

  return { flatNodes, expand, collapse, openFile, getPreview };
}
