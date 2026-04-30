import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/shared/config.js';
import type { CommandRunner } from '../src/shared/types.js';
import {
  assertReadOnlyRpCliArgs,
  buildListSessionAttempts,
  deriveBindingTargets,
  parseAgentSessions,
  parseWindowsOutput,
  READ_ONLY_RP_CLI_COMMANDS,
  RpCliProvider
} from '../src/repoprompt/providers/index.js';

const fixturePath = new URL('./fixtures/rp-windows.txt', import.meta.url);
const controlPlaneContextId = '0D1D0428-949A-485F-A3B0-6924EE9EC5CF';
const secondaryWorkspaceContextId = '28680F75-90F5-4E72-ADA9-6710165CB25C';
const controlPlaneRepoPath = '/workspace/RepoPrompt-control-plane';

describe('parseWindowsOutput', () => {
  it('parses RepoPrompt workspaces and active contexts without depending on a fixed window id', async () => {
    const output = await readFile(fixturePath, 'utf8');
    const windows = parseWindowsOutput(output);
    const controlPlaneWindow = windows.find((window) => window.workspace === 'RepoPrompt-control-plane');

    expect(windows).toHaveLength(5);
    expect(controlPlaneWindow).toMatchObject({
      workspace: 'RepoPrompt-control-plane',
      repoPath: controlPlaneRepoPath,
      observation: 'observed'
    });
    expect(controlPlaneWindow?.id).toEqual(expect.any(Number));
    expect(controlPlaneWindow?.tabs[0]).toMatchObject({
      name: 'T1',
      contextId: controlPlaneContextId,
      active: true,
      observation: 'observed'
    });
  });

  it('parses observed raw JSON windows with nested workspace and tab-level repo paths', () => {
    const windows = parseWindowsOutput(
      JSON.stringify({
        windows: [
          {
            window_id: 12,
            workspace: { id: 'workspace-control-plane', name: 'RepoPrompt-control-plane' },
            active_context_id: 'ctx-active',
            tabs: [
              {
                name: 'Implementation',
                context_id: 'ctx-active',
                is_active: true,
                repo_paths: ['/repo/control-plane'],
                workspace_name: 'RepoPrompt-control-plane',
                workspace_id: 'workspace-control-plane'
              },
              {
                name: 'Review',
                context_id: 'ctx-review',
                is_active: false,
                repo_paths: ['/repo/control-plane']
              }
            ]
          }
        ]
      })
    );

    expect(windows).toEqual([
      expect.objectContaining({
        id: 12,
        workspace: 'RepoPrompt-control-plane',
        workspaceId: 'workspace-control-plane',
        activeContextId: 'ctx-active',
        repoPath: '/repo/control-plane',
        repoPaths: ['/repo/control-plane'],
        observation: 'observed',
        tabs: [
          expect.objectContaining({ name: 'Implementation', contextId: 'ctx-active', active: true }),
          expect.objectContaining({ name: 'Review', contextId: 'ctx-review', active: false })
        ]
      })
    ]);
  });
});

