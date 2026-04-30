import type {
  AgentSession,
  CapabilityMatrixEntry,
  CommandRunner,
  ControlPlaneConfig,
  ControlPlaneSnapshot,
  ProviderDiagnostic,
  RepoPromptProvider,
  RepoPromptWindow,
  SessionState
} from '../../shared/types.js';
import { execFileRunner } from '../commandRunner.js';

const DEFAULT_TIMEOUT_MS = 8000;
const LIST_SESSIONS_LIMIT = 20;
const MAX_TARGETED_SESSION_ATTEMPTS = 8;

export const READ_ONLY_RP_CLI_COMMANDS = [
  'rp-cli --help',
  "rp-cli -e 'windows' --raw-json",
  "rp-cli -e 'windows'",
  'rp-cli -c agent_manage -j {"op":"list_sessions","limit":20}',
  'rp-cli -c agent_manage -j {"op":"list_sessions","limit":20,"working_dirs":["/abs/repo"]}',
  'rp-cli -c agent_manage -j {"op":"list_sessions","limit":20,"context_id":"..."}',
  'rp-cli -c agent_manage -j {"op":"list_sessions","limit":20,"window_id":123}',
  'rp-cli -c agent_manage -j {"_windowID":123,"op":"list_sessions","limit":20}'
] as const;

export interface BindingTarget {
  id: string;
  kind: 'workspace_roots' | 'context' | 'window';
  workspace?: string;
  windowId?: number;
  repoPaths?: string[];
  contextId?: string;
  tabName?: string;
}

export interface ListSessionsAttempt {
  id: string;
  label: string;
  args: string[];
  target?: BindingTarget;
}

type CapabilityDraft = Omit<CapabilityMatrixEntry, 'status' | 'observation'> & {
  defaultStatus?: CapabilityMatrixEntry['status'];
};

type SessionFailureCode =
  | 'session_status_requires_binding'
  | 'repoprompt_socket_permission_denied'
  | 'agent_sessions_unavailable';

interface SessionCollectionResult {
  sessions: AgentSession[];
  status: CapabilityMatrixEntry['status'];
  diagnostic?: ProviderDiagnostic;
}

interface ParsedSessionResult {
  ok: boolean;
  sessions: AgentSession[];
  error?: string;
}

interface MarkdownSessionRow {
  title: string;
  id: string;
  state: string;
  model?: string;
}

const BASE_CAPABILITIES: CapabilityDraft[] = [
  {
    field: 'rpCliHelp',
    source: 'rp-cli help text',
    command: 'rp-cli --help',
    requiresBinding: false,
    parseFormat: 'text',
    failureMode: 'missing executable, timeout, non-zero exit',
    privacyClass: 'metadata'
  },
  {
    field: 'windows',
    source: 'RepoPrompt window list',
    command: "rp-cli -e 'windows' --raw-json",
    requiresBinding: false,
    parseFormat: 'json',
    failureMode: 'RepoPrompt unavailable, socket permission denied, parse drift',
    privacyClass: 'metadata'
  },
  {
    field: 'agentSessionStates',
    source: 'agent_manage list_sessions',
    command: 'rp-cli -c agent_manage -j {op:list_sessions,selectors?:working_dirs|context_id|window_id}',
    requiresBinding: true,
    parseFormat: 'json',
    failureMode: 'multi-window binding required, socket permission denied, unsupported session scope',
    privacyClass: 'metadata'
  },
  {
    field: 'agentLogs',
    source: 'agent_manage get_log',
    command: 'not called during MVP probe',
    requiresBinding: true,
    parseFormat: 'none',
    failureMode: 'explicit user request required; may contain transcripts/log bodies',
    privacyClass: 'transcript',
    defaultStatus: 'unavailable'
  },
  {
    field: 'copySummary',
    source: 'local deterministic summary',
    requiresBinding: false,
    parseFormat: 'none',
    failureMode: 'local derivation unavailable only if snapshot construction fails',
    privacyClass: 'metadata'
  }
];

