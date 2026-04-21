import { describe, it, expect } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
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

describe('kimiCliAdapter - AGENTS.md context sync', () => {
  const originalCwd = process.cwd();

  const setupTmpDir = () => {
    const tmpDir = join(tmpdir(), `kimi-adapter-test-${Date.now()}`);
    mkdirSync(join(tmpDir, '.kimi'), { recursive: true });
    process.chdir(tmpDir);
    return tmpDir;
  };

  const cleanupTmpDir = (tmpDir: string) => {
    process.chdir(originalCwd);
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  };

  it('should write additionalContext to .kimi/AGENTS.md on SessionStart', () => {
    const tmpDir = setupTmpDir();
    try {
      const placeholder = `# Memory Context from Past Sessions\n\n*No context yet.*\n<!-- KIMI_PLACEHOLDER_V1 -->`;
      writeFileSync(join(tmpDir, '.kimi', 'AGENTS.md'), placeholder);

      const result = {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: '# Previous Session\n\nWe discussed TOML parsing.',
        },
      };
      kimiCliAdapter.formatOutput(result as any);

      const content = readFileSync(join(tmpDir, '.kimi', 'AGENTS.md'), 'utf-8');
      expect(content).toContain('# Previous Session');
      expect(content).toContain('TOML parsing');
      expect(content).not.toContain('No context yet');
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  it('should NOT overwrite user-edited AGENTS.md without sentinel', () => {
    const tmpDir = setupTmpDir();
    try {
      const userContent = '# My Custom Rules\n\nAlways use TypeScript.';
      writeFileSync(join(tmpDir, '.kimi', 'AGENTS.md'), userContent);

      const result = {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: '# Previous Session\n\nWe discussed TOML parsing.',
        },
      };
      kimiCliAdapter.formatOutput(result as any);

      const content = readFileSync(join(tmpDir, '.kimi', 'AGENTS.md'), 'utf-8');
      expect(content).toBe(userContent);
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  it('should NOT write when additionalContext is empty', () => {
    const tmpDir = setupTmpDir();
    try {
      const placeholder = `# Memory Context from Past Sessions\n\n*No context yet.*\n<!-- KIMI_PLACEHOLDER_V1 -->`;
      writeFileSync(join(tmpDir, '.kimi', 'AGENTS.md'), placeholder);

      const result = {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: '',
        },
      };
      kimiCliAdapter.formatOutput(result as any);

      const content = readFileSync(join(tmpDir, '.kimi', 'AGENTS.md'), 'utf-8');
      expect(content).toBe(placeholder);
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  it('should NOT write on non-SessionStart events', () => {
    const tmpDir = setupTmpDir();
    try {
      const placeholder = `# Memory Context from Past Sessions\n\n*No context yet.*\n<!-- KIMI_PLACEHOLDER_V1 -->`;
      writeFileSync(join(tmpDir, '.kimi', 'AGENTS.md'), placeholder);

      const result = {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: '# Previous Session\n\nSome context.',
        },
      };
      kimiCliAdapter.formatOutput(result as any);

      const content = readFileSync(join(tmpDir, '.kimi', 'AGENTS.md'), 'utf-8');
      expect(content).toBe(placeholder);
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  it('should refresh AGENTS.md on subsequent SessionStart calls', () => {
    const tmpDir = setupTmpDir();
    try {
      const placeholder = `# Memory Context from Past Sessions\n\n*No context yet.*\n<!-- KIMI_PLACEHOLDER_V1 -->`;
      writeFileSync(join(tmpDir, '.kimi', 'AGENTS.md'), placeholder);

      // First SessionStart
      const result1 = {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: '# Session 1\n\nDiscussed parsing.',
        },
      };
      kimiCliAdapter.formatOutput(result1 as any);
      const content1 = readFileSync(join(tmpDir, '.kimi', 'AGENTS.md'), 'utf-8');
      expect(content1).toContain('# Session 1');

      // Second SessionStart — must refresh, not skip
      const result2 = {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: '# Session 2\n\nDiscussed escaping.',
        },
      };
      kimiCliAdapter.formatOutput(result2 as any);
      const content2 = readFileSync(join(tmpDir, '.kimi', 'AGENTS.md'), 'utf-8');
      expect(content2).toContain('# Session 2');
      expect(content2).toContain('escaping');
      expect(content2).not.toContain('# Session 1');
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  it('should create .kimi directory if missing before writing AGENTS.md', () => {
    const tmpDir = join(tmpdir(), `kimi-adapter-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    process.chdir(tmpDir);
    try {
      // Do NOT create .kimi/ — it doesn't exist
      const result = {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: '# Previous Session\n\nSome context.',
        },
      };

      // Should not throw
      expect(() => kimiCliAdapter.formatOutput(result as any)).not.toThrow();

      // File should exist
      expect(existsSync(join(tmpDir, '.kimi', 'AGENTS.md'))).toBe(true);
      const content = readFileSync(join(tmpDir, '.kimi', 'AGENTS.md'), 'utf-8');
      expect(content).toContain('Some context');
    } finally {
      process.chdir(originalCwd);
      if (existsSync(tmpDir)) {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  });
});
