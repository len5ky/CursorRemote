import { randomBytes } from 'crypto';
import type { CursorState, ChatElement } from '../../types.js';

/**
 * Closed tool surface exposed to the Realtime model. Mirrors the Telegram
 * command vocabulary. Informational tools execute immediately; mutating tools
 * return a pending-confirmation token that must be echoed back verbally to the
 * user and then confirmed via confirm_pending(token) — enforced server-side.
 */

export interface VoiceSession {
  /** windowId of the sticky current target (like TopicManager's active thread). */
  windowId?: string;
  /** tab title of the sticky current target. */
  tabTitle?: string;
}

export interface PendingConfirmation {
  token: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  createdAt: number;
}

export interface SessionSummary {
  windowId: string;
  windowTitle: string;
  tabs: { title: string; isActive: boolean; status: string }[];
}

/** Everything the router needs, decoupled from CDP for testability. */
export interface VoiceToolDeps {
  getState(): CursorState;
  listSessions(): SessionSummary[];
  /** Ensure the given window (and optionally tab) is active in Cursor. */
  activateTarget(windowId: string, tabTitle?: string): Promise<void>;
  sendMessage(text: string): Promise<void>;
  clickApproval(selectorPath: string): Promise<void>;
  clickAction(selectorPath: string, label?: string): Promise<void>;
  setMode(modeId: string): Promise<void>;
  setModel(modelId: string): Promise<void>;
  /** Spoken-form 2-3 sentence digest of recent transcript / state. */
  digest(messages: ChatElement[], state: CursorState): Promise<string>;
}

const CONFIRM_TTL_MS = 90_000;

const MUTATING_TOOLS = new Set([
  'send_to_session',
  'approve',
  'reject',
  'run_action',
  'skip_action',
  'set_mode',
  'set_model',
  'cancel',
]);

export function isMutatingTool(name: string): boolean {
  return MUTATING_TOOLS.has(name);
}

/** JSON tool schemas for the Realtime session config. */
export const VOICE_TOOL_SCHEMAS = [
  {
    type: 'function',
    name: 'list_sessions',
    description: 'List all Cursor windows and their agent chat tabs. Use to discover what sessions exist.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'set_target',
    description: 'Set the sticky current target session by window title (fuzzy) and optional tab title. Subsequent tools apply to this target.',
    parameters: {
      type: 'object',
      properties: {
        window: { type: 'string', description: 'Window/project title, fuzzy matched' },
        tab: { type: 'string', description: 'Optional tab title, fuzzy matched' },
      },
      required: ['window'],
    },
  },
  {
    type: 'function',
    name: 'get_status',
    description: 'Spoken-form status summary of the current target session (agent state, pending approvals).',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'get_all_status',
    description: 'Brief spoken-form status of every session.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'read_recent',
    description: 'Summarize the recent transcript tail of the current target session in spoken form.',
    parameters: {
      type: 'object',
      properties: { count: { type: 'number', description: 'How many recent items to include (default 6)' } },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'send_to_session',
    description: 'Send a prompt/message to the current target session. Mutating: returns a confirmation token; read the message back to the user, then call confirm_pending.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The message to send' } },
      required: ['text'],
    },
  },
  {
    type: 'function',
    name: 'approve',
    description: 'Approve the pending approval in the current target session. Mutating: requires confirm_pending.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'reject',
    description: 'Reject the pending approval in the current target session. Mutating: requires confirm_pending.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'run_action',
    description: 'Run the pending command in the current target session (the Run button). Mutating: requires confirm_pending.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'skip_action',
    description: 'Skip the pending command in the current target session (the Skip button). Mutating: requires confirm_pending.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'set_mode',
    description: 'Switch the agent mode (e.g. agent, plan) in the current target session. Mutating: requires confirm_pending.',
    parameters: {
      type: 'object',
      properties: { mode: { type: 'string', description: 'Mode id, e.g. "agent" or "plan"' } },
      required: ['mode'],
    },
  },
  {
    type: 'function',
    name: 'set_model',
    description: 'Switch the model in the current target session. Mutating: requires confirm_pending.',
    parameters: {
      type: 'object',
      properties: { model: { type: 'string', description: 'Model name or id' } },
      required: ['model'],
    },
  },
  {
    type: 'function',
    name: 'cancel',
    description: 'Cancel/reject whatever is pending in the current target session (alias of reject). Mutating: requires confirm_pending.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'confirm_pending',
    description: 'Execute a previously returned pending mutation after verbally reading it back to the user and getting their assent. Pass the exact token.',
    parameters: {
      type: 'object',
      properties: { token: { type: 'string' } },
      required: ['token'],
    },
  },
] as const;