export class RpCliProvider implements RepoPromptProvider {
  readonly name = 'rp-cli' as const;

  constructor(
    private readonly config: ControlPlaneConfig,
    private readonly runner: CommandRunner = execFileRunner,
    private readonly now: () => Date = () => new Date()
  ) {}

  async collectSnapshot(): Promise<ControlPlaneSnapshot> {
    const generatedAt = this.now().toISOString();
    const diagnostics: ProviderDiagnostic[] = [];
    const capabilityStatus = new Map<string, CapabilityMatrixEntry['status']>();

    const help = await this.runReadOnly(['--help']);
    capabilityStatus.set('rpCliHelp', help.exitCode === 0 ? 'available' : 'error');
    if (help.exitCode !== 0) {
      diagnostics.push(this.diagnostic('rp_cli_unavailable', describeFailure(`${help.stderr}\n${help.stdout}`), 'error', generatedAt, 'rp-cli --help'));
      return this.emptySnapshot(generatedAt, capabilityStatus, diagnostics);
    }

    let windowsCommand = "rp-cli -e 'windows' --raw-json";
    let windowsParseFormat: CapabilityMatrixEntry['parseFormat'] = 'json';
    let windowsResult = await this.runReadOnly(['-e', 'windows', '--raw-json']);
    if (windowsResult.exitCode !== 0) {
      windowsCommand = "rp-cli -e 'windows'";
      windowsParseFormat = 'text';
      windowsResult = await this.runReadOnly(['-e', 'windows']);
    }
    capabilityStatus.set('windows', windowsResult.exitCode === 0 ? 'available' : 'error');
    const windows = windowsResult.exitCode === 0 ? parseWindowsOutput(windowsResult.stdout) : [];
    if (windowsResult.exitCode !== 0) {
      diagnostics.push(this.diagnostic('windows_unavailable', describeFailure(`${windowsResult.stderr}\n${windowsResult.stdout}`), 'warning', generatedAt, windowsCommand));
    }

    const sessionCollection = await this.collectSessionsWithBindingTargets(windows, generatedAt);
    capabilityStatus.set('agentSessionStates', sessionCollection.status);
    if (sessionCollection.diagnostic) diagnostics.push(sessionCollection.diagnostic);

    capabilityStatus.set('agentLogs', 'unavailable');
    capabilityStatus.set('copySummary', 'available');

    return {
      generatedAt,
      provider: this.name,
      windows,
      sessions: sessionCollection.sessions,
      capabilities: buildCapabilities(capabilityStatus, {
        windows: { command: windowsCommand, parseFormat: windowsParseFormat }
      }),
      diagnostics,
      summarySource: 'observed'
    };
  }

  private async collectSessionsWithBindingTargets(windows: RepoPromptWindow[], generatedAt: string): Promise<SessionCollectionResult> {
    const attempts = buildListSessionAttempts(windows);
    const sessionsById = new Map<string, AgentSession>();
    let firstFailure: { code: SessionFailureCode; output: string } | undefined;
    let lastFailure: { code: SessionFailureCode; output: string } | undefined;
    let successfulEmptyAttempt = false;
    let attemptedCount = 0;
    let parseFailure: { code: string; output: string } | undefined;

    for (const attempt of attempts) {
      attemptedCount += 1;
      const result = await this.runReadOnly(attempt.args);
      if (result.exitCode === 0) {
        const parsed = parseAgentSessionsPayload(result.stdout);
        if (!parsed.ok) {
          parseFailure ??= { code: 'agent_sessions_parse_drift', output: parsed.error ?? result.stdout };
          continue;
        }
        mergeSessions(sessionsById, parsed.sessions, attempt.target);
        if (parsed.sessions.length === 0) successfulEmptyAttempt = true;
        continue;
      }

      const output = `${result.stderr}\n${result.stdout}`;
      const code = classifySessionFailure(output);
      firstFailure ??= { code, output };
      lastFailure = { code, output };
      if (code === 'repoprompt_socket_permission_denied') break;
      if (!isRetryableSessionFailure(code)) break;
    }

    if (sessionsById.size > 0 || successfulEmptyAttempt) {
      return { sessions: [...sessionsById.values()], status: 'available' };
    }

    const failure = firstFailure ?? lastFailure ?? parseFailure;
    return {
      sessions: [],
      status: 'unavailable',
      diagnostic: this.diagnostic(
        failure?.code ?? 'agent_sessions_unavailable',
        `${describeFailure(failure?.output ?? '')} Attempted ${attemptedCount} read-only list_sessions binding strateg${attemptedCount === 1 ? 'y' : 'ies'}.`,
        'warning',
        generatedAt,
        'rp-cli -c agent_manage -j {op:list_sessions}'
      )
    };
  }

