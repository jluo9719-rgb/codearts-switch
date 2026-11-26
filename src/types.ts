export type SwitchAgentId = 'claude' | 'codex' | 'dsh';
export type AgentId = SwitchAgentId;
export type SwitchMode = 'zero-intrusion' | 'merge-global';
export type ProtocolType = 'anthropic-messages' | 'openai-responses' | 'openai-chat';

// =========================================================================
// Go CodeArts2API /admin/api/* exact contract types
// =========================================================================

export interface AdminAccount {
  id: string;
  name: string;
  source: 'login' | 'desktop' | 'manual' | string;
  user_data?: string;
  enabled: boolean;
  status: 'ok' | 'expired' | 'error' | 'cooling' | string;
  note?: string;
  last_err?: string;
  failures: number;
  last_used?: string | null;
  last_claim_date?: string;
  last_claim_at?: string;
  last_claim_err?: string;
  last_claim_msg?: string;
  claimed_today?: boolean;
  access_key?: string;
  expires_at?: number;
  expires_in?: number;
  has_refresh?: boolean;
  domain_id?: string;
  permanent?: boolean;
}

export interface AdminKey {
  key: string; // masked in list responses (e.g. ca2a-xxxx••••yyyy)
  name: string;
  enabled: boolean;
  created_at: string | number;
  last_used?: string | number | null;
  requests: number;
}

export interface AdminModel {
  id: string;
  name?: string;
  source: 'upstream' | 'fallback' | 'alias' | string;
  target?: string;
  context_window?: number;
  max_tokens?: number;
  credit_multiplier?: number;
  multiplier?: number;
  supports_images?: boolean;
  supports_tools?: boolean;
  stream_only?: boolean;
  enable?: boolean;
  description?: string;
}

export interface AdminSettings {
  model_aliases: Record<string, string>;
  default_model: string;
  force_model: string;
  request_timeout_sec: number;
  max_retries: number;
  log_keep: number;
  cors_origin: string;
  auto_refresh: boolean;
  allow_credit_models: boolean;
  allow_anonymous: boolean;
  rate_limit_enabled: boolean;
  rate_limit_qps: number;
  rate_limit_burst: number;
  rate_limit_concurrency: number;
  auto_claim: boolean;
  claim_after_hour: number;
  claim_after_minute: number;
  write_back_to_ide: boolean;
  live_ttl_sec: number;
  user_data_dir: string;
  login_port: number;
  plugin_name: string;
  plugin_version: string;
  ide_name: string;
  ide_version: string;
  language: string;
  admin_password_set: boolean;
}

export interface AdminStats {
  total_requests: number;
  failed_requests: number;
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_output_chars?: number;
  uptime_sec?: number;
  started_at?: string;
}

export interface AdminLogEntry {
  id?: string;
  at?: string | number;
  time?: string | number;
  account?: string;
  model: string;
  protocol?: ProtocolType | string;
  path?: string;
  status: number;
  latency_ms?: number;
  duration_ms?: number;
  input_tokens?: number;
  in_tokens?: number;
  output_tokens?: number;
  out_tokens?: number;
  out_chars?: number;
  usage_source?: 'upstream' | 'estimated';
  error?: string;
}

export interface AdminCreditInfo {
  available: boolean;
  plan_name?: string;
  total?: number;
  used?: number;
  remaining?: number;
  reset_at?: string;
  expires_at?: string;
  updated_at?: string;
  note?: string;
}

export interface AdminCreditAccount {
  id: string;
  name: string;
  ok: boolean;
  error?: string;
  credit?: AdminCreditInfo;
}

export type RuntimeMode = 'go-bridge' | 'go-embed' | 'node-preview';

export interface AdminStateResponse {
  today: string;
  gateway_port?: number;
  gateway_host?: string;
  runtime_mode?: RuntimeMode;
  go_upstream?: string;
  accounts: AdminAccount[];
  keys: AdminKey[];
  models: AdminModel[];
  settings: AdminSettings;
  stats: AdminStats;
  upstream_error: string;
  state_warning?: string;
}

