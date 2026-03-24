// Core relay state and chat element typings.
export interface CursorWindow {
  id: string;
  title: string;
  url: string;
  wsUrl?: string;
}

/** Raw DOM element snapshot — what was actually in the DOM, independent of parsing. */
export interface RawElement {
  flatIndex: number;
  role?: string;
  kind?: string;
  messageId?: string;
  toolCallId?: string;
  toolStatus?: string;
  /** Key CSS class/element indicators found on this wrapper. */
  indicators: string[];
  /** First ~120 chars of textContent. */
  textPreview: string;
  /** What ChatElement type the parser decided this was (or 'skipped'). */
  parsedAs: string;
}

export interface RawSignals {
  shimmer: Array<{ text: string; inToolCall: boolean; inHeader: boolean }>;
  loadingIndicator: boolean;
  statusEl?: { text: string; classes: string };
  /** Per-element DOM inventory — raw attributes and indicator classes for every [data-flat-index]. */
  elements: RawElement[];
  /** Activity-related elements NOT inside any [data-flat-index] wrapper. */
  orphanIndicators: Array<{ cls: string; text: string; parentCls: string }>;
}

export interface ComposerQueueItem {
  id: string;
  text: string;
}

export interface ComposerQueueState {
  items: ComposerQueueItem[];
  /** e.g. "2 Queued" from toolbar header */
  queueLabel?: string;
}

export interface CursorState {
  connected: boolean;
  agentStatus: AgentStatus;
  /** Live activity label; null means explicitly cleared on the wire. */
  agentActivityText: string | null;
  /** True only when the server believes work is actively in progress right now. */
  agentActivityLive: boolean;
  /** Provenance of the current activity signal, for transports/debugging. */
  agentActivitySource: ActivitySource;
  messages: ChatElement[];
  pendingApprovals: Approval[];
  inputAvailable: boolean;
  chatTabs: ChatTab[];
  mode: ModeInfo;
  model: ModelInfo;
  windows: CursorWindow[];
  activeWindowId: string;
  /** Prompts queued in composer toolbar (outside transcript). */
  composerQueue: ComposerQueueState;
  _rawSignals?: RawSignals;
}

export interface ChatTab {
  composerId: string;
  title: string;
  isActive: boolean;
  status: string;
  selectorPath: string;
}

export interface ModeInfo {
  current: string;
  available: { id: string; label: string; icon: string }[];
}

export interface ModelInfo {
  current: string;
  currentId: string;
}

export type AgentStatus =
  | 'idle'
  | 'thinking'
  | 'generating'
  | 'running_tool'
  | 'waiting_approval'
  | 'error';

export type ActivitySource =
  | 'none'
  | 'shimmer'
  | 'loading_tool'
  | 'loading_indicator'
  | 'tail_thought';

export type ChatElement =
  | HumanMessage
  | AssistantMessage
  | ToolCallElement
  | ThoughtBlock
  | PlanBlock
  | TodoListBlock
  | RunCommand
  | LoadingIndicator;

export interface HumanMessage {
  type: 'human';
  id: string;
  flatIndex: number;
  text: string;
  mentions: { name: string; mentionType: string }[];
  /** Quoted / reply preview from composer (e.g. ProseMirror blockquote). */
  quoted?: { text: string };
}

export type DiffLineKind = 'add' | 'rem' | 'ctx' | 'meta' | 'hunk';

/** Native web/Telegram rendering: structured code or diff (no mirrored Monaco HTML). */
export interface CodeBlockItem {
  blockKind: 'code' | 'diff';
  filename?: string;
  language?: string;
  /** Flat joined text (search, fallback, simple pre) */
  code: string;
  /** Present when blockKind === 'diff'; line-level add/rem/ctx from live Monaco DOM */
  diffLines?: { kind: DiffLineKind; text: string }[];
}

