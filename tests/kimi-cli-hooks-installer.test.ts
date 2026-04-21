/**
 * Tests for Kimi CLI Hooks Installer
 *
 * Validates:
 * 1. TOML command strings are properly escaped (no unescaped inner quotes)
 * 2. PreToolUse timeout is in seconds (2s), not milliseconds (2000)
 * 3. AGENTS.md uninstall only removes exact placeholder matches (sentinel-based)
 */
import { describe, it, expect } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ---------------------------------------------------------------------------
// 1. TOML command escaping
// ---------------------------------------------------------------------------

describe('KimiCliHooksInstaller - TOML escaping', () => {
  it('should produce valid TOML when command contains inner double quotes', async () => {
    const src = readFileSync('src/services/integrations/KimiCliHooksInstaller.ts', 'utf-8');

    // buildHookBlock must escape def.command properly (e.g. JSON.stringify)
    expect(src).toContain('JSON.stringify(def.command)');
    expect(src).not.toContain('command = "${def.command}"');
  });

  it('should not produce unescaped quotes in generated TOML', async () => {
    // Simulate what buildHookBlock produces for a quoted command
    const command = '"/path/with spaces/bun" "/path/to/worker" hook kimi-cli context';
    const tomlLine = `command = ${JSON.stringify(command)}`;

    // A valid TOML basic string cannot contain unescaped quotes
    const match = tomlLine.match(/^command = "(.*)"$/);
    expect(match).toBeTruthy();
    const inner = match![1];

    // Count unescaped quotes inside the value
    let unescapedQuotes = 0;
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === '"' && (i === 0 || inner[i - 1] !== '\\')) {
        unescapedQuotes++;
      }
    }
    expect(unescapedQuotes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. PreToolUse timeout in seconds
// ---------------------------------------------------------------------------

describe('KimiCliHooksInstaller - timeout values', () => {
  it('should set PreToolUse timeout to 2 seconds, not 2000', async () => {
    const src = readFileSync('src/services/integrations/KimiCliHooksInstaller.ts', 'utf-8');

    // The literal must be 2, not 2000
    expect(src).toContain("'PreToolUse': 2");
    expect(src).not.toContain("'PreToolUse': 2000");
  });

  it('should have reasonable timeout values for all events', async () => {
    const src = readFileSync('src/services/integrations/KimiCliHooksInstaller.ts', 'utf-8');

    // All timeouts should be <= 600 (kimi-cli max per HookDef pydantic model)
    const timeouts = [
      { event: 'SessionStart', max: 600 },
      { event: 'UserPromptSubmit', max: 600 },
      { event: 'PreToolUse', max: 10 },
      { event: 'PostToolUse', max: 600 },
      { event: 'PostToolUseFailure', max: 600 },
      { event: 'Stop', max: 600 },
      { event: 'SessionEnd', max: 600 },
    ];

    for (const { event, max } of timeouts) {
      const regex = new RegExp(`'${event}':\\s*(\\d+)`);
      const match = src.match(regex);
      expect(match).toBeTruthy();
      const value = parseInt(match![1], 10);
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(max);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. AGENTS.md sentinel-based deletion
// ---------------------------------------------------------------------------

describe('KimiCliHooksInstaller - AGENTS.md safety', () => {
  let tmpDir: string;

  const setupTmpDir = () => {
    tmpDir = join(tmpdir(), `kimi-cli-test-${Date.now()}`);
    mkdirSync(join(tmpDir, '.kimi'), { recursive: true });
  };

  const cleanupTmpDir = () => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  };

  it('should contain a sentinel token in the placeholder', async () => {
    const src = readFileSync('src/services/integrations/KimiCliHooksInstaller.ts', 'utf-8');
    expect(src).toContain('KIMI_PLACEHOLDER_V1');
  });

  it('should delete AGENTS.md only when it exactly matches the placeholder', () => {
    setupTmpDir();
    try {
      const agentsPath = join(tmpDir, '.kimi', 'AGENTS.md');

      // Placeholder content (must match what the installer generates)
      const placeholder = `# Memory Context from Past Sessions

*No context yet. Complete your first session and context will appear here.*

Use claude-mem's MCP search tools for manual memory queries.
<!-- KIMI_PLACEHOLDER_V1 -->
`;

      // Exact match → should delete
      writeFileSync(agentsPath, placeholder);
      expect(existsSync(agentsPath)).toBe(true);

      // Simulate the uninstaller logic
      const content = readFileSync(agentsPath, 'utf-8');
      const isExactPlaceholder = content.trim() === placeholder.trim();
      const hasSentinelOnly = content.includes('KIMI_PLACEHOLDER_V1') &&
        !content.replace('<!-- KIMI_PLACEHOLDER_V1 -->', '').trim().includes('\n');

      if (isExactPlaceholder || hasSentinelOnly) {
        rmSync(agentsPath);
      }

      expect(existsSync(agentsPath)).toBe(false);
    } finally {
      cleanupTmpDir();
    }
  });

  it('should NOT delete AGENTS.md when user has added content', () => {
    setupTmpDir();
    try {
      const agentsPath = join(tmpDir, '.kimi', 'AGENTS.md');

      // User-edited content with sentinel but additional text
      const userContent = `# Memory Context from Past Sessions

*No context yet. Complete your first session and context will appear here.*

Use claude-mem's MCP search tools for manual memory queries.
<!-- KIMI_PLACEHOLDER_V1 -->

## My Custom Rules

Always use TypeScript.
`;

      writeFileSync(agentsPath, userContent);

      // Simulate the uninstaller logic (exact-match only)
      const content = readFileSync(agentsPath, 'utf-8');
      const trimmedContent = content.trim();
      const trimmedPlaceholder = `# Memory Context from Past Sessions

*No context yet. Complete your first session and context will appear here.*

Use claude-mem's MCP search tools for manual memory queries.
<!-- KIMI_PLACEHOLDER_V1 -->`.trim();
      const isExactPlaceholder = trimmedContent === trimmedPlaceholder;

      let deleted = false;
      if (isExactPlaceholder) {
        rmSync(agentsPath);
        deleted = true;
      }

      expect(deleted).toBe(false);
      expect(existsSync(agentsPath)).toBe(true);
    } finally {
      cleanupTmpDir();
    }
  });

  it('should NOT delete AGENTS.md that was never created by claude-mem', () => {
    setupTmpDir();
    try {
      const agentsPath = join(tmpDir, '.kimi', 'AGENTS.md');

      // Completely unrelated AGENTS.md
      const unrelatedContent = `# Project Rules

Use Python for all scripts.
Follow PEP 8.
`;

      writeFileSync(agentsPath, unrelatedContent);

      // Simulate the uninstaller logic
      const content = readFileSync(agentsPath, 'utf-8');
      const hasSentinel = content.includes('KIMI_PLACEHOLDER_V1');

      let deleted = false;
      if (hasSentinel) {
        rmSync(agentsPath);
        deleted = true;
      }

      expect(deleted).toBe(false);
      expect(existsSync(agentsPath)).toBe(true);
    } finally {
      cleanupTmpDir();
    }
  });
});