export interface ModelProbeItem {
  model: string;
  ok: boolean;
  account?: string;
  error?: string;
  latency_ms?: number;
}

export interface ModelProbeResponse {
  ok: boolean;
  total: number;
  available: number;
  unavailable: number;
  results: ModelProbeItem[];
}

export interface LoginStartResponse {
  ok?: boolean;
  session_id?: string;
  id?: string;
  auth_url?: string;
  url?: string;
  port?: number;
  callback_port?: number;
  expires_at?: string;
  preview_mode?: boolean;
}

export interface LoginPollResponse {
  status?: 'pending' | 'confirmed' | 'done' | 'error' | 'expired' | 'cancelled' | string;
  state?: string;
  message?: string;
  error?: string;
  account_id?: string;
  account_name?: string;
}

// =========================================================================
// /admin/api/switch/* — Dual-Mode Zero-Conflict Switcher Contract
// =========================================================================

export interface ClaudeProfileConfig {
  primaryModel: string;
  sonnetModel: string;
  opusModel: string;
  haikuModel: string;
}

export interface CodexProfileConfig {
  model: string;
  wireApi: 'responses' | 'chat';
  approvalPolicy: 'on-request' | 'untrusted' | 'never';
  authMode?: 'desktop-direct' | 'env-key';
  fallbackUnknownModel?: boolean;
}

export interface DshProfileConfig {
  model: string;
  fallbackModel: string;
  telemetryDisabled: boolean;
}

export interface SwitchProfilesState {
  claude: ClaudeProfileConfig;
  codex: CodexProfileConfig;
  dsh: DshProfileConfig;
}

export interface SwitchAgentDetection {
  agentId: SwitchAgentId;
  configPath: string;
  configExists: boolean;
  historyPath: string;
  managedBy: 'codearts-switch' | 'cc-switch-or-custom' | 'official-or-empty';
  currentBaseUrl?: string;
  preservedItems: string[]; // e.g. ["hooks", "permissions", "mcp_servers"]
  hasBackup: boolean;
  lastBackupAt?: string;
  backupCount: number;
}

export interface SwitchDiffLine {
  type: 'same' | 'add' | 'remove';
  line: string;
}

export interface SwitchFilePreview {
  id: string;
  label: string;
  targetPath: string;
  beforeContent: string;
  afterContent: string;
  diffLines: SwitchDiffLine[];
  preservedKeys: string[];
  modifiedKeys: string[];
}

export interface ZeroIntrusionLaunchers {
  powershell: string;
  cmd: string;
  bash: string;
  aliasName: string;
  powershellAliasSnippet: string;
  cmdAliasSnippet: string;
  bashAliasSnippet: string;
  historySharedNote: string;
  overrideSettingsPath?: string;
}

export interface CodexCCSwitchSnippet {
  name: string;
  baseUrl: string;
  apiKey: string;
  wireApi: 'responses' | 'chat';
  model: string;
  tomlSnippet: string;
}

export interface SwitchPreviewResponse {
  ok: boolean;
  agentId: SwitchAgentId;
  gatewayBaseUrl: string;
  files: SwitchFilePreview[];
  zeroIntrusion: ZeroIntrusionLaunchers;
  ccSwitchProvider?: CodexCCSwitchSnippet;
  warning?: string;
}

export interface SwitchApplyResponse {
  ok: boolean;
  agentId: SwitchAgentId;
  writtenFiles: string[];
  snapshotId: string;
  snapshotPath: string;
  cliCommand: string;
  message: string;
}

export interface SwitchRestoreResponse {
  ok: boolean;
  agentId: SwitchAgentId;
  restoredFiles: string[];
  message: string;
}

export interface UpdateCheckResponse {
  ok: boolean;
  currentVersion: string;
  latestVersion?: string;
  hasUpdate?: boolean;
  releaseUrl: string;
  downloadUrl?: string;
  publishedAt?: string;
  releaseNotes?: string;
  error?: string;
}