export interface ToolResult {
  ok: boolean;
  /** Text handed back to the model as the function_call_output. */
  output: string;
  /** True when this call created a pending confirmation. */
  pending?: boolean;
}

function fuzzyIncludes(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.trim().toLowerCase());
}

export class VoiceToolRouter {
  private deps: VoiceToolDeps;
  private session: VoiceSession = {};
  private pending = new Map<string, PendingConfirmation>();

  constructor(deps: VoiceToolDeps) {
    this.deps = deps;
  }

  get currentTarget(): VoiceSession {
    return { ...this.session };
  }

  /** For tests: peek at pending confirmations. */
  getPending(token: string): PendingConfirmation | undefined {
    this.sweepExpired();
    return this.pending.get(token);
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [token, p] of this.pending) {
      if (now - p.createdAt > CONFIRM_TTL_MS) this.pending.delete(token);
    }
  }

  private createPending(tool: string, args: Record<string, unknown>, summary: string): ToolResult {
    this.sweepExpired();
    const token = randomBytes(6).toString('hex');
    this.pending.set(token, { token, tool, args, summary, createdAt: Date.now() });
    return {
      ok: true,
      pending: true,
      output: `PENDING CONFIRMATION. Read this back to the user and get assent, then call confirm_pending with token "${token}". Action: ${summary}`,
    };
  }

  private targetWindowId(): string | undefined {
    if (this.session.windowId) return this.session.windowId;
    const state = this.deps.getState();
    return state.activeWindowId || undefined;
  }

  private async ensureTargetActive(): Promise<void> {
    const winId = this.targetWindowId();
    if (!winId) throw new Error('No target session. Ask the user which session to target, then call set_target.');
    await this.deps.activateTarget(winId, this.session.tabTitle);
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      switch (name) {
        case 'list_sessions': return this.listSessions();
        case 'set_target': return this.setTarget(args);
        case 'get_status': return await this.getStatus();
        case 'get_all_status': return this.getAllStatus();
        case 'read_recent': return await this.readRecent(args);
        case 'confirm_pending': return await this.confirmPending(args);
        default:
          if (isMutatingTool(name)) return this.stageMutation(name, args);
          return { ok: false, output: `Unknown tool: ${name}` };
      }
    } catch (err) {
      return { ok: false, output: err instanceof Error ? err.message : String(err) };
    }
  }

  // --- informational ---

  private listSessions(): ToolResult {
    const sessions = this.deps.listSessions();
    if (sessions.length === 0) return { ok: true, output: 'No Cursor sessions are connected right now.' };
    const lines = sessions.map(s => {
      const tabs = s.tabs.map(t => `${t.title}${t.isActive ? ' (active)' : ''}`).join(', ') || 'no tabs';
      return `${s.windowTitle}: ${tabs}`;
    });
    return { ok: true, output: lines.join('\n') };
  }

  private setTarget(args: Record<string, unknown>): ToolResult {
    const window = typeof args.window === 'string' ? args.window : '';
    const tab = typeof args.tab === 'string' ? args.tab : undefined;
    if (!window) return { ok: false, output: 'set_target requires a window name.' };

    const sessions = this.deps.listSessions();
    const matches = sessions.filter(s => fuzzyIncludes(s.windowTitle, window));
    if (matches.length === 0) {
      return { ok: false, output: `No session matches "${window}". Known: ${sessions.map(s => s.windowTitle).join('; ') || 'none'}` };
    }
    if (matches.length > 1) {
      return { ok: false, output: `Ambiguous: ${matches.map(s => s.windowTitle).join('; ')}. Ask the user which one.` };
    }
    const win = matches[0];
    let tabTitle: string | undefined;
    if (tab) {
      const tabMatches = win.tabs.filter(t => fuzzyIncludes(t.title, tab));
      if (tabMatches.length === 0) {
        return { ok: false, output: `No tab matches "${tab}" in ${win.windowTitle}. Tabs: ${win.tabs.map(t => t.title).join('; ') || 'none'}` };
      }
      if (tabMatches.length > 1) {
        return { ok: false, output: `Ambiguous tab: ${tabMatches.map(t => t.title).join('; ')}. Ask the user which one.` };
      }
      tabTitle = tabMatches[0].title;
    }
    this.session = { windowId: win.windowId, tabTitle };
    return { ok: true, output: `Target set to ${win.windowTitle}${tabTitle ? `, tab ${tabTitle}` : ''}.` };
  }

  private async getStatus(): Promise<ToolResult> {
    const state = this.deps.getState();
    const text = await this.deps.digest([], state);
    return { ok: true, output: text };
  }

  private getAllStatus(): ToolResult {
    const sessions = this.deps.listSessions();
    const state = this.deps.getState();
    if (sessions.length === 0) return { ok: true, output: 'No sessions connected.' };
    const lines = sessions.map(s => {
      const isActive = s.windowId === state.activeWindowId;
      const activeTab = s.tabs.find(t => t.isActive);
      const status = isActive ? state.agentStatus : (activeTab?.status || 'unknown');
      return `${s.windowTitle}: ${status}${isActive && state.pendingApprovals.length > 0 ? `, ${state.pendingApprovals.length} pending approval(s)` : ''}`;
    });
    return { ok: true, output: lines.join('. ') };
  }

  private async readRecent(args: Record<string, unknown>): Promise<ToolResult> {
    const count = typeof args.count === 'number' && args.count > 0 ? Math.min(args.count, 20) : 6;
    const state = this.deps.getState();
    const tail = state.messages.slice(-count);
    if (tail.length === 0) return { ok: true, output: 'The transcript is empty.' };
    const text = await this.deps.digest(tail, state);
    return { ok: true, output: text };
  }

  // --- mutating: stage + confirm ---

  private stageMutation(name: string, args: Record<string, unknown>): ToolResult {
    const state = this.deps.getState();
    switch (name) {
      case 'send_to_session': {
        const text = typeof args.text === 'string' ? args.text.trim() : '';
        if (!text) return { ok: false, output: 'send_to_session requires text.' };
        return this.createPending(name, { text }, `send "${text}" to the current session`);
      }
      case 'approve':
      case 'reject':
      case 'cancel': {
        const approval = state.pendingApprovals[0];
        if (!approval) return { ok: false, output: 'There is no pending approval right now.' };
        const wanted = name === 'approve' ? 'approve' : 'reject';
        const action = approval.actions.find(a => a.type === wanted)
          ?? (wanted === 'approve' ? approval.actions.find(a => a.type === 'approve_all') : undefined);
        if (!action) return { ok: false, output: `No ${wanted} button available for the pending approval.` };
        return this.createPending(name, { selectorPath: action.selectorPath }, `${wanted} the pending approval: ${approval.description.substring(0, 140)}`);
      }
      case 'run_action':
      case 'skip_action': {
        const wanted = name === 'run_action' ? 'run' : 'skip';
        const runCmd = [...state.messages].reverse().find(
          (m): m is Extract<ChatElement, { type: 'run_command' }> => m.type === 'run_command'
        );
        const act = runCmd?.actions.find(a => a.type === wanted)
          ?? (wanted === 'run' ? runCmd?.actions.find(a => a.type === 'allow') : undefined);
        if (!runCmd || !act) return { ok: false, output: `There is no pending command to ${wanted}.` };
        return this.createPending(
          name,
          { selectorPath: act.selectorPath, label: act.label },
          `${wanted} the pending command: ${runCmd.command || runCmd.description}`.substring(0, 180)
        );
      }
      case 'set_mode': {
        const mode = typeof args.mode === 'string' ? args.mode.trim() : '';
        if (!mode) return { ok: false, output: 'set_mode requires a mode.' };
        return this.createPending(name, { mode }, `switch mode to ${mode}`);
      }
      case 'set_model': {
        const model = typeof args.model === 'string' ? args.model.trim() : '';
        if (!model) return { ok: false, output: 'set_model requires a model.' };
        return this.createPending(name, { model }, `switch model to ${model}`);
      }
      default:
        return { ok: false, output: `Unknown mutating tool: ${name}` };
    }
  }

  private async confirmPending(args: Record<string, unknown>): Promise<ToolResult> {
    const token = typeof args.token === 'string' ? args.token.trim() : '';
    this.sweepExpired();
    const pending = token ? this.pending.get(token) : undefined;
    if (!pending) {
      return { ok: false, output: 'No such pending confirmation (wrong token, already executed, or expired). Stage the action again.' };
    }
    this.pending.delete(token); // single-use

    await this.ensureTargetActive();
    const a = pending.args;
    switch (pending.tool) {
      case 'send_to_session':
        await this.deps.sendMessage(a.text as string);
        return { ok: true, output: 'Message sent.' };
      case 'approve':
      case 'reject':
      case 'cancel':
        await this.deps.clickApproval(a.selectorPath as string);
        return { ok: true, output: `Done: ${pending.summary}.` };
      case 'run_action':
      case 'skip_action':
        await this.deps.clickAction(a.selectorPath as string, a.label as string | undefined);
        return { ok: true, output: `Done: ${pending.summary}.` };
      case 'set_mode':
        await this.deps.setMode(a.mode as string);
        return { ok: true, output: `Mode switched to ${a.mode}.` };
      case 'set_model':
        await this.deps.setModel(a.model as string);
        return { ok: true, output: `Model switched to ${a.model}.` };
      default:
        return { ok: false, output: `Cannot execute unknown staged tool: ${pending.tool}` };
    }
  }
}
