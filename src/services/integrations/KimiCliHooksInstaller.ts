/**
 * KimiCliHooksInstaller - Kimi CLI integration for claude-mem
 *
 * Installs hooks into ~/.kimi/config.toml using the unified CLI:
 *   bun worker-service.cjs hook kimi-cli <event>
 *
 * This routes through the hook-command.ts framework:
 *   readJsonFromStdin() → kimi-cli adapter → event handler → POST to worker
 *
 * Kimi CLI supports 13 lifecycle hooks; we register 6 that map to
 * useful memory events. See src/cli/adapters/kimi-cli.ts for the adapter.
 *
 * Context injection is handled via .kimi/AGENTS.md (project-level),
 * since Kimi CLI does not support hook stdout for context injection.
 *
 * MCP config is also installed to ~/.kimi/mcp.json for manual search tools.
 */

import path from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { findWorkerServicePath, findBunPath, findMcpServerPath } from './CursorHooksInstaller.js';
import { readJsonSafe } from '../../utils/json-utils.js';

// ============================================================================
// Types
// ============================================================================

interface KimiHookDef {
  event: string;
  command: string;
  matcher?: string;
  timeout: number;
}

interface KimiMcpConfig {
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
}

// ============================================================================
// Constants
// ============================================================================

const KIMI_CONFIG_DIR = path.join(homedir(), '.kimi');
const KIMI_CONFIG_PATH = path.join(KIMI_CONFIG_DIR, 'config.toml');
const KIMI_MCP_PATH = path.join(KIMI_CONFIG_DIR, 'mcp.json');

const HOOK_COMMAND_SIGNATURE = 'worker-service.cjs';
const KIMI_PLATFORM_SIGNATURE = 'kimi-cli';

/**
 * Mapping from Kimi CLI hook events to internal claude-mem event types.
 *
 * Events NOT mapped (not useful for memory):
 *   SessionStart              — generates context but Kimi CLI can't read
 *                               systemMessage from hook stdout, so it's wasteful
 *   SubagentStart, SubagentStop — subagent activity, too chatty
 *   PreCompact, PostCompact     — context compaction events
 *   Notification                — system notifications, rarely useful
 *   StopFailure                 — error state, not a memory event
 */
const KIMI_EVENT_TO_INTERNAL_EVENT: Record<string, string> = {
  'UserPromptSubmit': 'session-init',
  'PreToolUse': 'file-context',
  'PostToolUse': 'observation',
  'PostToolUseFailure': 'observation',
  'Stop': 'summarize',
  'SessionEnd': 'session-complete',
};

/** Matchers for specific hooks */
const KIMI_EVENT_MATCHERS: Record<string, string> = {
  'PreToolUse': 'Read',
};

/** Timeouts per event type (seconds, matching Kimi CLI HookDef pydantic max 600) */
const KIMI_EVENT_TIMEOUTS: Record<string, number> = {
  'UserPromptSubmit': 60,
  'PreToolUse': 2,
  'PostToolUse': 120,
  'PostToolUseFailure': 120,
  'Stop': 120,
  'SessionEnd': 30,
};

// ============================================================================
// TOML Helpers
// ============================================================================

/**
 * Parse a TOML file into preamble and segments.
 *
 * Each segment is either a hook block (with ownership flag) or preserved
 * interstitial content (comments, table headers, blank lines, etc.) that
 * sits between hook blocks or after the last block. This prevents data loss
 * when removing claude-mem hooks from a TOML file that contains user settings.
 *
 * A block ends at the last hook property line (event/command/matcher/timeout).
 * Everything after that line — comments, blank lines, table headers — is
 * treated as preserved interstitial or trailing content.
 */
