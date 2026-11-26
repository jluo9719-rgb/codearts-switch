import type {
  AdminCreditAccount,
  AdminLogEntry,
  AdminSettings,
  AdminStateResponse,
  AdminStats,
  LoginPollResponse,
  LoginStartResponse,
  ModelProbeResponse,
  SwitchAgentDetection,
  SwitchAgentId,
  SwitchApplyResponse,
  SwitchPreviewResponse,
  SwitchProfilesState,
  SwitchRestoreResponse,
  UpdateCheckResponse,
} from '../types';

export class ApiError extends Error {
  public readonly status: number;
  public readonly type?: string;

  constructor(status: number, message: string, type?: string) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

let inMemoryAdminPassword = '';

export function setAdminPasswordMemory(pw: string): void {
  inMemoryAdminPassword = pw;
}

export function getAdminPasswordMemory(): string {
  return inMemoryAdminPassword;
}

async function adminFetch<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: unknown;
    timeoutMs?: number;
  } = {}
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 25000);
  try {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (inMemoryAdminPassword) {
      headers['X-Admin-Password'] = inMemoryAdminPassword;
    }

    const res = await fetch(path, {
      method: options.method || 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    if (text) {
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = { message: text };
      }
    }

    if (!res.ok) {
      const errObj =
        parsed.error && typeof parsed.error === 'object'
          ? (parsed.error as { message?: string; type?: string })
          : undefined;
      const msg =
        errObj?.message ||
        (typeof parsed.error === 'string' ? parsed.error : '') ||
        (typeof parsed.message === 'string' ? parsed.message : '') ||
        `请求失败 (HTTP ${res.status})`;
      throw new ApiError(res.status, msg, errObj?.type);
    }

    return parsed as unknown as T;
  } finally {
    clearTimeout(timeout);
  }
}

export const adminApi = {
  getState: () => adminFetch<AdminStateResponse>('/admin/api/state'),

  getCredits: (fresh = false) =>
    adminFetch<{ ok: boolean; accounts: AdminCreditAccount[] }>(
      `/admin/api/credits${fresh ? '?fresh=1' : ''}`
    ),

  accountAction: (payload: Record<string, unknown>) =>
    adminFetch<Record<string, unknown>>('/admin/api/accounts', {
      method: 'POST',
      body: payload,
    }),

  checkinAccount: (id?: string) =>
    adminFetch<{ ok: boolean; results: Array<{ id: string; name: string; ok: boolean; err?: string }> }>(
      '/admin/api/checkin',
      { method: 'POST', body: id ? { id } : {} }
    ),

  claimActivity: (id?: string) =>
    adminFetch<Record<string, unknown>>('/admin/api/claim', {
      method: 'POST',
      body: id ? { id } : {},
    }),

  startLogin: () =>
    adminFetch<LoginStartResponse>('/admin/api/login/start', { method: 'POST' }),

  pollLogin: (sessionId: string) =>
    adminFetch<LoginPollResponse>('/admin/api/login/poll', {
      method: 'POST',
      body: { session_id: sessionId },
    }),

  submitLoginCallback: (sessionId: string, callbackUrl: string) =>
    adminFetch<{
      ok: boolean;
      accepted?: boolean;
      message?: string;
      account_id?: string;
      account_name?: string;
    }>('/admin/api/login/callback', {
      method: 'POST',
      body: { session_id: sessionId, url: callbackUrl, callback_url: callbackUrl },
    }),

  cancelLogin: (sessionId: string) =>
    adminFetch<{ ok: boolean }>('/admin/api/login/cancel', {
      method: 'POST',
      body: { session_id: sessionId },
    }),

  refreshModels: () =>
    adminFetch<{ ok: boolean; count: number; models: AdminStateResponse['models'] }>(
      '/admin/api/models/refresh',
      { method: 'POST' }
    ),

  probeModels: (models?: string[], accountId?: string) =>
    adminFetch<ModelProbeResponse>('/admin/api/models/probe', {
      method: 'POST',
      body: {
        ...(accountId ? { id: accountId } : {}),
        ...(models && models.length > 0 ? { models } : {}),
      },
      timeoutMs: 90000,
    }),

  createKey: (name: string) =>
    adminFetch<{ ok: boolean; key: string }>('/admin/api/keys', {
      method: 'POST',
      body: { name },
    }),

  deleteKey: (maskedOrFullKey: string) =>
    adminFetch<{ ok: boolean }>(
      `/admin/api/keys?key=${encodeURIComponent(maskedOrFullKey)}`,
      { method: 'DELETE' }
    ),

  toggleKey: (maskedOrFullKey: string) =>
    adminFetch<{ ok: boolean }>(
      `/admin/api/keys?toggle=${encodeURIComponent(maskedOrFullKey)}`,
      { method: 'DELETE' }
    ),

  getLogs: (limit = 100) =>
    adminFetch<{ logs: AdminLogEntry[] }>(`/admin/api/logs?limit=${limit}`),

  clearLogs: () => adminFetch<{ ok: boolean }>('/admin/api/logs', { method: 'DELETE' }),

  clearStats: () => adminFetch<{ ok: boolean }>('/admin/api/stats', { method: 'DELETE' }),

  getStats: () => adminFetch<AdminStats>('/admin/api/stats'),

  updateSettings: (patch: Partial<AdminSettings> & { admin_password?: string; clear_admin_password?: boolean }) =>
    adminFetch<{ ok: boolean; settings: AdminSettings }>('/admin/api/settings', {
      method: 'POST',
      body: patch,
    }),

  // =========================================================================
  // /admin/api/switch/* — Dual-Mode Zero-Conflict Switcher Endpoints
  // =========================================================================

  detectAgents: () =>
    adminFetch<{
      ok: boolean;
      gatewayBaseUrl: string;
      profiles: SwitchProfilesState;
      agents: Record<SwitchAgentId, SwitchAgentDetection>;
    }>('/admin/api/switch/detect'),

  saveSwitchProfile: (agentId: SwitchAgentId, profile: Record<string, unknown>) =>
    adminFetch<{ ok: boolean; profiles: SwitchProfilesState }>(
      `/admin/api/switch/profiles/${agentId}`,
      { method: 'POST', body: profile }
    ),

  previewSwitch: (agentId: SwitchAgentId, profile?: Record<string, unknown>, apiKey?: string) =>
    adminFetch<SwitchPreviewResponse>('/admin/api/switch/preview', {
      method: 'POST',
      body: { agentId, profile, apiKey },
    }),

  applySwitchMerge: (agentId: SwitchAgentId, profile?: Record<string, unknown>, apiKey?: string) =>
    adminFetch<SwitchApplyResponse>('/admin/api/switch/apply', {
      method: 'POST',
      body: { agentId, profile, apiKey },
    }),

  restoreSwitchBackup: (agentId: SwitchAgentId) =>
    adminFetch<SwitchRestoreResponse>('/admin/api/switch/restore', {
      method: 'POST',
      body: { agentId },
    }),

  connectGoBridge: (origin: string, autoDetect = false) =>
    adminFetch<{
      ok: boolean;
      runtime_mode: 'go-bridge' | 'node-preview';
      go_upstream: string;
      message: string;
    }>('/admin/api/switch/go-bridge', {
      method: 'POST',
      body: { origin, autoDetect },
    }),

  openExternalUrl: (url: string) =>
    adminFetch<{ ok: boolean; message?: string }>('/admin/api/switch/open-url', {
      method: 'POST',
      body: { url },
    }),

  checkUpdate: () => adminFetch<UpdateCheckResponse>('/admin/api/switch/update-check'),
};
