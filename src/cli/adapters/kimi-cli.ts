import type { PlatformAdapter, NormalizedHookInput, HookResult } from '../types.js';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

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

const KIMI_AGENTS_MD_SENTINEL = 'KIMI_PLACEHOLDER_V1';

function writeKimiAgentsMdContext(additionalContext: string): void {
  if (!additionalContext || !additionalContext.trim()) return;
  const agentsMdPath = path.join(process.cwd(), '.kimi', 'AGENTS.md');
  if (existsSync(agentsMdPath)) {
    const content = readFileSync(agentsMdPath, 'utf-8');
    if (!content.includes(KIMI_AGENTS_MD_SENTINEL)) {
      // User has edited the file — don't overwrite
      return;
    }
  }
  writeFileSync(agentsMdPath, additionalContext.trim() + '\n');
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
    const toolInput: unknown = r.tool_input;
    let toolResponse: unknown = r.tool_output;

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
        output.hookSpecificOutput.updatedInput = hso.updatedInput;
      }
    }

    return output;
  },
};