export function parseTomlHooks(toml: string): {
  preamble: string;
  segments: Array<{ type: 'block' | 'preserved'; text: string; isOurs?: boolean }>;
} {
  const hookMarker = '[[hooks]]';
  const firstHookIdx = toml.indexOf(hookMarker);

  if (firstHookIdx === -1) {
    return { preamble: toml, segments: [] };
  }

  const preamble = toml.slice(0, firstHookIdx);
  let remaining = toml.slice(firstHookIdx);
  const segments: Array<{ type: 'block' | 'preserved'; text: string; isOurs?: boolean }> = [];

  while (remaining.includes(hookMarker)) {
    const nextHookIdx = remaining.indexOf(hookMarker, hookMarker.length);
    const rawChunk = nextHookIdx === -1 ? remaining : remaining.slice(0, nextHookIdx);

    const { block, trailing } = splitHookBlock(rawChunk);
    const isOurs =
      block.includes(HOOK_COMMAND_SIGNATURE) && block.includes(KIMI_PLATFORM_SIGNATURE);
    segments.push({ type: 'block', text: block, isOurs });

    if (trailing) {
      segments.push({ type: 'preserved', text: trailing });
    }

    remaining = nextHookIdx === -1 ? '' : remaining.slice(nextHookIdx);
  }

  return { preamble, segments };
}

/**
 * Split a raw chunk (from [[hooks]] to next [[hooks]] or EOF) into the
 * actual hook block and any trailing/interstitial content.
 *
 * The block ends at the last line containing a hook property
 * (event, command, matcher, timeout). Everything after that line is preserved.
 */
function splitHookBlock(chunk: string): { block: string; trailing: string } {
  // Find the first section boundary after the initial [[hooks]] line.
  // This prevents matching hook-like keys (e.g. timeout=, command=) inside
  // user tables (e.g. [server]) that appear after a hook block.
  const lines = chunk.split('\n');
  let boundaryLineIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('#')) continue;
    // Match [[array_of_tables]] or [standard_table] (allow inline comments)
    if (/^\[\[.+\]\]/.test(trimmed) || /^\[.+\]/.test(trimmed)) {
      boundaryLineIndex = i;
      break;
    }
  }

  const searchChunk =
    boundaryLineIndex === -1 ? chunk : lines.slice(0, boundaryLineIndex).join('\n');

  const hookPropertyPattern = /^\s*(event|command|matcher|timeout)\s*=/gm;
  let lastMatchEnd = -1;
  let match: RegExpExecArray | null;

  while ((match = hookPropertyPattern.exec(searchChunk)) !== null) {
    lastMatchEnd = match.index + match[0].length;
  }

  if (lastMatchEnd === -1) {
    return { block: chunk, trailing: '' };
  }

  const lineEnd = chunk.indexOf('\n', lastMatchEnd);
  if (lineEnd === -1) {
    return { block: chunk, trailing: '' };
  }

  return {
    block: chunk.slice(0, lineEnd + 1),
    trailing: chunk.slice(lineEnd + 1),
  };
}

export function rebuildToml(
  preamble: string,
  segments: Array<{ type: 'block' | 'preserved'; text: string; isOurs?: boolean }>,
): string {
  const kept = segments
    .filter((s) => s.type === 'preserved' || (s.type === 'block' && !s.isOurs))
    .map((s) => s.text);
  return (preamble + kept.join('')).trimEnd();
}

function buildHookBlock(def: KimiHookDef): string {
  const lines = ['[[hooks]]', `event = "${def.event}"`, `command = ${JSON.stringify(def.command)}`];
  if (def.matcher) {
    lines.push(`matcher = ${JSON.stringify(def.matcher)}`);
  }
  lines.push(`timeout = ${def.timeout}`);
  return lines.join('\n');
}

// ============================================================================
// Hook Command Builder
// ============================================================================

