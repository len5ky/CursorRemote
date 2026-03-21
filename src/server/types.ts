export interface CursorWindow {
  id: string;
  title: string;
  url: string;
  wsUrl?: string;
}

export interface CursorState {
  connected: boolean;
  agentStatus: AgentStatus;
  messages: ChatElement[];
  pendingApprovals: Approval[];
  inputAvailable: boolean;
  chatTabs: ChatTab[];
  mode: ModeInfo;
  model: ModelInfo;
  windows: CursorWindow[];
  activeWindowId: string;
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
}

export interface AssistantMessage {
  type: 'assistant';
  id: string;
  flatIndex: number;
  text: string;
  html: string;
  codeBlocks: { language?: string; filename?: string; code: string }[];
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
}

export interface ThoughtBlock {
  type: 'thought';
  id: string;
  flatIndex: number;
  duration: string;
  action?: string;
  detail?: string;
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
  todos?: PlanTodo[];
  model?: string;
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