  private async runReadOnly(args: string[]) {
    assertReadOnlyRpCliArgs(args);
    return this.runner(this.config.rpCliPath, args, DEFAULT_TIMEOUT_MS);
  }

  private emptySnapshot(
    generatedAt: string,
    capabilityStatus: Map<string, CapabilityMatrixEntry['status']>,
    diagnostics: ProviderDiagnostic[]
  ): ControlPlaneSnapshot {
    capabilityStatus.set('windows', 'unavailable');
    capabilityStatus.set('agentSessionStates', 'unavailable');
    capabilityStatus.set('agentLogs', 'unavailable');
    capabilityStatus.set('copySummary', 'available');
    return {
      generatedAt,
      provider: this.name,
      windows: [],
      sessions: [],
      capabilities: buildCapabilities(capabilityStatus),
      diagnostics,
      summarySource: 'unavailable'
    };
  }

  private diagnostic(
    code: string,
    message: string,
    severity: ProviderDiagnostic['severity'],
    observedAt: string,
    command?: string
  ): ProviderDiagnostic {
    return { code, message, severity, observedAt, command };
  }
}

export function parseWindowsOutput(output: string): RepoPromptWindow[] {
  const rawJsonWindows = parseRawJsonWindows(output);
  if (rawJsonWindows) return rawJsonWindows;

  const windows: RepoPromptWindow[] = [];
  let current: RepoPromptWindow | undefined;

  for (const line of output.split(/\r?\n/)) {
    const windowMatch = line.match(/^- Window `(\d+)` • workspace: (.*?) • (\d+) tabs?/);
    if (windowMatch) {
      current = {
        id: Number.parseInt(windowMatch[1] ?? '0', 10),
        workspace: windowMatch[2]?.trim() ?? 'Unknown',
        tabs: [],
        observation: 'observed'
      };
      windows.push(current);
      continue;
    }

    if (!current) continue;

    const repoMatch = line.match(/^\s*repo: `(.*?)`/);
    if (repoMatch) {
      current.repoPath = repoMatch[1];
      continue;
    }

    const activeMatch = line.match(/^\s*• active: (.*?) — context_id: `(.*?)`/);
    if (activeMatch) {
      const contextId = activeMatch[2]?.trim();
      current.activeContextId = contextId;
      current.tabs.push({
        name: activeMatch[1]?.trim() ?? 'Untitled',
        contextId,
        active: true,
        observation: 'observed'
      });
    }
  }

  return windows;
}

function parseRawJsonWindows(output: string): RepoPromptWindow[] | undefined {
  const trimmed = output.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }

  const records = extractWindowRecords(parsed);
  if (!records) return undefined;

  return records.map((record, index) => {
    const id = readNumber(record, ['window_id', 'windowId', 'id']) ?? index + 1;
    const workspaceRecord = asRecord(record.workspace);
    const workspace =
      readString(record, ['workspace_name', 'workspaceName', 'name']) ??
      readString(workspaceRecord, ['name', 'workspace_name', 'workspaceName']) ??
      (typeof record.workspace === 'string' && record.workspace.trim() ? record.workspace.trim() : undefined) ??
      'Unknown';
    const workspaceId =
      readString(record, ['workspace_id', 'workspaceId']) ?? readString(workspaceRecord, ['id', 'workspace_id', 'workspaceId']);
    const activeContextId = readString(record, ['active_context_id', 'activeContextId']);
    const tabs = readTabs(record, activeContextId);
    const repoPaths = unique([
      ...readStringArray(record, ['repo_paths', 'repoPaths', 'repos']),
      ...readStringArrayFromRecords(Array.isArray(record.tabs) ? record.tabs.filter(isRecord) : [], ['repo_paths', 'repoPaths'])
    ]);
    const repoPath = readString(record, ['repo_path', 'repoPath', 'repo']) ?? repoPaths[0];
    return {
      id,
      workspace,
      workspaceId,
      repoPath,
      repoPaths: repoPaths.length > 0 ? repoPaths : undefined,
      activeContextId,
      tabs,
      observation: 'observed'
    };
  });
}