function buildHookCommand(
  bunPath: string,
  workerServicePath: string,
  kimiEventName: string,
): string {
  const internalEvent = KIMI_EVENT_TO_INTERNAL_EVENT[kimiEventName];
  if (!internalEvent) {
    throw new Error(`Unknown Kimi CLI event: ${kimiEventName}`);
  }

  // Escape backslashes for Windows paths inside TOML strings
  const escapedBunPath = bunPath.replace(/\\/g, '\\\\');
  const escapedWorkerPath = workerServicePath.replace(/\\/g, '\\\\');

  return `"${escapedBunPath}" "${escapedWorkerPath}" hook kimi-cli ${internalEvent}`;
}

// ============================================================================
// Config File Management
// ============================================================================

function readKimiConfig(): string {
  if (!existsSync(KIMI_CONFIG_PATH)) return '';
  return readFileSync(KIMI_CONFIG_PATH, 'utf-8');
}

function writeKimiConfig(content: string): void {
  mkdirSync(KIMI_CONFIG_DIR, { recursive: true });
  writeFileSync(KIMI_CONFIG_PATH, content.trimEnd() + '\n');
}

function readKimiMcpConfig(): KimiMcpConfig {
  if (!existsSync(KIMI_MCP_PATH)) return {};
  return readJsonSafe<KimiMcpConfig>(KIMI_MCP_PATH, {});
}

function writeKimiMcpConfig(config: KimiMcpConfig): void {
  mkdirSync(KIMI_CONFIG_DIR, { recursive: true });
  writeFileSync(KIMI_MCP_PATH, JSON.stringify(config, null, 2) + '\n');
}

// ============================================================================
// AGENTS.md Context
// ============================================================================

const AGENTS_MD_PLACEHOLDER = `# Memory Context from Past Sessions

*No context yet. Complete your first session and context will appear here.*

Use claude-mem's MCP search tools for manual memory queries.
<!-- KIMI_PLACEHOLDER_V1 -->
`;

function setupKimiAgentsMd(workspaceRoot: string): void {
  const kimiDir = path.join(workspaceRoot, '.kimi');
  const agentsMdPath = path.join(kimiDir, 'AGENTS.md');

  if (existsSync(agentsMdPath)) {
    // Already exists — leave it alone (may have real context or user content)
    return;
  }

  mkdirSync(kimiDir, { recursive: true });
  writeFileSync(agentsMdPath, AGENTS_MD_PLACEHOLDER);
}

function removeKimiAgentsMd(workspaceRoot: string): boolean {
  const agentsMdPath = path.join(workspaceRoot, '.kimi', 'AGENTS.md');
  if (!existsSync(agentsMdPath)) return false;

  const content = readFileSync(agentsMdPath, 'utf-8');
  const trimmedContent = content.trim();
  const trimmedPlaceholder = AGENTS_MD_PLACEHOLDER.trim();

  // Only remove if it's an exact placeholder match.
  // If the user has edited the file in any way (even keeping the sentinel),
  // we preserve it to avoid data loss.
  if (trimmedContent === trimmedPlaceholder) {
    unlinkSync(agentsMdPath);
    return true;
  }
  return false;
}

// ============================================================================
// MCP Config
// ============================================================================

function installKimiMcp(): void {
  const mcpServerPath = findMcpServerPath();
  if (!mcpServerPath) {
    console.warn('  Warning: Could not find MCP server script, skipping MCP config');
    return;
  }

  const config = readKimiMcpConfig();
  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  config.mcpServers['claude-mem'] = {
    command: process.execPath,
    args: [mcpServerPath],
  };

  writeKimiMcpConfig(config);
  console.log(`  MCP config written to ${KIMI_MCP_PATH}`);
}

function uninstallKimiMcp(): void {
  if (!existsSync(KIMI_MCP_PATH)) return;

  const config = readKimiMcpConfig();
  if (config.mcpServers?.['claude-mem']) {
    delete config.mcpServers['claude-mem'];
    if (Object.keys(config.mcpServers).length === 0) {
      delete config.mcpServers;
    }
    writeKimiMcpConfig(config);
    console.log(`  Removed claude-mem from ${KIMI_MCP_PATH}`);
  }
}

// ============================================================================
// Public API — Install
// ============================================================================