describe('parseAgentSessions', () => {
  it('normalizes returned session records instead of dropping available data', () => {
    const sessions = parseAgentSessions(
      JSON.stringify({ sessions: [{ session_id: 's1', title: 'Live session', status: 'waiting', model_id: 'Codex', progress: 0.5 }] })
    );

    expect(sessions).toEqual([
      expect.objectContaining({
        id: 's1',
        title: 'Live session',
        state: 'waiting_for_input',
        model: 'Codex',
        progress: 0.5,
        observation: 'observed'
      })
    ]);
  });

  it('preserves observed live hierarchy metadata from list_sessions JSON records', () => {
    const sessions = parseAgentSessions(
      JSON.stringify({
        sessions: [
          {
            session_id: 'child-session',
            title: 'Child executor',
            status: 'running',
            parent_session_id: 'parent-session',
            workflow_id: 'workflow-1',
            run_id: 'run-ignored-because-workflow-present',
            agent_role: 'executor',
            metadata: { role: 'stale-role', attempt: 2, nested: { ignored: true } }
          },
          {
            id: 'reviewer-session',
            name: 'Reviewer',
            state: 'waiting',
            parentId: 'parent-session',
            runId: 'run-2',
            metadata: { agentRole: 'reviewer' }
          }
        ]
      })
    );

    expect(sessions).toEqual([
      expect.objectContaining({
        id: 'child-session',
        parentSessionId: 'parent-session',
        workflowId: 'workflow-1',
        metadata: expect.objectContaining({ role: 'executor', attempt: 2 })
      }),
      expect.objectContaining({
        id: 'reviewer-session',
        parentSessionId: 'parent-session',
        workflowId: 'run-2',
        metadata: expect.objectContaining({ role: 'reviewer' })
      })
    ]);
    expect(sessions[0]?.metadata).not.toHaveProperty('nested');
  });

  it('accepts alternate wrapper keys returned by rp-cli variants', () => {
    const sessions = parseAgentSessions(JSON.stringify({ data: [{ id: 's2', name: 'Wrapped session', state: 'completed' }] }));
    expect(sessions).toEqual([expect.objectContaining({ id: 's2', title: 'Wrapped session', state: 'completed' })]);
  });

  it('parses markdown session rows returned by rp-cli window-bound output', () => {
    const sessions = parseAgentSessions('- Live mode session · `550E8400-E29B-41D4-A716-446655440000` · running · codexExec');
    expect(sessions).toEqual([
      expect.objectContaining({
        id: '550E8400-E29B-41D4-A716-446655440000',
        title: 'Live mode session',
        state: 'running',
        model: 'codexExec'
      })
    ]);
  });
});

describe('binding target selection', () => {
  it('prioritizes current RepoPrompt-control-plane workspace/context candidates without hard-coded window ids', async () => {
    const windows = parseWindowsOutput(await readFile(fixturePath, 'utf8'));
    const targets = deriveBindingTargets(windows, controlPlaneRepoPath);
    const attempts = buildListSessionAttempts(windows, controlPlaneRepoPath);

    expect(targets[0]).toMatchObject({ kind: 'workspace_roots' });
    expect(targets[0].repoPaths?.[0]).toBe(controlPlaneRepoPath);
    expect(targets.find((target) => target.kind === 'context')).toMatchObject({
      workspace: 'RepoPrompt-control-plane',
      contextId: controlPlaneContextId
    });
    expect(attempts[0]).toMatchObject({ id: 'unbound' });
    expect(attempts[1]).toMatchObject({ id: expect.stringMatching(/^window-hidden:/) });
    expect(JSON.parse(attempts[1]?.args[3] ?? '{}')).toMatchObject({ _windowID: expect.any(Number), op: 'list_sessions', limit: 20 });
    expect(attempts.some((attempt) => attempt.args.join(' ').includes(controlPlaneContextId))).toBe(true);
    const windowAttempt = attempts.find((attempt) => attempt.id === 'window:12');
    expect(JSON.parse(windowAttempt?.args[3] ?? '{}')).toMatchObject({
      _windowID: 12,
      op: 'list_sessions',
      limit: 20
    });
    expect(JSON.parse(windowAttempt?.args[3] ?? '{}')).not.toHaveProperty('window_id');
  });
});

