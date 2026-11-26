import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  BUILTIN_FALLBACK_MODELS,
  DEFAULT_SWITCH_PROFILES,
  sanitizeModelId,
} from '../src/lib/switcherEngine';
import type {
  AdminAccount,
  AdminKey,
  AdminLogEntry,
  AdminModel,
  AdminSettings,
  AdminStateResponse,
  AdminStats,
  SwitchAgentId,
  SwitchProfilesState,
} from '../src/types';

export interface StoredGatewayKey {
  key: string;
  name: string;
  enabled: boolean;
  created_at: string;
  last_used: string | null;
  requests: number;
}

export interface StoredAccountRecord extends AdminAccount {
  credentials?: {
    access_key: string;
    secret_key: string;
    security_token?: string;
    refresh_token?: string;
    permanent?: boolean;
  };
}

interface PersistedSwitchState {
  version: number;
  accounts: StoredAccountRecord[];
  keys: StoredGatewayKey[];
  models: AdminModel[];
  settings: AdminSettings & { admin_password: string };
  stats: AdminStats;
  logs: AdminLogEntry[];
  switch_profiles: SwitchProfilesState;
  updated_at: string;
}

export function maskSecret(val: string): string {
  if (!val) return '';
  if (val.length <= 10) return '••••••••';
  return `${val.slice(0, 6)}••••${val.slice(-4)}`;
}

function getStateFilePath(): string {
  const dir = process.env.CODEARTS_SWITCH_DATA_DIR?.trim()
    ? path.resolve(process.env.CODEARTS_SWITCH_DATA_DIR.trim())
    : path.resolve(process.cwd(), 'data');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return path.join(dir, 'codearts-switch-state.json');
}

function buildDefaultState(): PersistedSwitchState {
  const now = new Date().toISOString();
  const initialKey = `ca2a-${crypto.randomBytes(18).toString('hex')}`;
  return {
    version: 1,
    accounts: [],
    keys: [
      {
        key: initialKey,
        name: '本机默认密钥',
        enabled: true,
        created_at: now,
        last_used: null,
        requests: 0,
      },
    ],
    models: BUILTIN_FALLBACK_MODELS.map((m) => ({ ...m })),
    settings: {
      model_aliases: {
        'claude-sonnet-4-5': 'GLM-5.3',
        'claude-opus-4-1': 'Kimi-K3.1-Pro',
        'claude-haiku-4-5': 'GLM-5.3-Flash',
      },
      default_model: 'GLM-5.3',
      force_model: '',
      request_timeout_sec: 300,
      max_retries: 3,
      log_keep: 500,
      cors_origin: '',
      auto_refresh: true,
      allow_credit_models: true,
      allow_anonymous: false,
      rate_limit_enabled: true,
      rate_limit_qps: 5,
      rate_limit_burst: 10,
      rate_limit_concurrency: 8,
      auto_claim: false,
      claim_after_hour: 0,
      claim_after_minute: 5,
      write_back_to_ide: false,
      live_ttl_sec: 10,
      user_data_dir: '',
      login_port: 18765,
      plugin_name: 'codearts-agent',
      plugin_version: '26.9.902',
      ide_name: 'CodeArts IDE',
      ide_version: '26.9.902',
      language: 'zh-cn',
      admin_password_set: false,
      admin_password: '',
    },
    stats: {
      total_requests: 0,
      failed_requests: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      started_at: now,
    },
    logs: [],
    switch_profiles: {
      claude: { ...DEFAULT_SWITCH_PROFILES.claude },
      codex: { ...DEFAULT_SWITCH_PROFILES.codex },
      dsh: { ...DEFAULT_SWITCH_PROFILES.dsh },
    },
    updated_at: now,
  };
}

class GoAlignedStore {
  private state: PersistedSwitchState;
  private stateWarning = '';
  private startedAtMs = Date.now();
  private activeRequestsByAccount = new Map<string, number>();

  constructor() {
    this.state = this.loadFromDisk();
  }