export interface AssistantMessage {
  type: 'assistant';
  id: string;
  flatIndex: number;
  text: string;
  html: string;
  codeBlocks: CodeBlockItem[];
}

export interface ToolCallElement {
  type: 'tool';
  id: string;
  flatIndex: number;
  toolCallId: string;
  status: 'loading' | 'completed';
  action: string;
  details: string;
  filename?: string;
  additions?: number;
  deletions?: number;
  summaryText?: string;
  actions?: RunAction[];
  blocked?: string;
  /** Structured diff/code for edit tools; web client renders natively */
  diffBlock?: CodeBlockItem;
}

export interface ThoughtBlock {
  type: 'thought';
  id: string;
  flatIndex: number;
  duration: string;
  action?: string;
  detail?: string;
  /** Cursor step-group: umbrella row (e.g. Explored) vs inner thinking row */
  thoughtKind?: 'step_summary' | 'thinking_step';
}

export interface PlanTodo {
  text: string;
  status: 'pending' | 'completed' | 'in_progress';
}

export interface PlanAction {
  label: string;
  type: 'view_plan' | 'build';
  selectorPath: string;
}

export interface PlanBlock {
  type: 'plan';
  id: string;
  flatIndex: number;
  label: string;
  title: string;
  todosCompleted: number;
  todosTotal: number;
  description?: string;
  /** Raw markdown HTML from `.composer-create-plan-text .markdown-root` (web client). */
  descriptionHtml?: string;
  todos?: PlanTodo[];
  /** Hidden todo rows behind "N more" in Cursor (estimated). */
  todosMoreCount?: number;
  model?: string;
  /** Click to open plan-scoped model dropdown in Cursor. */
  modelDropdownSelectorPath?: string;
  actions?: PlanAction[];
}

export interface TodoListBlock {
  type: 'todo_list';
  id: string;
  flatIndex: number;
  title: string;
  todosCompleted: number;
  todosTotal: number;
  todos: PlanTodo[];
}

export interface RunAction {
  label: string;
  type: 'run' | 'skip' | 'allow';
  selectorPath: string;
}

export interface RunCommand {
  type: 'run_command';
  id: string;
  flatIndex: number;
  toolCallId: string;
  description: string;
  candidates: string;
  command: string;
  actions: RunAction[];
}

export interface LoadingIndicator {
  type: 'loading';
  id: string;
  flatIndex: number;
  text?: string;
}

export interface Approval {
  id: string;
  description: string;
  actions: ApprovalAction[];
}

export interface ApprovalAction {
  label: string;
  type: 'approve' | 'reject' | 'approve_all';
  selectorPath: string;
}

export interface SelectorStrategy {
  strategies: string[];
  textMatch?: string[];
}

export interface SelectorConfig {
  chatContainer: SelectorStrategy;
  approveButton: SelectorStrategy;
  rejectButton: SelectorStrategy;
  chatInput: SelectorStrategy;
  agentStatus: SelectorStrategy;
  [key: string]: SelectorStrategy;
}

export interface CommandPayload {
  commandId: string;
  type: 'send_message' | 'approve' | 'reject' | 'approve_all' | 'switch_tab' | 'new_chat' | 'set_mode' | 'set_model' | 'click_action';
  text?: string;
  approvalId?: string;
  actionType?: string;
  selectorPath?: string;
  composerId?: string;
  modeId?: string;
  modelId?: string;
  tabTitle?: string;
  windowId?: string;
}

export interface CommandResult {
  commandId: string;
  ok: boolean;
  error?: string;
}

export interface ServerConfig {
  cdpUrl: string;
  serverPort: number;
  serverHost: string;
  pollIntervalMs: number;
  debounceMs: number;
  selectorsPath: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  webappPassword: string;
  windowTitleQualifier: boolean;
  dataDir: string;
  telegram: TelegramConfig;
}

export interface TelegramConfig {
  enabled: boolean;
  botToken: string;
  preRegisteredUsers: number[];
}
