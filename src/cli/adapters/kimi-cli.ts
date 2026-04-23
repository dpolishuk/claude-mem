import type { PlatformAdapter, NormalizedHookInput, HookResult } from '../types.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { logger } from '../../utils/logger.js';

/**
 * Kimi CLI Platform Adapter
 *
 * Normalizes Kimi CLI's hook JSON payload to NormalizedHookInput.
 * Kimi CLI supports 13 lifecycle hook events; we register 7 that map to
 * useful memory events.
 *
 * Lifecycle:
 *   SessionStart      → context      (write past-session context to .kimi/AGENTS.md)
 *   UserPromptSubmit  → session-init (initialize session, capture prompt)
 *   PreToolUse        → file-context (inject file observation history before Read)
 *   PostToolUse       → observation  (capture tool result)
 *   PostToolUseFailure → observation (capture failed tool)
 *   Stop              → summarize    (generate summary)
 *   SessionEnd        → session-complete (finalize session)
 *
 * Unmapped (not useful for memory):
 *   SubagentStart, SubagentStop — subagent activity, too chatty
 *   PreCompact, PostCompact     — context compaction, not actionable
 *   Notification                — system notifications, rarely useful
 *   StopFailure                 — error state, not a memory event
 *
 * Base fields (all events): hook_event_name, session_id, cwd
 *
 * Output format: Kimi CLI hooks only respect action="block"/"allow" and
 * reason for blocking. Context injection is NOT supported via hook stdout;
 * we write to .kimi/AGENTS.md instead.
 */

const KIMI_AGENTS_MD_SENTINEL = 'CLAUDE_MEM_KIMI_CONTEXT';

function writeKimiAgentsMdContext(additionalContext: string): void {
  if (!additionalContext || !additionalContext.trim()) return;
  try {
    const agentsMdPath = path.join(process.cwd(), '.kimi', 'AGENTS.md');
    if (existsSync(agentsMdPath)) {
      const content = readFileSync(agentsMdPath, 'utf-8');
      // Recognize both the installer placeholder and previously written context
      if (!content.includes(KIMI_AGENTS_MD_SENTINEL) && !content.includes('KIMI_PLACEHOLDER_V1')) {
        // User has edited the file — don't overwrite
        return;
      }
    }
    mkdirSync(path.dirname(agentsMdPath), { recursive: true });
    const body = additionalContext.trim() + '\n\n---\n*Context automatically updated by claude-mem*\n<!-- ' + KIMI_AGENTS_MD_SENTINEL + ' -->\n';
    writeFileSync(agentsMdPath, body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('KIMI_ADAPTER', `Could not write Kimi AGENTS.md context: ${message}`);
  }
}

export const kimiCliAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as any;
    const hookEventName: string = r.hook_event_name ?? '';

    const base: NormalizedHookInput = {
      sessionId: r.session_id,
      cwd: r.cwd ?? process.cwd(),
      platform: 'kimi-cli',
    };

    // Tool fields — present in PreToolUse, PostToolUse, PostToolUseFailure
    const toolName: string | undefined = r.tool_name;
    let toolInput: unknown = r.tool_input;
    let toolResponse: unknown = r.tool_output;

    // Map Kimi ReadFile-style fields to internal schema expected by handlers.
    // Kimi uses: path, line_offset, n_lines
    // Internal uses: file_path, offset, limit
    if (toolInput && typeof toolInput === 'object') {
      const ti = toolInput as Record<string, unknown>;
      const mapped: Record<string, unknown> = { ...ti };
      if (ti.path !== undefined && ti.file_path === undefined) {
        mapped.file_path = ti.path;
      }
      if (ti.line_offset !== undefined && ti.offset === undefined) {
        mapped.offset = ti.line_offset;
      }
      if (ti.n_lines !== undefined && ti.limit === undefined) {
        mapped.limit = ti.n_lines;
      }
      toolInput = mapped;
    }

    if (hookEventName === 'PostToolUseFailure') {
      toolResponse = { error: r.error };
    }

    // Collect platform-specific metadata
    const metadata: Record<string, unknown> = {};
    if (r.source !== undefined) metadata.source = r.source;
    if (r.reason !== undefined) metadata.reason = r.reason;
    if (r.trigger !== undefined) metadata.trigger = r.trigger;
    if (r.token_count !== undefined) metadata.token_count = r.token_count;
    if (r.estimated_token_count !== undefined) metadata.estimated_token_count = r.estimated_token_count;
    if (r.stop_hook_active !== undefined) metadata.stop_hook_active = r.stop_hook_active;
    if (r.error_type !== undefined) metadata.error_type = r.error_type;
    if (r.error_message !== undefined) metadata.error_message = r.error_message;
    if (r.agent_name !== undefined) metadata.agent_name = r.agent_name;
    if (r.sink !== undefined) metadata.sink = r.sink;
    if (r.notification_type !== undefined) metadata.notification_type = r.notification_type;
    if (r.tool_call_id !== undefined) metadata.tool_call_id = r.tool_call_id;
    if (hookEventName) metadata.hook_event_name = hookEventName;

    return {
      ...base,
      prompt: r.prompt,
      toolName,
      toolInput,
      toolResponse,
      transcriptPath: r.transcript_path,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
  },

  formatOutput(result) {
    const hso = result.hookSpecificOutput;

    // Write past-session context to .kimi/AGENTS.md on SessionStart.
    // Kimi CLI does not support hook stdout for context injection,
    // so we use the project-level AGENTS.md file instead.
    if (hso?.hookEventName === 'SessionStart' && hso?.additionalContext) {
      writeKimiAgentsMdContext(hso.additionalContext);
    }

    // Kimi CLI respects blocking decisions and updatedInput from hook stdout.
    const output: Record<string, unknown> = {};
    if (hso?.permissionDecision) {
      output.hookSpecificOutput = {
        permissionDecision: hso.permissionDecision,
      };
      if (hso.permissionDecision === 'deny') {
        output.hookSpecificOutput.permissionDecisionReason = hso.permissionDecisionReason ?? '';
      }
      if (hso.updatedInput) {
        // Don't forward updatedInput when additionalContext is present on non-SessionStart,
        // because the updatedInput (e.g. limit=1) was designed to be paired with
        // additionalContext timeline, which Kimi CLI cannot receive via hook stdout.
        const hasDroppedContext = hso.additionalContext && hso.hookEventName !== 'SessionStart';
        if (!hasDroppedContext) {
          // Map internal fields back to Kimi schema.
          // Internal uses: file_path, offset, limit
          // Kimi uses: path, line_offset, n_lines
          const ui = hso.updatedInput as Record<string, unknown>;
          const mapped: Record<string, unknown> = { ...ui };
          if (ui.file_path !== undefined && ui.path === undefined) {
            mapped.path = ui.file_path;
          }
          if (ui.offset !== undefined && ui.line_offset === undefined) {
            mapped.line_offset = ui.offset;
          }
          if (ui.limit !== undefined && ui.n_lines === undefined) {
            mapped.n_lines = ui.limit;
          }
          output.hookSpecificOutput.updatedInput = mapped;
        }
      }
    }

    return output;
  },
};