  private loadFromDisk(): PersistedSwitchState {
    const filePath = getStateFilePath();
    if (!fs.existsSync(filePath)) {
      const fresh = buildDefaultState();
      this.saveAtomic(fresh);
      return fresh;
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedSwitchState>;
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.keys)) {
        throw new Error('状态文件结构不完整');
      }
      const defaults = buildDefaultState();
      const migrateModelId = (id: string | undefined, fallback: string): string => {
        if (!id || !id.trim()) return fallback;
        const retired: Record<string, string> = {
          'DeepSeek-V3.2': 'DeepSeek-V4.1-Flash',
          'DeepSeek-R1': 'Kimi-K3.1-Pro',
          'Qwen3-Coder-480B': 'GLM-5.3',
          'Qwen3-235B-A22B': 'GLM-5.3-Flash',
          'Kimi-K2': 'Kimi-K3',
        };
        return retired[id.trim()] || id.trim();
      };

      const rawClaude = parsed.switch_profiles?.claude;
      const rawCodex = parsed.switch_profiles?.codex;
      const rawDsh = parsed.switch_profiles?.dsh;

      return {
        ...defaults,
        ...parsed,
        version: 1,
        accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
        keys: parsed.keys.length > 0 ? parsed.keys : defaults.keys,
        models:
          Array.isArray(parsed.models) &&
          parsed.models.some((m) => m && m.source === 'upstream')
            ? parsed.models
            : defaults.models,
        settings: {
          ...defaults.settings,
          ...(parsed.settings || {}),
          default_model: migrateModelId(parsed.settings?.default_model, defaults.settings.default_model),
        },
        stats: {
          ...defaults.stats,
          ...(parsed.stats || {}),
        },
        logs: Array.isArray(parsed.logs) ? parsed.logs : [],
        switch_profiles: {
          claude: {
            ...defaults.switch_profiles.claude,
            ...(rawClaude || {}),
            primaryModel: migrateModelId(rawClaude?.primaryModel, defaults.switch_profiles.claude.primaryModel),
            sonnetModel: migrateModelId(rawClaude?.sonnetModel, defaults.switch_profiles.claude.sonnetModel),
            opusModel: migrateModelId(rawClaude?.opusModel, defaults.switch_profiles.claude.opusModel),
            haikuModel: migrateModelId(rawClaude?.haikuModel, defaults.switch_profiles.claude.haikuModel),
          },
          codex: {
            ...defaults.switch_profiles.codex,
            ...(rawCodex || {}),
            model: migrateModelId(rawCodex?.model, defaults.switch_profiles.codex.model),
          },
          dsh: {
            ...defaults.switch_profiles.dsh,
            ...(rawDsh || {}),
            model: migrateModelId(rawDsh?.model, defaults.switch_profiles.dsh.model),
            fallbackModel: migrateModelId(rawDsh?.fallbackModel, defaults.switch_profiles.dsh.fallbackModel),
          },
        },
      };
    } catch (err) {
      // NEVER silently overwrite a corrupt state file — rename to .corrupt-<ts> and surface warning
      const corruptBackup = `${filePath}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(filePath, corruptBackup);
      } catch {
        // ignore rename error if file vanished
      }
      this.stateWarning = `检测到旧状态文件损坏，已原样备份至 ${path.basename(corruptBackup)}，当前已新建安全初始状态（${err instanceof Error ? err.message : '解析失败'}）。`;
      const fresh = buildDefaultState();
      this.saveAtomic(fresh);
      return fresh;
    }
  }

  private saveAtomic(targetState: PersistedSwitchState): void {
    const filePath = getStateFilePath();
    const tmp = `${filePath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(targetState, null, 2), 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
  }

  public persist(): void {
    this.state.updated_at = new Date().toISOString();
    this.saveAtomic(this.state);
  }

  public getEffectiveAdminPassword(): string {
    const envPw = process.env.CODEARTS_ADMIN_PASSWORD?.trim();
    if (envPw) return envPw;
    return this.state.settings.admin_password || '';
  }

  public getSanitizedSettings(): AdminSettings {
    const { admin_password: _hidden, ...rest } = this.state.settings;
    return {
      ...rest,
      admin_password_set: this.getEffectiveAdminPassword() !== '',
    };
  }

  public getAdminState(gatewayHost: string, gatewayPort: number): AdminStateResponse {
    const today = new Date().toISOString().slice(0, 10);
    const safeAccounts: AdminAccount[] = this.state.accounts.map((a) => {
      const { credentials: _strip, ...pub } = a;
      return {
        ...pub,
        claimed_today: a.last_claim_date === today,
      };
    });

    const safeKeys: AdminKey[] = this.state.keys.map((k) => ({
      key: maskSecret(k.key),
      name: k.name,
      enabled: k.enabled,
      created_at: k.created_at,
      last_used: k.last_used,
      requests: k.requests,
    }));

    return {
      today,
      gateway_host: gatewayHost,
      gateway_port: gatewayPort,
      accounts: safeAccounts,
      keys: safeKeys,
      models: this.state.models.map((m) => ({ ...m })),
      settings: this.getSanitizedSettings(),
      stats: {
        ...this.state.stats,
        uptime_sec: Math.floor((Date.now() - this.startedAtMs) / 1000),
      },
      upstream_error: '',
      ...(this.stateWarning ? { state_warning: this.stateWarning } : {}),
    };
  }

  public getAccounts(): StoredAccountRecord[] {
    return this.state.accounts;
  }

  public getAccountById(id: string): StoredAccountRecord | undefined {
    return this.state.accounts.find((a) => a.id === id);
  }

  public upsertAccount(account: StoredAccountRecord): boolean {
    const idx = this.state.accounts.findIndex((a) => a.id === account.id);
    if (idx >= 0) {
      this.state.accounts[idx] = account;
      this.persist();
      return false;
    }
    this.state.accounts.push(account);
    this.persist();
    return true;
  }

  public removeAccount(id: string): boolean {
    const before = this.state.accounts.length;
    this.state.accounts = this.state.accounts.filter((a) => a.id !== id);
    if (this.state.accounts.length !== before) {
      this.persist();
      return true;
    }
    return false;
  }

  public toggleAccount(id: string): boolean {
    const acc = this.state.accounts.find((a) => a.id === id);
    if (!acc) return false;
    acc.enabled = !acc.enabled;
    this.persist();
    return true;
  }

  public clearAccountErrors(id: string): boolean {
    const acc = this.state.accounts.find((a) => a.id === id);
    if (!acc) return false;
    acc.failures = 0;
    acc.last_err = '';
    acc.status = 'ok';
    this.persist();
    return true;
  }

  public hasKeys(): boolean {
    return this.state.keys.length > 0;
  }

  public getFirstActiveRawKey(): string {
    const active = this.state.keys.find((k) => k.enabled) || this.state.keys[0];
    return active?.key || '';
  }

  public getKeysMasked(): AdminKey[] {
    return this.state.keys.map((k) => ({
      key: maskSecret(k.key),
      name: k.name,
      enabled: k.enabled,
      created_at: k.created_at,
      last_used: k.last_used,
      requests: k.requests,
    }));
  }

  public verifyGatewayKey(candidate: string): boolean {
    if (!candidate) return false;
    const candHash = crypto.createHash('sha256').update(candidate.trim()).digest();
    for (const k of this.state.keys) {
      if (!k.enabled) continue;
      const keyHash = crypto.createHash('sha256').update(k.key).digest();
      if (crypto.timingSafeEqual(candHash, keyHash)) {
        k.requests += 1;
        k.last_used = new Date().toISOString();
        return true;
      }
    }
    return false;
  }

  public addKey(name: string): StoredGatewayKey {
    const item: StoredGatewayKey = {
      key: `ca2a-${crypto.randomBytes(18).toString('hex')}`,
      name: (name || '').trim() || `密钥 ${this.state.keys.length + 1}`,
      enabled: true,
      created_at: new Date().toISOString(),
      last_used: null,
      requests: 0,
    };
    this.state.keys.push(item);
    this.persist();
    return item;
  }

  public deleteKeyByRef(ref: string): boolean {
    const idx = this.state.keys.findIndex((k) => k.key === ref || maskSecret(k.key) === ref);
    if (idx < 0) return false;
    this.state.keys.splice(idx, 1);
    this.persist();
    return true;
  }

  public toggleKeyByRef(ref: string): boolean {
    const item = this.state.keys.find((k) => k.key === ref || maskSecret(k.key) === ref);
    if (!item) return false;
    item.enabled = !item.enabled;
    this.persist();
    return true;
  }

  public getModels(): AdminModel[] {
    return this.state.models;
  }

  public setModels(models: AdminModel[]): void {
    this.state.models = models;
    this.persist();
  }

  public getLogs(limit = 100): AdminLogEntry[] {
    const n = Math.min(Math.max(1, limit || 100), 500);
    return this.state.logs.slice(0, n);
  }

  public recordLog(entry: Omit<AdminLogEntry, 'id' | 'at'>): void {
    const logItem: AdminLogEntry = {
      ...entry,
      id: crypto.randomBytes(6).toString('hex'),
      at: new Date().toISOString(),
    };
    this.state.logs.unshift(logItem);
    const keep = Math.max(50, this.state.settings.log_keep || 500);
    if (this.state.logs.length > keep) {
      this.state.logs.length = keep;
    }
    this.state.stats.total_requests += 1;
    if (entry.status >= 400) {
      this.state.stats.failed_requests += 1;
    }
    this.state.stats.total_input_tokens =
      (this.state.stats.total_input_tokens ?? 0) + (entry.input_tokens ?? 0);
    this.state.stats.total_output_tokens =
      (this.state.stats.total_output_tokens ?? 0) + (entry.output_tokens ?? 0);
    this.persist();
  }

  public clearLogs(): void {
    this.state.logs = [];
    this.persist();
  }

  public clearStats(): void {
    this.state.stats = {
      total_requests: 0,
      failed_requests: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      started_at: new Date().toISOString(),
    };
    this.persist();
  }

  public updateSettings(
    patch: Partial<AdminSettings> & { admin_password?: string; clear_admin_password?: boolean }
  ): AdminSettings {
    const st = this.state.settings;
    if (patch.model_aliases && typeof patch.model_aliases === 'object') {
      st.model_aliases = patch.model_aliases;
    }
    if (typeof patch.default_model === 'string' && patch.default_model.trim()) {
      st.default_model = sanitizeModelId(patch.default_model);
    }
    if (typeof patch.force_model === 'string') {
      st.force_model = patch.force_model.trim() ? sanitizeModelId(patch.force_model) : '';
    }
    if (typeof patch.request_timeout_sec === 'number' && patch.request_timeout_sec >= 10) {
      st.request_timeout_sec = Math.min(900, Math.round(patch.request_timeout_sec));
    }
    if (typeof patch.max_retries === 'number' && patch.max_retries >= 1) {
      st.max_retries = Math.min(8, Math.round(patch.max_retries));
    }
    if (typeof patch.log_keep === 'number' && patch.log_keep >= 50) {
      st.log_keep = Math.min(5000, Math.round(patch.log_keep));
    }
    if (typeof patch.cors_origin === 'string') st.cors_origin = patch.cors_origin.trim();
    if (typeof patch.auto_refresh === 'boolean') st.auto_refresh = patch.auto_refresh;
    if (typeof patch.allow_credit_models === 'boolean')
      st.allow_credit_models = patch.allow_credit_models;
    if (typeof patch.allow_anonymous === 'boolean') st.allow_anonymous = patch.allow_anonymous;
    if (typeof patch.rate_limit_enabled === 'boolean')
      st.rate_limit_enabled = patch.rate_limit_enabled;
    if (typeof patch.rate_limit_qps === 'number' && patch.rate_limit_qps >= 1) {
      st.rate_limit_qps = Math.min(100, Math.round(patch.rate_limit_qps));
    }
    if (typeof patch.rate_limit_burst === 'number' && patch.rate_limit_burst >= 1) {
      st.rate_limit_burst = Math.min(200, Math.round(patch.rate_limit_burst));
    }
    if (typeof patch.rate_limit_concurrency === 'number' && patch.rate_limit_concurrency >= 1) {
      st.rate_limit_concurrency = Math.min(64, Math.round(patch.rate_limit_concurrency));
    }
    if (typeof patch.auto_claim === 'boolean') st.auto_claim = patch.auto_claim;
    if (typeof patch.write_back_to_ide === 'boolean') st.write_back_to_ide = patch.write_back_to_ide;
    if (typeof patch.login_port === 'number' && patch.login_port >= 10000 && patch.login_port <= 65535) {
      st.login_port = Math.round(patch.login_port);
    }
    if (typeof patch.plugin_name === 'string') st.plugin_name = patch.plugin_name.trim();
    if (typeof patch.plugin_version === 'string') st.plugin_version = patch.plugin_version.trim();
    if (typeof patch.ide_name === 'string') st.ide_name = patch.ide_name.trim();
    if (typeof patch.ide_version === 'string') st.ide_version = patch.ide_version.trim();
    if (typeof patch.language === 'string') st.language = patch.language.trim();

    if (patch.clear_admin_password === true) {
      st.admin_password = '';
    } else if (typeof patch.admin_password === 'string' && patch.admin_password.trim()) {
      st.admin_password = patch.admin_password.trim();
    }

    this.persist();
    return this.getSanitizedSettings();
  }

  public getSwitchProfiles(): SwitchProfilesState {
    return {
      claude: { ...this.state.switch_profiles.claude },
      codex: { ...this.state.switch_profiles.codex },
      dsh: { ...this.state.switch_profiles.dsh },
    };
  }

  public updateSwitchProfile(
    agentId: SwitchAgentId,
    patch: Record<string, unknown>
  ): SwitchProfilesState {
    if (agentId === 'claude') {
      const c = this.state.switch_profiles.claude;
      if (typeof patch.primaryModel === 'string') c.primaryModel = sanitizeModelId(patch.primaryModel);
      if (typeof patch.sonnetModel === 'string') c.sonnetModel = sanitizeModelId(patch.sonnetModel);
      if (typeof patch.opusModel === 'string') c.opusModel = sanitizeModelId(patch.opusModel);
      if (typeof patch.haikuModel === 'string') c.haikuModel = sanitizeModelId(patch.haikuModel);
    } else if (agentId === 'codex') {
      const cx = this.state.switch_profiles.codex;
      if (typeof patch.model === 'string') cx.model = sanitizeModelId(patch.model);
      if (patch.wireApi === 'responses' || patch.wireApi === 'chat') cx.wireApi = patch.wireApi;
      if (
        patch.approvalPolicy === 'on-request' ||
        patch.approvalPolicy === 'untrusted' ||
        patch.approvalPolicy === 'never'
      ) {
        cx.approvalPolicy = patch.approvalPolicy;
      }
      if (patch.authMode === 'desktop-direct' || patch.authMode === 'env-key') {
        cx.authMode = patch.authMode;
      }
    } else {
      const d = this.state.switch_profiles.dsh;
      if (typeof patch.model === 'string') d.model = sanitizeModelId(patch.model);
      if (typeof patch.fallbackModel === 'string') d.fallbackModel = sanitizeModelId(patch.fallbackModel);
      if (typeof patch.telemetryDisabled === 'boolean') d.telemetryDisabled = patch.telemetryDisabled;
    }
    this.persist();
    return this.getSwitchProfiles();
  }

  public acquireAccountSlot(accountId: string, maxConcurrent = 3): (() => void) | null {
    const current = this.activeRequestsByAccount.get(accountId) || 0;
    if (current >= maxConcurrent) return null;
    this.activeRequestsByAccount.set(accountId, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = Math.max(0, (this.activeRequestsByAccount.get(accountId) || 1) - 1);
      this.activeRequestsByAccount.set(accountId, next);
    };
  }
}

export const goAlignedStore = new GoAlignedStore();