describe('RpCliProvider', () => {
  it('reports the text windows fallback honestly when raw JSON windows are unavailable', async () => {
    const windowsOutput = await readFile(fixturePath, 'utf8');
    const runner: CommandRunner = async (_executable, args) => {
      if (args.includes('--help')) return { stdout: 'RepoPrompt MCP CLI', stderr: '', exitCode: 0 };
      if (args.includes('--raw-json')) return { stdout: '', stderr: 'raw json unsupported', exitCode: 1 };
      if (args.includes('windows')) return { stdout: windowsOutput, stderr: '', exitCode: 0 };
      return { stdout: JSON.stringify({ sessions: [] }), stderr: '', exitCode: 0 };
    };

    const provider = new RpCliProvider(loadConfig({}), runner, () => new Date('2026-04-28T00:00:00Z'));
    const snapshot = await provider.collectSnapshot();

    expect(snapshot.windows.length).toBeGreaterThan(0);
    expect(snapshot.capabilities.find((entry) => entry.field === 'windows')).toMatchObject({
      status: 'available',
      observation: 'observed',
      command: "rp-cli -e 'windows'",
      parseFormat: 'text'
    });
  });

  it('recovers from an unbound binding error by trying targeted read-only list_sessions payloads', async () => {
    const windowsOutput = await readFile(fixturePath, 'utf8');
    const calls: string[][] = [];
    const runner: CommandRunner = async (_executable, args) => {
      calls.push(args);
      if (args.includes('--help')) return { stdout: 'RepoPrompt MCP CLI', stderr: '', exitCode: 0 };
      if (args.includes('windows')) return { stdout: windowsOutput, stderr: '', exitCode: 0 };

      const payload = JSON.parse(args[3] ?? '{}') as Record<string, unknown>;
      if (payload.context_id === controlPlaneContextId) {
        return {
          stdout: JSON.stringify({ sessions: [{ id: 's1', title: 'Live session', status: 'running' }] }),
          stderr: '',
          exitCode: 0
        };
      }
      return {
        stdout: '',
        stderr: 'Multiple RepoPrompt windows detected. Bind your connection to route tool calls.',
        exitCode: 1
      };
    };

    const provider = new RpCliProvider(loadConfig({}), runner, () => new Date('2026-04-28T00:00:00Z'));
    const snapshot = await provider.collectSnapshot();
    const listSessionPayloads = calls.filter((args) => args.includes('agent_manage')).map((args) => JSON.parse(args[3] ?? '{}'));

    expect(listSessionPayloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ op: 'list_sessions', limit: 20 }),
        expect.objectContaining({ working_dirs: expect.arrayContaining([controlPlaneRepoPath]) }),
        expect.objectContaining({ context_id: controlPlaneContextId })
      ])
    );
    expect(snapshot.sessions).toEqual([
      expect.objectContaining({ id: 's1', state: 'running', workspace: 'RepoPrompt-control-plane', observation: 'observed' })
    ]);
    expect(snapshot.capabilities.find((entry) => entry.field === 'agentSessionStates')).toMatchObject({
      status: 'available',
      observation: 'observed'
    });
    expect(snapshot.diagnostics).not.toContainEqual(expect.objectContaining({ code: 'session_status_requires_binding' }));
    expect(snapshot.capabilities.find((entry) => entry.field === 'agentLogs')).toMatchObject({
      status: 'unavailable',
      observation: 'unavailable',
      command: 'not called during MVP probe',
      parseFormat: 'none',
      privacyClass: 'transcript'
    });
    expect(calls.some((args) => args.join(' ').includes('get_log'))).toBe(false);
  });

  it('merges sessions from multiple successful targeted selectors', async () => {
    const windowsOutput = await readFile(fixturePath, 'utf8');
    const runner: CommandRunner = async (_executable, args) => {
      if (args.includes('--help')) return { stdout: 'RepoPrompt MCP CLI', stderr: '', exitCode: 0 };
      if (args.includes('windows')) return { stdout: windowsOutput, stderr: '', exitCode: 0 };
      const payload = JSON.parse(args[3] ?? '{}') as Record<string, unknown>;
      if (payload.context_id === controlPlaneContextId) {
        return { stdout: JSON.stringify({ sessions: [{ id: 'control', title: 'Control plane', status: 'running' }] }), stderr: '', exitCode: 0 };
      }
      if (payload.context_id === secondaryWorkspaceContextId) {
        return {
          stdout: JSON.stringify({ sessions: [{ id: 'secondary', title: 'Secondary workspace', status: 'waiting' }] }),
          stderr: '',
          exitCode: 0
        };
      }
      return { stdout: '', stderr: 'Multiple RepoPrompt windows detected. Bind your connection to route tool calls.', exitCode: 1 };
    };

    const provider = new RpCliProvider(loadConfig({}), runner, () => new Date('2026-04-28T00:00:00Z'));
    const snapshot = await provider.collectSnapshot();

    expect(snapshot.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'control', workspace: 'RepoPrompt-control-plane' }),
        expect.objectContaining({ id: 'secondary', workspace: 'sample-workspace-a' })
      ])
    );
    expect(snapshot.diagnostics).toHaveLength(0);
  });

  it('emits parse-drift diagnostics instead of treating malformed successful output as empty sessions', async () => {
    const runner: CommandRunner = async (_executable, args) => {
      if (args.includes('--help')) return { stdout: 'RepoPrompt MCP CLI', stderr: '', exitCode: 0 };
      if (args.includes('windows')) return { stdout: '', stderr: '', exitCode: 0 };
      return { stdout: 'not json', stderr: '', exitCode: 0 };
    };

    const provider = new RpCliProvider(loadConfig({}), runner, () => new Date('2026-04-28T00:00:00Z'));
    const snapshot = await provider.collectSnapshot();

    expect(snapshot.capabilities.find((entry) => entry.field === 'agentSessionStates')).toMatchObject({ status: 'unavailable' });
    expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({ code: 'agent_sessions_parse_drift' }));
  });

  it('emits one unavailable diagnostic when all supported session binding strategies fail', async () => {
    const windowsOutput = await readFile(fixturePath, 'utf8');
    const sessionCalls: string[][] = [];
    const runner: CommandRunner = async (_executable, args) => {
      if (args.includes('--help')) return { stdout: 'RepoPrompt MCP CLI', stderr: '', exitCode: 0 };
      if (args.includes('windows')) return { stdout: windowsOutput, stderr: '', exitCode: 0 };
      sessionCalls.push(args);
      return {
        stdout: '',
        stderr: 'Multiple RepoPrompt windows detected. Bind your connection to route tool calls.',
        exitCode: 1
      };
    };

    const provider = new RpCliProvider(loadConfig({}), runner, () => new Date('2026-04-28T00:00:00Z'));
    const snapshot = await provider.collectSnapshot();

    expect(sessionCalls.length).toBeGreaterThan(2);
    expect(snapshot.windows).toHaveLength(5);
    expect(snapshot.sessions).toHaveLength(0);
    expect(snapshot.capabilities.find((entry) => entry.field === 'agentSessionStates')).toMatchObject({
      status: 'unavailable',
      observation: 'unavailable'
    });
    expect(snapshot.diagnostics.filter((diagnostic) => diagnostic.code === 'session_status_requires_binding')).toHaveLength(1);
  });

  it('parses session rows when the unbound session API is available', async () => {
    const windowsOutput = await readFile(fixturePath, 'utf8');
    const runner: CommandRunner = async (_executable, args) => {
      if (args.includes('--help')) return { stdout: 'RepoPrompt MCP CLI', stderr: '', exitCode: 0 };
      if (args.includes('windows')) return { stdout: windowsOutput, stderr: '', exitCode: 0 };
      return {
        stdout: JSON.stringify({ sessions: [{ id: 's1', title: 'Live session', status: 'running' }] }),
        stderr: '',
        exitCode: 0
      };
    };

    const provider = new RpCliProvider(loadConfig({}), runner, () => new Date('2026-04-28T00:00:00Z'));
    const snapshot = await provider.collectSnapshot();

    expect(snapshot.sessions).toEqual([expect.objectContaining({ id: 's1', state: 'running', observation: 'observed' })]);
    expect(snapshot.capabilities.find((entry) => entry.field === 'agentSessionStates')).toMatchObject({
      status: 'available',
      observation: 'observed'
    });
  });

  it('handles missing rp-cli without throwing', async () => {
    const runner: CommandRunner = async () => ({ stdout: '', stderr: 'spawn rp-cli ENOENT', exitCode: 1 });
    const provider = new RpCliProvider(loadConfig({}), runner, () => new Date('2026-04-28T00:00:00Z'));
    const snapshot = await provider.collectSnapshot();

    expect(snapshot.windows).toHaveLength(0);
    expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({ code: 'rp_cli_unavailable', severity: 'error' }));
  });

  it('marks error capabilities as unavailable rather than inferred', async () => {
    const runner: CommandRunner = async (_executable, args) => {
      if (args.includes('--help')) return { stdout: 'RepoPrompt MCP CLI', stderr: '', exitCode: 0 };
      if (args.includes('windows')) return { stdout: '', stderr: 'Failed to connect: permission denied (errno 1)', exitCode: 1 };
      return { stdout: '', stderr: 'Failed to connect: permission denied (errno 1)', exitCode: 1 };
    };
    const provider = new RpCliProvider(loadConfig({}), runner, () => new Date('2026-04-28T00:00:00Z'));
    const snapshot = await provider.collectSnapshot();

    expect(snapshot.capabilities.find((entry) => entry.field === 'windows')).toMatchObject({
      status: 'error',
      observation: 'unavailable'
    });
  });

  it('rejects mutating or malformed rp-cli payloads with the positive read-only validator', () => {
    expect(() => assertReadOnlyRpCliArgs(['--help'])).not.toThrow();
    expect(() => assertReadOnlyRpCliArgs(['-e', 'windows'])).not.toThrow();
    expect(() => assertReadOnlyRpCliArgs(['-e', 'windows', '--raw-json'])).not.toThrow();
    expect(() => assertReadOnlyRpCliArgs(['-c', 'agent_manage', '-j', JSON.stringify({ op: 'list_sessions', limit: 20, context_id: controlPlaneContextId })])).not.toThrow();
    expect(() => assertReadOnlyRpCliArgs(['-c', 'agent_manage', '-j', JSON.stringify({ op: 'list_sessions', limit: 20, _windowID: 12 })])).not.toThrow();
    expect(() => assertReadOnlyRpCliArgs(['-c', 'agent_manage', '-j', JSON.stringify({ op: 'bind', context_id: controlPlaneContextId })])).toThrow();
    expect(() => assertReadOnlyRpCliArgs(['-c', 'agent_manage', '-j', JSON.stringify({ op: 'respond', message: 'hi' })])).toThrow();
    expect(() => assertReadOnlyRpCliArgs(['-c', 'agent_manage', '-j', '{bad json'])).toThrow();
    expect(() => assertReadOnlyRpCliArgs(['-c', 'agent_manage', '-j', JSON.stringify({ op: 'list_sessions', limit: 20, working_dirs: [123] })])).toThrow();
    expect(() => assertReadOnlyRpCliArgs(['-c', 'agent_manage', '-j', JSON.stringify({ op: 'list_sessions', limit: 20, window_id: 0 })])).toThrow();
    expect(() => assertReadOnlyRpCliArgs(['-c', 'agent_manage', '-j', JSON.stringify({ op: 'list_sessions', limit: 20, _windowID: 0 })])).toThrow();
  });

  it('documents only read-only rp-cli commands in the MVP allowlist', () => {
    const commandText = READ_ONLY_RP_CLI_COMMANDS.join(' ');
    expect(commandText).toContain('list_sessions');
    expect(commandText).toContain('--raw-json');
    expect(commandText).toContain('working_dirs');
    expect(commandText).toContain('context_id');
    expect(commandText).toContain('window_id');
    expect(commandText).toContain('_windowID');
    expect(commandText).not.toContain('bind_context');
    expect(commandText).not.toContain('"op":"bind"');
    expect(commandText).not.toContain('respond');
    expect(commandText).not.toContain('cancel');
    expect(commandText).not.toContain('steer');
    expect(commandText).not.toContain('file_actions');
    expect(commandText).not.toContain('apply_edits');
  });
});