function extractWindowRecords(value: unknown): Record<string, unknown>[] | undefined {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return undefined;
  for (const key of ['windows', 'items', 'results', 'data']) {
    const child = value[key];
    if (Array.isArray(child)) return child.filter(isRecord);
  }
  return undefined;
}

function readTabs(record: Record<string, unknown>, activeContextId: string | undefined): RepoPromptWindow['tabs'] {
  const rawTabs = Array.isArray(record.tabs) ? record.tabs.filter(isRecord) : [];
  return rawTabs.map((tab, index) => {
    const contextId = readString(tab, ['context_id', 'contextId', 'id']);
    const name = readString(tab, ['name', 'title', 'tab_name', 'tabName']) ?? `Tab ${index + 1}`;
    const isActive = readBoolean(tab, ['is_active', 'isActive', 'active']) ?? Boolean(contextId && contextId === activeContextId);
    return {
      name,
      contextId,
      active: isActive,
      observation: 'observed' as const
    };
  });
}

export function parseAgentSessions(output: string): AgentSession[] {
  const parsed = parseAgentSessionsPayload(output);
  return parsed.ok ? parsed.sessions : [];
}

function parseAgentSessionsPayload(output: string): ParsedSessionResult {
  const trimmed = output.trim();
  if (!trimmed) return { ok: false, sessions: [], error: 'agent_manage list_sessions returned no output.' };

  const markdownRows = parseMarkdownSessionRows(trimmed);
  if (markdownRows.length > 0) {
    return {
      ok: true,
      sessions: markdownRows.map((row, index) => ({
        id: row.id || `session-${index + 1}`,
        title: row.title || `Session ${index + 1}`,
        state: normalizeSessionState(row.state),
        model: row.model,
        observation: 'observed'
      }))
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, sessions: [], error: 'agent_manage list_sessions returned malformed JSON.' };
  }

  const records = extractSessionRecords(parsed);
  if (!records) return { ok: false, sessions: [], error: 'agent_manage list_sessions JSON did not contain a recognized sessions array.' };
  return {
    ok: true,
    sessions: records.map((record, index) => ({
      id: readString(record, ['session_id', 'sessionId', 'id']) ?? `session-${index + 1}`,
      title: readString(record, ['title', 'name', 'session_name', 'sessionName']) ?? `Session ${index + 1}`,
      workspace: readString(record, ['workspace', 'workspaceName', 'workspace_name', 'repo', 'repoPath']),
      state: normalizeSessionState(readString(record, ['state', 'status']) ?? 'unknown'),
      model: readString(record, ['model', 'model_id', 'modelId']),
      progress: readNumber(record, ['progress']),
      updatedAt: readString(record, ['updated_at', 'updatedAt', 'lastActivityAt']),
      parentSessionId: readParentSessionId(record),
      workflowId: readWorkflowId(record),
      metadata: readSessionMetadata(record),
      observation: 'observed'
    }))
  };
}

