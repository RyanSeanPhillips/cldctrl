/**
 * Config loading, validation, and migration tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, saveConfig, validateConfig, setConfigDir, createDefaultConfig } from '../src/config.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cldctrl-test-'));
  setConfigDir(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('should return default config when no file exists', () => {
    const { config, isNew } = loadConfig();
    expect(isNew).toBe(true);
    expect(config.config_version).toBe(4);
    expect(config.projects).toEqual([]);
  });

  it('should load existing config file', () => {
    const testConfig = createDefaultConfig();
    testConfig.projects = [{ name: 'Test', path: '/test/path' }];
    saveConfig(testConfig);

    const { config, isNew } = loadConfig();
    expect(isNew).toBe(false);
    expect(config.projects).toHaveLength(1);
    expect(config.projects[0].name).toBe('Test');
  });
});

describe('config migration', () => {
  it('should migrate v1 to v4', () => {
    const v1Config = {
      projects: [{ name: 'Test', path: '/test' }],
      launch: { explorer: true, vscode: true, claude: true },
      icon_color: '#DA8F4E',
    };
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(v1Config));

    const { config, migrated } = loadConfig();
    expect(migrated).toBe(true);
    expect(config.config_version).toBe(4);
    expect(config.hidden_projects).toEqual([]);
    expect(config.global_hotkey).toBeDefined();
    expect(config.notifications).toBeDefined();
    expect(config.notifications.github_issues.enabled).toBe(true);
  });

  it('should migrate v2 to v4', () => {
    const v2Config = {
      config_version: 2,
      projects: [],
      hidden_projects: ['hidden_path'],
      launch: { explorer: true, vscode: true, claude: true },
      icon_color: '#DA8F4E',
    };
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(v2Config));

    const { config, migrated } = loadConfig();
    expect(migrated).toBe(true);
    expect(config.config_version).toBe(4);
    expect(config.hidden_projects).toEqual(['hidden_path']);
    expect(config.global_hotkey).toBeDefined();
    expect(config.notifications).toBeDefined();
  });

  it('should not migrate v4', () => {
    const v4Config = createDefaultConfig();
    saveConfig(v4Config);

    const { migrated } = loadConfig();
    expect(migrated).toBe(false);
  });
});

describe('saveConfig', () => {
  it('should create config directory if it does not exist', () => {
    const nestedDir = path.join(tmpDir, 'nested', 'dir');
    setConfigDir(nestedDir);

    saveConfig(createDefaultConfig());
    expect(fs.existsSync(path.join(nestedDir, 'config.json'))).toBe(true);
  });

  it('should write valid JSON', () => {
    saveConfig(createDefaultConfig());
    const content = fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8');
    expect(() => JSON.parse(content)).not.toThrow();
  });
});

describe('validateConfig', () => {
  it('should accept valid config', () => {
    const result = validateConfig(createDefaultConfig());
    expect(result.success).toBe(true);
  });

  it('should reject invalid config', () => {
    const result = validateConfig({ config_version: 'invalid' });
    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
  });
});
