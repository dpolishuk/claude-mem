import { describe, it, expect } from 'bun:test';
import { kimiCliAdapter } from '../src/cli/adapters/kimi-cli.js';

describe('kimiCliAdapter - normalizeInput', () => {
  it('should forward transcript_path when present', () => {
    const input = {
      hook_event_name: 'Stop',
      session_id: 'sess-123',
      cwd: '/tmp',
      transcript_path: '/tmp/transcript.json',
    };
    const normalized = kimiCliAdapter.normalizeInput(input);
    expect(normalized.transcriptPath).toBe('/tmp/transcript.json');
  });

  it('should omit transcript_path when absent', () => {
    const input = {
      hook_event_name: 'Stop',
      session_id: 'sess-123',
      cwd: '/tmp',
    };
    const normalized = kimiCliAdapter.normalizeInput(input);
    expect(normalized.transcriptPath).toBeUndefined();
  });
});

describe('kimiCliAdapter - formatOutput', () => {
  it('should forward deny decision with reason', () => {
    const result = {
      continue: true,
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: 'User declined',
      },
    };
    const output = kimiCliAdapter.formatOutput(result as any);
    expect(output).toEqual({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: 'User declined',
      },
    });
  });

  it('should forward allow decision with updatedInput', () => {
    const result = {
      continue: true,
      hookSpecificOutput: {
        permissionDecision: 'allow',
        updatedInput: { file_path: '/tmp/test.txt', limit: 1 },
      },
    };
    const output = kimiCliAdapter.formatOutput(result as any);
    expect(output).toEqual({
      hookSpecificOutput: {
        permissionDecision: 'allow',
        updatedInput: { file_path: '/tmp/test.txt', limit: 1 },
      },
    });
  });

  it('should forward allow decision without updatedInput', () => {
    const result = {
      continue: true,
      hookSpecificOutput: {
        permissionDecision: 'allow',
      },
    };
    const output = kimiCliAdapter.formatOutput(result as any);
    expect(output).toEqual({
      hookSpecificOutput: {
        permissionDecision: 'allow',
      },
    });
  });

  it('should return empty object when no hookSpecificOutput', () => {
    const result = { continue: true };
    const output = kimiCliAdapter.formatOutput(result as any);
    expect(output).toEqual({});
  });

  it('should pass through unknown permissionDecision values', () => {
    const result = {
      continue: true,
      hookSpecificOutput: {
        permissionDecision: 'maybe',
      },
    };
    const output = kimiCliAdapter.formatOutput(result as any);
    expect(output).toEqual({
      hookSpecificOutput: {
        permissionDecision: 'maybe',
      },
    });
  });
});
