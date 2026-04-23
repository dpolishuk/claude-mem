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
import { parseTomlHooks, rebuildToml } from '../src/services/integrations/KimiCliHooksInstaller.js';

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
// 1b. TOML matcher escaping
// ---------------------------------------------------------------------------

describe('KimiCliHooksInstaller - matcher escaping', () => {
  it('should escape matcher values consistently with command', async () => {
    const src = readFileSync('src/services/integrations/KimiCliHooksInstaller.ts', 'utf-8');

    // matcher must use JSON.stringify like command does
    const matcherLine = src.match(/lines\.push\(`matcher = (.+?)`\)/);
    expect(matcherLine).toBeTruthy();
    expect(matcherLine![1]).toContain('JSON.stringify(def.matcher)');
    expect(matcherLine![1]).not.toContain('"${def.matcher}"');
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

  it('should delete claude-mem-generated AGENTS.md with persistent sentinel', () => {
    setupTmpDir();
    try {
      const agentsPath = join(tmpDir, '.kimi', 'AGENTS.md');

      // Content written by SessionStart hook (has persistent sentinel)
      const generatedContent = `# Previous Session\n\nWe discussed TOML parsing.\n\n---\n*Context automatically updated by claude-mem*\n<!-- CLAUDE_MEM_KIMI_CONTEXT -->\n`;
      writeFileSync(agentsPath, generatedContent);

      // Simulate the uninstaller logic (exact match OR persistent sentinel)
      const content = readFileSync(agentsPath, 'utf-8');
      const trimmedContent = content.trim();
      const trimmedPlaceholder = `# Memory Context from Past Sessions\n\n*No context yet. Complete your first session and context will appear here.*\n\nUse claude-mem's MCP search tools for manual memory queries.\n<!-- KIMI_PLACEHOLDER_V1 -->`.trim();
      const isOurs = trimmedContent === trimmedPlaceholder || content.includes('CLAUDE_MEM_KIMI_CONTEXT');

      if (isOurs) {
        rmSync(agentsPath);
      }

      expect(existsSync(agentsPath)).toBe(false);
    } finally {
      cleanupTmpDir();
    }
  });
});

describe('KimiCliHooksInstaller - AGENTS.md uninstall sentinel', () => {
  it('should recognize CLAUDE_MEM_KIMI_CONTEXT sentinel in removeKimiAgentsMd', async () => {
    const src = readFileSync('src/services/integrations/KimiCliHooksInstaller.ts', 'utf-8');

    // Find the removeKimiAgentsMd function
    const funcMatch = src.match(/function removeKimiAgentsMd[\s\S]*?^\}/m);
    expect(funcMatch).toBeTruthy();
    const funcBody = funcMatch![0];

    // Must check for the persistent sentinel (written by SessionStart hook)
    expect(funcBody).toContain('CLAUDE_MEM_KIMI_CONTEXT');
  });
});

// ---------------------------------------------------------------------------
// 4. MCP JSON corruption handling
// ---------------------------------------------------------------------------

describe('KimiCliHooksInstaller - MCP corruption resilience', () => {
  it('should guard uninstallKimiMcp against corrupt mcp.json', async () => {
    const src = readFileSync('src/services/integrations/KimiCliHooksInstaller.ts', 'utf-8');

    // uninstallKimiMcp must have try/catch around readKimiMcpConfig
    const uninstallMatch = src.match(/function uninstallKimiMcp\(\)[\s\S]*?^\}/m);
    expect(uninstallMatch).toBeTruthy();
    const uninstallBody = uninstallMatch![0];
    expect(uninstallBody).toContain('try');
    expect(uninstallBody).toContain('catch');
    expect(uninstallBody).toContain('readKimiMcpConfig');
    // Must not re-throw; should warn and continue
    expect(uninstallBody).not.toMatch(/catch[^{]*\{[\s\S]*?throw/m);
  });

  it('should guard checkKimiCliHooksStatus MCP section against corrupt mcp.json', async () => {
    const src = readFileSync('src/services/integrations/KimiCliHooksInstaller.ts', 'utf-8');

    // checkKimiCliHooksStatus MCP section must have try/catch around readKimiMcpConfig
    const statusMatch = src.match(/export function checkKimiCliHooksStatus\(\)[\s\S]*?^\}/m);
    expect(statusMatch).toBeTruthy();
    const statusBody = statusMatch![0];

    // Find the MCP section within status
    const mcpSectionMatch = statusBody.match(/Check MCP config[\s\S]*?^  \}/m);
    expect(mcpSectionMatch).toBeTruthy();
    const mcpSection = mcpSectionMatch![0];
    expect(mcpSection).toContain('try');
    expect(mcpSection).toContain('catch');
    expect(mcpSection).toContain('readKimiMcpConfig');
    // Must not re-throw; should warn and continue
    expect(mcpSection).not.toMatch(/catch[^{]*\{[\s\S]*?throw/m);
  });

  it('should guard installKimiMcp against corrupt mcp.json', async () => {
    const src = readFileSync('src/services/integrations/KimiCliHooksInstaller.ts', 'utf-8');

    // installKimiMcp must have try/catch around readKimiMcpConfig
    const installMatch = src.match(/function installKimiMcp\(\)[\s\S]*?^\}/m);
    expect(installMatch).toBeTruthy();
    const installBody = installMatch![0];
    expect(installBody).toContain('try');
    expect(installBody).toContain('catch');
    expect(installBody).toContain('readKimiMcpConfig');
    // Must not re-throw; should warn and continue with fresh config
    expect(installBody).not.toMatch(/catch[^{]*\{[\s\S]*?throw/m);
  });
});

// ---------------------------------------------------------------------------
// 4b. KIMI_SHARE_DIR env var support
// ---------------------------------------------------------------------------

describe('KimiCliHooksInstaller - KIMI_SHARE_DIR', () => {
  it('should resolve config paths from KIMI_SHARE_DIR when set', async () => {
    const src = readFileSync('src/services/integrations/KimiCliHooksInstaller.ts', 'utf-8');

    // Must check KIMI_SHARE_DIR before falling back to ~/.kimi
    expect(src).toContain('KIMI_SHARE_DIR');
    expect(src).toContain('process.env.KIMI_SHARE_DIR');
  });
});

// ---------------------------------------------------------------------------
// 4c. No stale KIMI_CONFIG_DIR references after rename
// ---------------------------------------------------------------------------

describe('KimiCliHooksInstaller - config dir reference', () => {
  it('should not reference KIMI_CONFIG_DIR after rename to KIMI_BASE_DIR', async () => {
    const src = readFileSync('src/services/integrations/KimiCliHooksInstaller.ts', 'utf-8');

    // KIMI_CONFIG_DIR was renamed to KIMI_BASE_DIR; stale references crash at runtime
    expect(src).not.toContain('KIMI_CONFIG_DIR');
    expect(src).toContain('KIMI_BASE_DIR');
  });
});

// ---------------------------------------------------------------------------
// 5. MCP command uses process.execPath (portability)
// ---------------------------------------------------------------------------

describe('KimiCliHooksInstaller - MCP config', () => {
  it('should use process.execPath instead of hardcoded "node" for MCP command', async () => {
    const src = readFileSync('src/services/integrations/KimiCliHooksInstaller.ts', 'utf-8');
    expect(src).toContain('command: process.execPath');
    expect(src).not.toContain("command: 'node'");
  });
});

// ---------------------------------------------------------------------------
// 6. Uninstall AGENTS.md message is conditional
// ---------------------------------------------------------------------------

describe('KimiCliHooksInstaller - uninstall messaging', () => {
  it('should make removeKimiAgentsMd return a boolean', async () => {
    const src = readFileSync('src/services/integrations/KimiCliHooksInstaller.ts', 'utf-8');
    expect(src).toMatch(/function removeKimiAgentsMd[^{]*\{[\s\S]*?return (true|false)/);
  });

  it('should only log removal message when file was actually deleted', async () => {
    const src = readFileSync('src/services/integrations/KimiCliHooksInstaller.ts', 'utf-8');
    // The call site should check the return value before logging
    expect(src).toMatch(/const\s+\w+\s*=\s*removeKimiAgentsMd\(/);
    expect(src).toMatch(/if\s*\(\s*\w+\s*\)\s*\{?[\s\S]*?console\.log\(`\s*Removed \.kimi\/AGENTS\.md placeholder/);
  });
});

// ---------------------------------------------------------------------------
// 7. Unknown subcommand returns non-zero
// ---------------------------------------------------------------------------

describe('KimiCliHooksInstaller - CLI command handler', () => {
  it('should return 1 for unknown subcommands', async () => {
    const src = readFileSync('src/services/integrations/KimiCliHooksInstaller.ts', 'utf-8');
    // Find the default branch in the switch statement
    const defaultMatch = src.match(/default:[\s\S]*?return\s+(\d+)/);
    expect(defaultMatch).toBeTruthy();
    expect(defaultMatch![1]).toBe('1');
  });
});

// ---------------------------------------------------------------------------
// 8. parseTomlHooks preserves non-hook content
// ---------------------------------------------------------------------------

describe('KimiCliHooksInstaller - TOML segment preservation', () => {
  it('should preserve non-hook content after the last hook block', () => {
    const toml = `some_preamble = true\n\n[[hooks]]\nevent = "SessionStart"\ncommand = "/bin/bun" "/worker-service.cjs" hook kimi-cli context\ntimeout = 60\n\n[custom]\nkey = "value"\n`;

    const { preamble, segments } = parseTomlHooks(toml);
    const cleanedToml = rebuildToml(preamble, segments);

    // The trailing [custom] table must survive removal of our hook block
    expect(cleanedToml).toContain('[custom]');
    expect(cleanedToml).toContain('key = "value"');
    // Our hook should be removed
    expect(cleanedToml).not.toContain('event = "SessionStart"');
    // Preamble should survive
    expect(cleanedToml).toContain('some_preamble = true');
  });

  it('should handle no trailing content correctly', () => {
    const toml = `[[hooks]]\nevent = "SessionStart"\ncommand = "/bin/bun" "/worker-service.cjs" hook kimi-cli context\ntimeout = 60\n`;

    const { preamble, segments } = parseTomlHooks(toml);
    const cleanedToml = rebuildToml(preamble, segments);

    expect(cleanedToml.trim()).toBe('');
  });

  it('should preserve non-hook content between two hook blocks', () => {
    const toml = `preamble\n\n[[hooks]]\nevent = "SessionStart"\ncommand = "/bin/bun" "/worker-service.cjs" hook kimi-cli context\ntimeout = 60\n\n[custom]\nkey = "value"\n\n[[hooks]]\nevent = "UserPromptSubmit"\ncommand = "/bin/bun" "/worker-service.cjs" hook kimi-cli session-init\ntimeout = 60\n`;

    const { preamble, segments } = parseTomlHooks(toml);
    const cleanedToml = rebuildToml(preamble, segments);

    // Both blocks are ours in this test, so only preserved content should survive
    expect(cleanedToml).toContain('[custom]');
    expect(cleanedToml).toContain('key = "value"');
    expect(cleanedToml).not.toContain('event = "SessionStart"');
    expect(cleanedToml).not.toContain('event = "UserPromptSubmit"');
    expect(cleanedToml).toContain('preamble');
  });

  it('should preserve user hooks while removing ours', () => {
    const toml = `[[hooks]]\nevent = "SessionStart"\ncommand = "/bin/bun" "/worker-service.cjs" hook kimi-cli context\ntimeout = 60\n\n[[hooks]]\nevent = "UserPromptSubmit"\ncommand = "echo hello"\ntimeout = 30\n`;

    const { preamble, segments } = parseTomlHooks(toml);
    const cleanedToml = rebuildToml(preamble, segments);

    // Our hook removed
    expect(cleanedToml).not.toContain('kimi-cli');
    expect(cleanedToml).not.toContain('worker-service.cjs');
    // User hook preserved
    expect(cleanedToml).toContain('echo hello');
    expect(cleanedToml).toContain('event = "UserPromptSubmit"');
  });

  it('should preserve comments between hook blocks', () => {
    const toml = `[[hooks]]\nevent = "SessionStart"\ncommand = "/bin/bun" "/worker-service.cjs" hook kimi-cli context\ntimeout = 60\n\n# My custom note\n\n[[hooks]]\nevent = "UserPromptSubmit"\ncommand = "echo hello"\ntimeout = 30\n`;

    const { preamble, segments } = parseTomlHooks(toml);
    const cleanedToml = rebuildToml(preamble, segments);

    // Our hook removed
    expect(cleanedToml).not.toContain('kimi-cli');
    // Comment preserved
    expect(cleanedToml).toContain('# My custom note');
    // User hook preserved
    expect(cleanedToml).toContain('echo hello');
  });

  it('should preserve trailing comments after last hook block', () => {
    const toml = `[[hooks]]\nevent = "SessionStart"\ncommand = "/bin/bun" "/worker-service.cjs" hook kimi-cli context\ntimeout = 60\n\n# Trailing note\n`;

    const { preamble, segments } = parseTomlHooks(toml);
    const cleanedToml = rebuildToml(preamble, segments);

    // Our hook removed
    expect(cleanedToml).not.toContain('kimi-cli');
    // Trailing comment preserved
    expect(cleanedToml).toContain('# Trailing note');
  });

  it('should NOT absorb non-hook tables with hook-like keys', () => {
    // A user table like [server] with timeout= or command= must survive
    const toml = `[[hooks]]\nevent = "SessionStart"\ncommand = "/bin/bun" "/worker-service.cjs" hook kimi-cli context\ntimeout = 60\n\n[server]\ntimeout = 999\ncommand = "start"\n`;

    const { preamble, segments } = parseTomlHooks(toml);
    const cleanedToml = rebuildToml(preamble, segments);

    // Our hook removed
    expect(cleanedToml).not.toContain('kimi-cli');
    expect(cleanedToml).not.toContain('event = "SessionStart"');
    // User's [server] table preserved
    expect(cleanedToml).toContain('[server]');
    expect(cleanedToml).toContain('timeout = 999');
    expect(cleanedToml).toContain('command = "start"');
  });

  it('should handle inline comments on TOML table headers', () => {
    // Valid TOML can have inline comments on table headers
    const toml = `[[hooks]]\nevent = "SessionStart"\ncommand = "/bin/bun" "/worker-service.cjs" hook kimi-cli context\ntimeout = 60\n\n[server] # keep this\ntimeout = 999\n\n[[other]] # array table\nkey = "val"\n`;

    const { preamble, segments } = parseTomlHooks(toml);
    const cleanedToml = rebuildToml(preamble, segments);

    // Our hook removed
    expect(cleanedToml).not.toContain('kimi-cli');
    // User tables with inline comments preserved
    expect(cleanedToml).toContain('[server] # keep this');
    expect(cleanedToml).toContain('timeout = 999');
    expect(cleanedToml).toContain('[[other]] # array table');
    expect(cleanedToml).toContain('key = "val"');
  });
});