export function deriveBindingTargets(windows: RepoPromptWindow[], currentWorkingDirectory = process.cwd()): BindingTarget[] {
  const rankedWindows = [...windows].sort((a, b) => bindingRank(b, currentWorkingDirectory) - bindingRank(a, currentWorkingDirectory));
  const targets: BindingTarget[] = [];
  const seen = new Set<string>();
  const repoPaths = unique(rankedWindows.map((window) => window.repoPath).filter(isNonEmptyString));

  if (repoPaths.length > 0) {
    const id = `workspace_roots:${[...repoPaths].sort().join('|')}`;
    seen.add(id);
    targets.push({ id, kind: 'workspace_roots', repoPaths, workspace: rankedWindows[0]?.workspace });
  }

  for (const window of rankedWindows) {
    for (const tab of window.tabs.filter((tab) => tab.active && tab.contextId)) {
      const contextId = tab.contextId;
      if (!contextId) continue;
      const id = `context:${contextId}`;
      if (seen.has(id)) continue;
      seen.add(id);
      targets.push({
        id,
        kind: 'context',
        workspace: window.workspace,
        windowId: window.id,
        repoPaths: window.repoPath ? [window.repoPath] : undefined,
        contextId,
        tabName: tab.name
      });
    }
  }

  for (const window of rankedWindows) {
    const id = `window:${window.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    targets.push({
      id,
      kind: 'window',
      workspace: window.workspace,
      windowId: window.id,
      repoPaths: window.repoPath ? [window.repoPath] : undefined
    });
  }

  return targets;
}

export function buildListSessionAttempts(windows: RepoPromptWindow[], currentWorkingDirectory = process.cwd()): ListSessionsAttempt[] {
  const attempts: ListSessionsAttempt[] = [
    {
      id: 'unbound',
      label: 'unbound list_sessions',
      args: listSessionsArgs({ op: 'list_sessions', limit: LIST_SESSIONS_LIMIT })
    }
  ];

  const seenHiddenWindowIds = new Set<number>();
  const rankedWindows = [...windows].sort((a, b) => bindingRank(b, currentWorkingDirectory) - bindingRank(a, currentWorkingDirectory));
  for (const window of rankedWindows.slice(0, MAX_TARGETED_SESSION_ATTEMPTS)) {
    if (seenHiddenWindowIds.has(window.id)) continue;
    seenHiddenWindowIds.add(window.id);
    attempts.push({
      id: `window-hidden:${window.id}`,
      label: 'window hidden key list_sessions',
      args: listSessionsArgs({ _windowID: window.id, op: 'list_sessions', limit: LIST_SESSIONS_LIMIT }),
      target: {
        id: `window:${window.id}`,
        kind: 'window',
        workspace: window.workspace,
        windowId: window.id,
        repoPaths: window.repoPath ? [window.repoPath] : undefined
      }
    });
  }

  for (const target of deriveBindingTargets(windows, currentWorkingDirectory).slice(0, MAX_TARGETED_SESSION_ATTEMPTS)) {
    const payload = payloadForTarget(target);
    attempts.push({
      id: target.id,
      label: `${target.kind} list_sessions`,
      args: listSessionsArgs(payload),
      target
    });
  }

  return attempts;
}

function payloadForTarget(target: BindingTarget): Record<string, unknown> {
  const base = { op: 'list_sessions', limit: LIST_SESSIONS_LIMIT };
  if (target.kind === 'workspace_roots') return { ...base, working_dirs: target.repoPaths ?? [] };
  if (target.kind === 'context') return { ...base, context_id: target.contextId };
  return { ...base, _windowID: target.windowId };
}

function listSessionsArgs(payload: Record<string, unknown>): string[] {
  return ['-c', 'agent_manage', '-j', JSON.stringify(payload)];
}


function mergeSessions(existing: Map<string, AgentSession>, parsed: AgentSession[], target?: BindingTarget): void {
  for (const session of parsed) {
    if (existing.has(session.id)) continue;
    existing.set(session.id, {
      ...session,
      workspace: session.workspace ?? target?.workspace,
      observation: 'observed'
    });
  }
}

function bindingRank(window: RepoPromptWindow, currentWorkingDirectory: string): number {
  const cwd = normalizePath(currentWorkingDirectory);
  const repoPath = normalizePath(window.repoPath ?? '');
  const cwdName = cwd.split('/').filter(Boolean).at(-1)?.toLowerCase() ?? '';
  const workspace = window.workspace.toLowerCase();
  let rank = 0;
  if (repoPath && repoPath === cwd) rank += 100;
  if (repoPath && (repoPath.startsWith(`${cwd}/`) || cwd.startsWith(`${repoPath}/`))) rank += 40;
  if (cwdName && workspace === cwdName) rank += 30;
  if (cwdName && workspace.includes(cwdName)) rank += 20;
  if (window.tabs.some((tab) => tab.active && tab.contextId)) rank += 5;
  return rank;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/$/, '');
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseMarkdownSessionRows(output: string): MarkdownSessionRow[] {
  const rows: MarkdownSessionRow[] = [];
  const pattern = /^\s*-\s*(.*?)\s*·\s*`([^`]+)`\s*·\s*([^·]+?)(?:\s*·\s*(.+))?\s*$/;
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(pattern);
    if (!match) continue;
    rows.push({
      title: match[1]?.trim() ?? '',
      id: match[2]?.trim() ?? '',
      state: match[3]?.trim() ?? 'unknown',
      model: match[4]?.trim() || undefined
    });
  }
  return rows;
}

function extractSessionRecords(value: unknown): Record<string, unknown>[] | undefined {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return undefined;
  for (const key of ['sessions', 'agent_sessions', 'items', 'results', 'snapshots', 'data']) {
    const child = value[key];
    if (Array.isArray(child)) return child.filter(isRecord);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function readString(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function readNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function readBoolean(record: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

function readStringArray(record: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim());
    }
  }
  return [];
}

function readStringArrayFromRecords(records: Record<string, unknown>[], keys: string[]): string[] {
  return records.flatMap((record) => readStringArray(record, keys));
}

function readParentSessionId(record: Record<string, unknown>): string | undefined {
  return readString(record, ['parentSessionId', 'parent_session_id', 'parentId', 'parent_id', 'parent']);
}

function readWorkflowId(record: Record<string, unknown>): string | undefined {
  return readString(record, ['workflowId', 'workflow_id', 'workflow', 'runId', 'run_id']);
}

function readSessionMetadata(record: Record<string, unknown>): AgentSession['metadata'] | undefined {
  const metadata = asRecord(record.metadata);
  const role =
    readString(record, ['role', 'agentRole', 'agent_role']) ??
    readString(metadata, ['role', 'agentRole', 'agent_role']);
  if (!role) return metadata && hasScalarMetadata(metadata) ? copyScalarMetadata(metadata) : undefined;
  return { ...copyScalarMetadata(metadata), role };
}

function hasScalarMetadata(metadata: Record<string, unknown>): boolean {
  return Object.values(metadata).some(isScalarMetadataValue);
}

function copyScalarMetadata(metadata: Record<string, unknown> | undefined): AgentSession['metadata'] {
  const scalars: NonNullable<AgentSession['metadata']> = {};
  if (!metadata) return scalars;
  for (const [key, value] of Object.entries(metadata)) {
    if (isScalarMetadataValue(value)) scalars[key] = value;
  }
  return scalars;
}

function isScalarMetadataValue(value: unknown): value is string | number | boolean | null | undefined {
  return value === null || value === undefined || ['string', 'number', 'boolean'].includes(typeof value);
}

function normalizeSessionState(value: string): SessionState {
  const normalized = value.toLowerCase().replaceAll('-', '_');
  if (normalized === 'waiting' || normalized === 'waiting_for_input' || normalized === 'needs_input') return 'waiting_for_input';
  if (normalized === 'blocked') return 'blocked';
  if (normalized === 'complete' || normalized === 'completed' || normalized === 'success') return 'completed';
  if (normalized === 'failed' || normalized === 'error') return 'failed';
  if (normalized === 'running' || normalized === 'in_progress') return 'running';
  if (normalized === 'idle') return 'idle';
  return 'unknown';
}

type CapabilityOverrides = Partial<Record<string, Partial<Pick<CapabilityMatrixEntry, 'command' | 'parseFormat'>>>>;

function buildCapabilities(
  statuses: Map<string, CapabilityMatrixEntry['status']>,
  overrides: CapabilityOverrides = {}
): CapabilityMatrixEntry[] {
  return BASE_CAPABILITIES.map(({ defaultStatus, ...entry }) => {
    const status = statuses.get(entry.field) ?? defaultStatus ?? 'unknown';
    return {
      ...entry,
      ...overrides[entry.field],
      status,
      observation: status === 'available' ? 'observed' : status === 'unknown' ? 'inferred' : 'unavailable'
    };
  });
}

export function assertReadOnlyRpCliArgs(args: string[]): void {
  if (args.length === 1 && args[0] === '--help') return;
  if (args.length === 2 && args[0] === '-e' && args[1] === 'windows') return;
  if (args.length === 3 && args[0] === '-e' && args[1] === 'windows' && args[2] === '--raw-json') return;
  if (args.length === 4 && args[0] === '-c' && args[1] === 'agent_manage' && args[2] === '-j') {
    assertReadOnlyAgentManagePayload(args[3] ?? '');
    return;
  }
  throw new Error(`Refusing unsupported rp-cli command: ${args.join(' ')}`);
}

function assertReadOnlyAgentManagePayload(json: string): void {
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    throw new Error('Refusing malformed agent_manage payload.');
  }

  if (!isRecord(payload) || payload.op !== 'list_sessions') {
    throw new Error(`Refusing mutating agent_manage operation: ${json}`);
  }

  const allowedKeys = new Set(['op', 'limit', 'working_dirs', 'context_id', 'window_id', '_windowID']);
  for (const key of Object.keys(payload)) {
    if (!allowedKeys.has(key)) throw new Error(`Refusing unsupported list_sessions selector: ${key}`);
  }

  const limit = payload.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('Refusing list_sessions payload without bounded integer limit.');
  }
  if ('working_dirs' in payload && (!Array.isArray(payload.working_dirs) || !payload.working_dirs.every((value) => typeof value === 'string' && value.trim().length > 0))) {
    throw new Error('Refusing list_sessions payload with invalid working_dirs selector.');
  }
  if ('context_id' in payload && (typeof payload.context_id !== 'string' || payload.context_id.trim().length === 0)) {
    throw new Error('Refusing list_sessions payload with invalid context_id selector.');
  }
  const windowId = payload.window_id;
  if ('window_id' in payload && (typeof windowId !== 'number' || !Number.isInteger(windowId) || windowId < 1)) {
    throw new Error('Refusing list_sessions payload with invalid window_id selector.');
  }
  const hiddenWindowId = payload._windowID;
  if ('_windowID' in payload && (typeof hiddenWindowId !== 'number' || !Number.isInteger(hiddenWindowId) || hiddenWindowId < 1)) {
    throw new Error('Refusing list_sessions payload with invalid _windowID selector.');
  }
}

function describeFailure(output: string): string {
  const trimmed = output.trim();
  const lower = trimmed.toLowerCase();
  if (!trimmed) return 'Command failed without output.';
  if (lower.includes('permission denied')) return 'RepoPrompt socket access failed: permission denied.';
  if (trimmed.includes('Multiple RepoPrompt windows detected')) return 'RepoPrompt requires explicit context/window binding before this call.';
  if (trimmed.includes('ENOENT')) return 'rp-cli executable was not found.';
  return trimmed.split(/\r?\n/).filter((line) => line.trim() && line.trim() !== 'Error:').slice(0, 4).join('\n') || trimmed.split(/\r?\n/).slice(0, 4).join('\n');
}

function classifySessionFailure(stderr: string): SessionFailureCode {
  const lower = stderr.toLowerCase();
  if (lower.includes('permission denied')) return 'repoprompt_socket_permission_denied';
  if (stderr.includes('Multiple RepoPrompt windows detected')) return 'session_status_requires_binding';
  return 'agent_sessions_unavailable';
}

function isRetryableSessionFailure(code: SessionFailureCode): boolean {
  return code === 'session_status_requires_binding' || code === 'agent_sessions_unavailable';
}
