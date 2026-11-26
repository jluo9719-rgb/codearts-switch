import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowDownToLine, Lock, RefreshCw, X } from 'lucide-react';
import { Sidebar, type NavSection } from './components/Sidebar';
import { AgentSwitcherView } from './components/AgentSwitcherView';
import { AccountsCreditsView } from './components/AccountsCreditsView';
import { ModelsCatalogView } from './components/ModelsCatalogView';
import { LogsKeysView } from './components/LogsKeysView';
import { SettingsGoEmbedView } from './components/SettingsGoEmbedView';
import { adminApi, ApiError, setAdminPasswordMemory } from './lib/apiClient';
import type { AdminStateResponse, UpdateCheckResponse } from './types';

const SECTION_TITLE: Record<NavSection, string> = {
  agents: '智能体切换',
  accounts: '账号与积分',
  models: '模型目录',
  logs_keys: '日志与密钥',
  settings: '网关设置与打包',
};

export function App() {
  const [activeSection, setActiveSection] = useState<NavSection>('agents');
  const [state, setState] = useState<AdminStateResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [unlockInput, setUnlockInput] = useState('');
  const [unlockError, setUnlockError] = useState('');
  const [notice, setNotice] = useState<{
    kind: 'success' | 'error' | 'info';
    message: string;
  } | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResponse | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateBannerDismissed, setUpdateBannerDismissed] = useState(false);

  const [darkMode, setDarkMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('codearts-switch-theme') === 'dark';
  });

  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add('dark');
      window.localStorage.setItem('codearts-switch-theme', 'dark');
    } else {
      root.classList.remove('dark');
      window.localStorage.setItem('codearts-switch-theme', 'light');
    }
  }, [darkMode]);

  const notify = useCallback((kind: 'success' | 'error' | 'info', message: string) => {
    setNotice({ kind, message });
  }, []);

  const loadState = useCallback(async (isInitial = false) => {
    if (isInitial) {
      setLoading(true);
    } else {
      setRefreshing(true);
    }
    try {
      const data = await adminApi.getState();
      setState(data);
      setAuthRequired(false);
      setUnlockError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setAuthRequired(true);
      } else {
        setNotice({
          kind: 'error',
          message: err instanceof Error ? err.message : '无法连接本地网关服务',
        });
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const handleOpenExternalUrl = useCallback(async (url: string) => {
    try {
      await adminApi.openExternalUrl(url);
    } catch {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  }, []);

  const handleCheckUpdate = useCallback(
    async (manual = false) => {
      setCheckingUpdate(true);
      try {
        const res = await adminApi.checkUpdate();
        setUpdateInfo(res);
        if (res.hasUpdate) {
          setUpdateBannerDismissed(false);
          if (manual) {
            notify('info', `发现新版本 v${res.latestVersion}（当前 v${res.currentVersion}），可点击下载覆盖安装。`);
          }
        } else if (manual) {
          if (res.ok) {
            notify('success', `当前已是最新版本（v${res.currentVersion}）`);
          } else {
            notify('info', res.error || '暂时无法连接 GitHub，请稍后重试');
          }
        }
      } catch {
        if (manual) {
          notify('error', '检查更新请求失败');
        }
      } finally {
        setCheckingUpdate(false);
      }
    },
    [notify]
  );

  useEffect(() => {
    void loadState(true);
    void handleCheckUpdate(false);
  }, [loadState, handleCheckUpdate]);

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!unlockInput.trim()) {
      setUnlockError('请输入管理密码');
      return;
    }
    setAdminPasswordMemory(unlockInput.trim());
    try {
      const data = await adminApi.getState();
      setState(data);
      setAuthRequired(false);
      setUnlockInput('');
      setUnlockError('');
    } catch (err) {
      setAdminPasswordMemory('');
      setUnlockError(err instanceof Error ? err.message : '密码校验失败');
    }
  };

  const handleAssignModelToClaude = async (modelId: string) => {
    try {
      await adminApi.saveSwitchProfile('claude', {
        primaryModel: modelId,
        sonnetModel: modelId,
      });
      notify('success', `已将 Claude Code 主模型与 Sonnet 槽位更新为 ${modelId}`);
      setActiveSection('agents');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : '更新模型配置失败');
    }
  };

  const handleConnectGoBridge = useCallback(
    async (origin: string, autoDetect = false): Promise<boolean> => {
      try {
        const res = await adminApi.connectGoBridge(origin, autoDetect);
        notify('success', res.message);
        await loadState(false);
        return true;
      } catch (err) {
        notify('error', err instanceof Error ? err.message : '连接本地 Go 核心失败');
        return false;
      }
    },
    [loadState, notify]
  );

  const healthyAccounts =
    state?.accounts.filter((a) => a.enabled && a.status === 'ok').length ?? 0;
  const totalAccounts = state?.accounts.length ?? 0;
  const activeKeysCount = state?.keys.filter((k) => k.enabled).length ?? 0;
  const runtimeMode = state?.runtime_mode || 'go-embed';
  const goUpstream = state?.go_upstream || '';
  const fallbackHost =
    typeof window !== 'undefined' && window.location.host
      ? window.location.host
      : '127.0.0.1:10087';
  const gatewayBind =
    runtimeMode === 'go-bridge' && goUpstream
      ? goUpstream.replace(/^https?:\/\//, '')
      : state?.gateway_host && state?.gateway_port
        ? `${state.gateway_host}:${state.gateway_port}`
        : fallbackHost;

  return (
    <div className="min-h-screen flex bg-[#F8FAFC] dark:bg-[#0B1120] text-slate-900 dark:text-slate-100">
      <Sidebar
        activeSection={activeSection}
        onSelectSection={setActiveSection}
        gatewayBind={gatewayBind}
        healthyAccounts={healthyAccounts}
        totalAccounts={totalAccounts}
        activeKeysCount={activeKeysCount}
        appVersion={updateInfo?.currentVersion || '1.0.1'}
        hasUpdate={Boolean(updateInfo?.hasUpdate)}
        darkMode={darkMode}
        onToggleDarkMode={() => setDarkMode((prev) => !prev)}
      />

      <div className="flex-1 min-w-0 flex flex-col">
        {/* Clean SaaS Top Bar: Breadcrumb on left + 1 Primary Action on right */}
        <header className="h-16 px-6 lg:px-8 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-center justify-between gap-6 shrink-0">
          <div className="flex items-center gap-2 text-sm min-w-0">
            <span className="text-slate-500 dark:text-slate-400 whitespace-nowrap">控制台</span>
            <span aria-hidden="true" className="text-slate-300 dark:text-slate-700">
              /
            </span>
            <h1 className="font-semibold text-slate-900 dark:text-slate-100 truncate">
              {SECTION_TITLE[activeSection]}
            </h1>
          </div>

          <button
            type="button"
            onClick={() => void loadState(false)}
            disabled={refreshing}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            <span>同步状态</span>
          </button>
        </header>

        <main className="flex-1 p-6 lg:p-8 max-w-6xl w-full mx-auto space-y-5">
          {updateInfo?.hasUpdate && !updateBannerDismissed && (
            <div
              role="status"
              className="px-4 py-3 rounded-xl bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800/60 flex flex-wrap items-center justify-between gap-3 text-xs text-blue-900 dark:text-blue-200"
            >
              <div className="flex items-center gap-2">
                <ArrowDownToLine className="w-4 h-4 shrink-0 text-blue-600 dark:text-blue-400" />
                <span>
                  发现新版本 <strong className="font-mono">v{updateInfo.latestVersion}</strong>（当前{' '}
                  <span className="font-mono">v{updateInfo.currentVersion}</span>），下载安装包覆盖安装即可保留全部账号与配置。
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    void handleOpenExternalUrl(updateInfo.downloadUrl || updateInfo.releaseUrl)
                  }
                  className="px-3 py-1 rounded-md bg-blue-600 hover:bg-blue-700 text-white font-medium whitespace-nowrap"
                >
                  前往下载新版
                </button>
                <button
                  type="button"
                  aria-label="忽略本次更新提醒"
                  onClick={() => setUpdateBannerDismissed(true)}
                  className="p-0.5 opacity-70 hover:opacity-100"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}

          {state?.state_warning && (
            <div
              role="alert"
              className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/60 flex items-start gap-3 text-xs text-amber-900 dark:text-amber-200"
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{state.state_warning}</span>
            </div>
          )}

          {notice && (
            <div
              role="status"
              className={`px-4 py-3 rounded-xl border flex items-center justify-between gap-3 text-xs ${
                notice.kind === 'error'
                  ? 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800/60 text-rose-800 dark:text-rose-200'
                  : notice.kind === 'success'
                    ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800/60 text-emerald-800 dark:text-emerald-200'
                    : 'bg-blue-50 dark:bg-blue-950/40 border-blue-200 dark:border-blue-800/60 text-blue-800 dark:text-blue-200'
              }`}
            >
              <span>{notice.message}</span>
              <button
                type="button"
                aria-label="关闭提示"
                onClick={() => setNotice(null)}
                className="p-0.5 opacity-70 hover:opacity-100"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {loading ? (
            <div className="p-10 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-sm text-slate-500 dark:text-slate-400">
              正在连接本机网关并读取状态…
            </div>
          ) : !state ? (
            <div className="p-10 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-sm text-slate-600 dark:text-slate-300">
              尚未加载到网关状态，请确认管理密码或本机服务运行状态。
            </div>
          ) : (
            <>
              {activeSection === 'agents' && (
                <AgentSwitcherView models={state.models} onNotify={notify} />
              )}
              {activeSection === 'accounts' && (
                <AccountsCreditsView
                  accounts={state.accounts}
                  stats={state.stats}
                  runtimeMode={runtimeMode}
                  onConnectGoBridge={handleConnectGoBridge}
                  onRefreshState={() => loadState(false)}
                  onNotify={notify}
                />
              )}
              {activeSection === 'models' && (
                <ModelsCatalogView
                  models={state.models}
                  runtimeMode={runtimeMode}
                  onConnectGoBridge={handleConnectGoBridge}
                  onRefreshState={() => loadState(false)}
                  onAssignModelToClaude={handleAssignModelToClaude}
                  onNotify={notify}
                />
              )}
              {activeSection === 'logs_keys' && (
                <LogsKeysView
                  keys={state.keys}
                  stats={state.stats}
                  onRefreshState={() => loadState(false)}
                  onNotify={notify}
                />
              )}
              {activeSection === 'settings' && (
                <SettingsGoEmbedView
                  settings={state.settings}
                  models={state.models}
                  runtimeMode={runtimeMode}
                  goUpstream={goUpstream}
                  updateInfo={updateInfo}
                  checkingUpdate={checkingUpdate}
                  onCheckUpdate={handleCheckUpdate}
                  onOpenExternalUrl={handleOpenExternalUrl}
                  onConnectGoBridge={handleConnectGoBridge}
                  onRefreshState={() => loadState(false)}
                  onNotify={notify}
                />
              )}
            </>
          )}
        </main>
      </div>

      {/* In-memory Admin Password Unlock Modal (never stored in localStorage) */}
      {authRequired && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="admin-unlock-title"
          className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4"
        >
          <form
            onSubmit={handleUnlock}
            className="w-full max-w-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4"
          >
            <div className="flex items-center gap-2 text-slate-900 dark:text-slate-100">
              <Lock className="w-4 h-4 text-blue-600 dark:text-blue-400" />
              <h2 id="admin-unlock-title" className="text-base font-semibold">
                输入管理控制台密码
              </h2>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
              当前网关已启用管理密码保护。密码仅保存在当前标签页内存中，不会写入浏览器本地存储。
            </p>
            <div>
              <label
                htmlFor="admin-unlock-input"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
              >
                管理密码 (X-Admin-Password)
              </label>
              <input
                id="admin-unlock-input"
                type="password"
                autoFocus
                required
                value={unlockInput}
                onChange={(e) => setUnlockInput(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
            </div>
            {unlockError && (
              <p className="text-xs text-rose-600 dark:text-rose-400">{unlockError}</p>
            )}
            <button
              type="submit"
              className="w-full py-2 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white"
            >
              验证并进入控制台
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

export default App;