/**
 * Install claude-mem hooks into ~/.kimi/config.toml.
 *
 * Merges hooks non-destructively: existing settings and non-claude-mem
 * hooks are preserved. Existing claude-mem hooks are replaced.
 *
 * @returns 0 on success, 1 on failure
 */
export async function installKimiCliHooks(): Promise<number> {
  console.log('\nInstalling Claude-Mem Kimi CLI hooks...\n');

  const workerServicePath = findWorkerServicePath();
  if (!workerServicePath) {
    console.error('Could not find worker-service.cjs');
    console.error('   Expected at: ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs');
    return 1;
  }

  const bunPath = findBunPath();
  console.log(`  Using Bun runtime: ${bunPath}`);
  console.log(`  Worker service: ${workerServicePath}`);

  try {
    // Build hook definitions
    const hookDefs: KimiHookDef[] = [];
    for (const kimiEvent of Object.keys(KIMI_EVENT_TO_INTERNAL_EVENT)) {
      const command = buildHookCommand(bunPath, workerServicePath, kimiEvent);
      hookDefs.push({
        event: kimiEvent,
        command,
        matcher: KIMI_EVENT_MATCHERS[kimiEvent],
        timeout: KIMI_EVENT_TIMEOUTS[kimiEvent] ?? 30,
      });
    }

    // Read existing TOML and merge
    const existingToml = readKimiConfig();
    const { preamble, segments } = parseTomlHooks(existingToml);
    const cleanedToml = rebuildToml(preamble, segments);

    const newBlocks = hookDefs.map(buildHookBlock).join('\n\n');
    const mergedToml = cleanedToml + '\n\n' + newBlocks + '\n';

    writeKimiConfig(mergedToml);
    console.log(`  Merged hooks into ${KIMI_CONFIG_PATH}`);

    // MCP config
    installKimiMcp();

    // Project-level AGENTS.md
    const workspaceRoot = process.cwd();
    setupKimiAgentsMd(workspaceRoot);
    console.log(`  Setup context injection in .kimi/AGENTS.md`);

    const eventNames = Object.keys(KIMI_EVENT_TO_INTERNAL_EVENT);
    console.log(`  Registered ${eventNames.length} hook events:`);
    for (const event of eventNames) {
      const internalEvent = KIMI_EVENT_TO_INTERNAL_EVENT[event];
      const matcher = KIMI_EVENT_MATCHERS[event];
      const timeout = KIMI_EVENT_TIMEOUTS[event];
      const extra = matcher ? ` (matcher="${matcher}")` : '';
      console.log(`    ${event} → ${internalEvent}${extra} [${timeout}s]`);
    }

    console.log(`
Installation complete!

Hooks installed to: ${KIMI_CONFIG_PATH}
MCP config:         ${KIMI_MCP_PATH}
Using unified CLI:  bun worker-service.cjs hook kimi-cli <event>

Next steps:
  1. Start claude-mem worker: npx claude-mem start
  2. Restart Kimi CLI to load the hooks
  3. Memory will be captured automatically during sessions

Context Injection:
  Context from past sessions is injected via .kimi/AGENTS.md
  and automatically included in Kimi CLI conversations.
`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nInstallation failed: ${message}`);
    return 1;
  }
}

// ============================================================================
// Public API — Uninstall
// ============================================================================

/**
 * Uninstall claude-mem hooks from ~/.kimi/config.toml.
 *
 * Removes only claude-mem hooks — other hooks and settings are preserved.
 *
 * @returns 0 on success, 1 on failure
 */
export function uninstallKimiCliHooks(): number {
  console.log('\nUninstalling Claude-Mem Kimi CLI hooks...\n');

  let removedHooks = false;

  // Remove hooks from config.toml
  if (existsSync(KIMI_CONFIG_PATH)) {
    try {
      const existingToml = readKimiConfig();
      const { preamble, segments } = parseTomlHooks(existingToml);
      const hadOurs = segments.some((s) => s.type === 'block' && s.isOurs);
      const cleanedToml = rebuildToml(preamble, segments);

      if (hadOurs) {
        writeKimiConfig(cleanedToml);
        console.log(`  Removed claude-mem hooks from ${KIMI_CONFIG_PATH}`);
        removedHooks = true;
      } else {
        console.log(`  No claude-mem hooks found in ${KIMI_CONFIG_PATH}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  Warning: could not parse config.toml: ${message}`);
    }
  } else {
    console.log(`  No Kimi CLI config found`);
  }

  // Remove MCP config
  uninstallKimiMcp();

  // Remove AGENTS.md
  const workspaceRoot = process.cwd();
  const removedAgents = removeKimiAgentsMd(workspaceRoot);
  if (removedAgents) {
    console.log(`  Removed .kimi/AGENTS.md placeholder`);
  }

  console.log('\nUninstallation complete!\n');
  console.log('Restart Kimi CLI to apply changes.');
  return 0;
}

// ============================================================================
// Public API — Status
// ============================================================================

/**
 * Check Kimi CLI hooks installation status.
 *
 * @returns 0 always (informational)
 */
export function checkKimiCliHooksStatus(): number {
  console.log('\nClaude-Mem Kimi CLI Hooks Status\n');

  let anyInstalled = false;

  // Check hooks in config.toml
  if (existsSync(KIMI_CONFIG_PATH)) {
    try {
      const toml = readKimiConfig();
      const { segments } = parseTomlHooks(toml);
      const ourBlocks = segments.filter((s) => s.type === 'block' && s.isOurs);

      if (ourBlocks.length > 0) {
        anyInstalled = true;
        console.log(`Hooks: Installed (${ourBlocks.length} events)`);
        console.log(`  Config: ${KIMI_CONFIG_PATH}`);
      } else {
        console.log(`Hooks: Not installed`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`Hooks: Unable to parse config.toml (${message})`);
    }
  } else {
    console.log(`Hooks: Config file not found`);
  }

  // Check MCP config
  if (existsSync(KIMI_MCP_PATH)) {
    const config = readKimiMcpConfig();
    if (config.mcpServers?.['claude-mem']) {
      anyInstalled = true;
      console.log(`MCP:    Installed`);
      console.log(`  Config: ${KIMI_MCP_PATH}`);
    } else {
      console.log(`MCP:    Not installed`);
    }
  } else {
    console.log(`MCP:    Config file not found`);
  }

  // Check AGENTS.md
  const agentsMdPath = path.join(process.cwd(), '.kimi', 'AGENTS.md');
  if (existsSync(agentsMdPath)) {
    console.log(`Context: Active (.kimi/AGENTS.md)`);
  } else {
    console.log(`Context: Not yet generated`);
  }

  if (!anyInstalled) {
    console.log('\nNo claude-mem integration found. Run: npx claude-mem install --ide kimi-cli\n');
  }

  console.log('');
  return 0;
}

// ============================================================================
// Command Handler
// ============================================================================

/**
 * Handle kimi-cli subcommand for hooks management.
 */
export async function handleKimiCliCommand(subcommand: string, _args: string[]): Promise<number> {
  switch (subcommand) {
    case 'install':
      return installKimiCliHooks();

    case 'uninstall':
      return uninstallKimiCliHooks();

    case 'status':
      return checkKimiCliHooksStatus();

    default:
      console.log(`
Claude-Mem Kimi CLI Integration

Usage: claude-mem kimi-cli <command>

Commands:
  install     Install hooks into ~/.kimi/config.toml
  uninstall   Remove claude-mem hooks
  status      Check installation status

Examples:
  claude-mem kimi-cli install     # Install hooks
  claude-mem kimi-cli status      # Check if installed
  claude-mem kimi-cli uninstall   # Remove hooks

For more info: https://docs.claude-mem.ai/kimi-cli
      `);
      return 1;
  }
}
