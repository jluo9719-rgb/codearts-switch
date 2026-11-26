import React, { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  ExternalLink,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { adminApi } from '../lib/apiClient';
import type {
  AdminAccount,
  AdminCreditAccount,
  AdminStats,
  LoginStartResponse,
  RuntimeMode,
} from '../types';

interface AccountsCreditsViewProps {
  accounts: AdminAccount[];
  stats: AdminStats;
  runtimeMode: RuntimeMode;
  onConnectGoBridge: (origin: string, autoDetect?: boolean) => Promise<boolean>;
  onRefreshState: () => Promise<void>;
  onNotify: (kind: 'success' | 'error' | 'info', message: string) => void;
}

type ModalTab = 'import' | 'manual' | 'session-json' | 'oauth';

function statusText(status: string, enabled: boolean): { label: string; tone: string } {
  if (!enabled) return { label: '已停用', tone: 'text-slate-500 dark:text-slate-400' };
  if (status === 'ok') return { label: '健康可用', tone: 'text-emerald-700 dark:text-emerald-400' };
  if (status === 'cooling') return { label: '冷却中', tone: 'text-amber-700 dark:text-amber-400' };
  if (status === 'expired') return { label: '凭证已过期', tone: 'text-rose-700 dark:text-rose-400' };
  return { label: status || '异常', tone: 'text-rose-700 dark:text-rose-400' };
}

export const AccountsCreditsView: React.FC<AccountsCreditsViewProps> = ({
  accounts,
  stats,
  runtimeMode,
  onConnectGoBridge,
  onRefreshState,
  onNotify,
}) => {
  const [credits, setCredits] = useState<AdminCreditAccount[]>([]);
  const [loadingCredits, setLoadingCredits] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalTab, setModalTab] = useState<ModalTab>('manual');
  const [exportPreview, setExportPreview] = useState<{ name: string; json: string } | null>(null);

  // Import IDE form
  const [importUserData, setImportUserData] = useState('');
  const [importName, setImportName] = useState('');

  // Manual STS / AK-SK form
  const [credentialKind, setCredentialKind] = useState<'sts' | 'aksk'>('sts');
  const [manualName, setManualName] = useState('');
  const [accessKey, setAccessKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [securityToken, setSecurityToken] = useState('');
  const [refreshToken, setRefreshToken] = useState('');
  const [domainId, setDomainId] = useState('');
  const [manualNote, setManualNote] = useState('');

  // Session JSON form
  const [sessionJson, setSessionJson] = useState('');
  const [sessionName, setSessionName] = useState('');

  // OAuth Login state
  const [loginSession, setLoginSession] = useState<LoginStartResponse | null>(null);
  const [callbackUrl, setCallbackUrl] = useState('');
  const [oauthStatusText, setOauthStatusText] = useState('');

  const loadCredits = useCallback(
    async (fresh = false) => {
      setLoadingCredits(true);
      try {
        const res = await adminApi.getCredits(fresh);
        setCredits(res.accounts || []);
      } catch (err) {
        onNotify('error', err instanceof Error ? err.message : '拉取积分状态失败');
      } finally {
        setLoadingCredits(false);
      }
    },
    [onNotify]
  );

  useEffect(() => {
    if (accounts.length === 0) {
      setCredits([]);
      return;
    }
    void loadCredits(false);
  }, [accounts.length, loadCredits]);

  const healthyCount = accounts.filter((a) => a.enabled && a.status === 'ok').length;
  const availableCredits = credits.filter((c) => c.credit?.available);

  const handleCheckinAll = async (id?: string) => {
    setBusyAction(id ? `checkin-${id}` : 'checkin-all');
    try {
      const res = await adminApi.checkinAccount(id);
      const okCount = res.results.filter((r) => r.ok).length;
      onNotify('success', `已完成 ${okCount} 个账号的状态保活检查`);
      await onRefreshState();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : '保活检查失败');
    } finally {
      setBusyAction(null);
    }
  };

  const handleClaim = async (id?: string) => {
    setBusyAction(id ? `claim-${id}` : 'claim-all');
    try {
      await adminApi.claimActivity(id);
      onNotify('success', '已提交今日活动领取请求');
      await onRefreshState();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : '领取失败');
    } finally {
      setBusyAction(null);
    }
  };

  const handleAccountAction = async (
    action: 'toggle' | 'clear-errors' | 'remove' | 'export',
    acc: AdminAccount
  ) => {
    setBusyAction(`${action}-${acc.id}`);
    try {
      const res = await adminApi.accountAction({ action, id: acc.id });
      if (action === 'export') {
        setExportPreview({
          name: acc.name,
          json: String(res.session_json || ''),
        });
      } else {
        onNotify(
          'success',
          action === 'remove'
            ? `已移除账号「${acc.name}」`
            : action === 'toggle'
              ? `已切换「${acc.name}」启用状态`
              : `已清空「${acc.name}」错误计数`
        );
        await onRefreshState();
      }
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : '账号操作失败');
    } finally {
      setBusyAction(null);
    }
  };

  const handleSubmitModal = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusyAction('modal-submit');
    try {
      if (modalTab === 'import') {
        await adminApi.accountAction({
          action: 'import',
          dir: importUserData.trim(),
          user_data: importUserData.trim(),
          name: importName.trim(),
        });
        onNotify('success', '已从本机 CodeArts IDE 导入账号');
      } else if (modalTab === 'manual') {
        await adminApi.accountAction({
          action: 'manual',
          credential_kind: credentialKind,
          name: manualName.trim(),
          access_key: accessKey.trim(),
          secret_key: secretKey.trim(),
          security_token: securityToken.trim(),
          refresh_token: refreshToken.trim(),
          domain_id: domainId.trim(),
          note: manualNote.trim(),
        });
        onNotify('success', '已添加手动凭证账号');
        setAccessKey('');
        setSecretKey('');
        setSecurityToken('');
        setRefreshToken('');
      } else if (modalTab === 'session-json') {
        await adminApi.accountAction({
          action: 'session-json',
          session_json: sessionJson,
          name: sessionName.trim(),
        });
        onNotify('success', '已通过会话 JSON 导入账号');
        setSessionJson('');
      }
      setModalOpen(false);
      await onRefreshState();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : '添加账号失败');
    } finally {
      setBusyAction(null);
    }
  };

  const activeSessionId = loginSession?.session_id || loginSession?.id || '';
  const activeAuthUrl = loginSession?.auth_url || loginSession?.url || '';

  useEffect(() => {
    if (!activeSessionId) return;
    let stopped = false;
    const timer = setInterval(async () => {
      if (stopped) return;
      try {
        const polled = await adminApi.pollLogin(activeSessionId);
        const st = polled.status || polled.state || 'pending';
        if (st === 'confirmed' || st === 'done' || st === 'success') {
          stopped = true;
          clearInterval(timer);
          setLoginSession(null);
          setCallbackUrl('');
          setModalOpen(false);
          onNotify(
            'success',
            polled.message || `浏览器登录已完成：${polled.account_name || polled.account_id || '新账号'}`
          );
          await onRefreshState();
        } else if (st === 'error' || st === 'failed' || st === 'expired') {
          stopped = true;
          clearInterval(timer);
          setOauthStatusText(polled.error || polled.message || '登录会话失败或已过期，请重试');
        } else if (st === 'cancelled') {
          stopped = true;
          clearInterval(timer);
          setLoginSession(null);
        }
      } catch {
        // ignore transient poll errors
      }
    }, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [activeSessionId, onNotify, onRefreshState]);

  const handleStartOAuth = async () => {
    setBusyAction('oauth-start');
    try {
      const started = await adminApi.startLogin();
      setLoginSession(started);
      const port = started.port ?? started.callback_port ?? '';
      setOauthStatusText(
        started.preview_mode
          ? `当前为 Node.js 预览模式（回调地址 http://127.0.0.1:${port}/admin/oauth/callback 已就绪）。如需真实华为云 STS 换票，请连接本地 Go 网关（http://127.0.0.1:10087）或运行 scripts/build-gateway-windows.ps1 启动一体化网关。`
          : `Go 核心本地回调端口${port ? ` ${port}` : ''}已就绪，打开链接登录华为云后会自动同步账号，无需手动粘贴。`
      );
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : '创建 OAuth 登录会话失败');
    } finally {
      setBusyAction(null);
    }
  };

  const handleOpenAuthUrl = async () => {
    if (!activeAuthUrl) return;
    try {
      await adminApi.openExternalUrl(activeAuthUrl);
      onNotify('info', '已在系统默认浏览器中打开华为云登录页，完成授权后将自动回跳绑定。');
    } catch {
      const a = document.createElement('a');
      a.href = activeAuthUrl;
      a.target = '_blank';
      a.rel = 'noreferrer';
      a.click();
    }
  };

  const handleCopyAuthUrl = async () => {
    if (!activeAuthUrl) return;
    try {
      await navigator.clipboard.writeText(activeAuthUrl);
      onNotify('success', '已复制华为云登录链接，可直接粘贴到 Chrome / Edge 打开');
    } catch {
      onNotify('error', '复制失败，请手动选中复制');
    }
  };

  const handleSubmitOAuthCallback = async () => {
    if (!activeSessionId) return;
    setBusyAction('oauth-callback');
    try {
      const res = await adminApi.submitLoginCallback(activeSessionId, callbackUrl.trim());
      if (res.accepted && !res.account_id) {
        setOauthStatusText(res.message || '已收到授权码，正在自动换取华为云凭据…');
        onNotify('info', res.message || '已收到授权码，正在换取凭据，请稍候…');
        return;
      }
      onNotify('success', `已添加 OAuth 账号：${res.account_name || res.account_id || '新账号'}`);
      setLoginSession(null);
      setCallbackUrl('');
      setModalOpen(false);
      await onRefreshState();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : '回调验证失败');
    } finally {
      setBusyAction(null);
    }
  };

  const handleCancelOAuth = async () => {
    if (!activeSessionId) return;
    try {
      await adminApi.cancelLogin(activeSessionId);
    } catch {
      // ignore
    }
    setLoginSession(null);
    setOauthStatusText('');
  };

  return (
    <div className="space-y-6">
      {/* KPI Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
          <div className="text-xs text-slate-500 dark:text-slate-400">账号池总数</div>
          <div className="mt-2 text-2xl font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
            {accounts.length}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            单账号上游并发上限 3 路
          </div>
        </div>
        <div className="p-5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
          <div className="text-xs text-slate-500 dark:text-slate-400">健康可用账号</div>
          <div className="mt-2 text-2xl font-semibold text-emerald-700 dark:text-emerald-400 tabular-nums">
            {healthyCount}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            启用且无故障冷却
          </div>
        </div>
        <div className="p-5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
          <div className="text-xs text-slate-500 dark:text-slate-400">累计网关请求</div>
          <div className="mt-2 text-2xl font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
            {stats.total_requests}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
            失败 {stats.failed_requests} 次
          </div>
        </div>
        <div className="p-5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
          <div className="text-xs text-slate-500 dark:text-slate-400">实时积分余额</div>
          <div className="mt-2 text-2xl font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
            {availableCredits.length > 0
              ? availableCredits
                  .reduce((sum, item) => sum + (item.credit?.remaining ?? 0), 0)
                  .toLocaleString()
              : '—'}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {availableCredits.length > 0 ? '来自 /admin/api/credits 真实回传' : '需 Go 核心直连查询'}
          </div>
        </div>
      </div>

      {/* Accounts Table Card */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="p-5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              CodeArts 账号池
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              完整对接 Go 核心的导入 IDE、STS/AKSK 手动凭证、会话 JSON 与浏览器 OAuth 四种接入方式。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void loadCredits(true)}
              disabled={loadingCredits}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loadingCredits ? 'animate-spin' : ''}`} />
              <span>刷新积分</span>
            </button>
            <button
              type="button"
              onClick={() => void handleCheckinAll()}
              disabled={busyAction !== null || accounts.length === 0}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap disabled:opacity-50"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>全部保活检查</span>
            </button>
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>添加账号</span>
            </button>
          </div>
        </div>

        {accounts.length === 0 ? (
          <div className="p-10 text-center space-y-3">
            <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
              尚未添加任何 CodeArts 账号
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto leading-relaxed">
              我们不内置虚构的沙盒账号或模拟积分。请点击下方按钮从本机 CodeArts IDE 导入、填写华为云 STS / 永久 AK-SK 凭证，或通过 OAuth 登录接入。
            </p>
            <div className="pt-1">
              <button
                type="button"
                onClick={() => setModalOpen(true)}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>添加首个账号</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400 bg-slate-50/70 dark:bg-slate-950/40">
                  <th className="py-3 px-4 whitespace-nowrap">账号名称</th>
                  <th className="py-3 px-4 whitespace-nowrap">来源 / 凭证</th>
                  <th className="py-3 px-4 whitespace-nowrap">状态</th>
                  <th className="py-3 px-4 whitespace-nowrap">实时积分</th>
                  <th className="py-3 px-4 text-right whitespace-nowrap">失败次数</th>
                  <th className="py-3 px-4 text-right whitespace-nowrap">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
                {accounts.map((acc) => {
                  const st = statusText(acc.status, acc.enabled);
                  const creditItem = credits.find((c) => c.id === acc.id);
                  const credit = creditItem?.credit;
                  return (
                    <tr
                      key={acc.id}
                      className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40 transition-colors"
                    >
                      <td className="py-3.5 px-4">
                        <div className="font-medium text-slate-900 dark:text-slate-100">
                          {acc.name}
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400 font-mono">
                          {acc.access_key || acc.id}
                        </div>
                      </td>
                      <td className="py-3.5 px-4 text-xs text-slate-600 dark:text-slate-300">
                        {acc.source} · {acc.permanent ? '永久 AK/SK' : 'STS 临时凭证'}
                      </td>
                      <td className="py-3.5 px-4 text-xs">
                        <span className={`font-medium ${st.tone}`}>{st.label}</span>
                        {acc.last_err && (
                          <div className="text-rose-600 dark:text-rose-400 mt-0.5 max-w-xs truncate">
                            {acc.last_err}
                          </div>
                        )}
                      </td>
                      <td className="py-3.5 px-4 text-xs text-slate-600 dark:text-slate-300 tabular-nums">
                        {credit?.available ? (
                          <div>
                            <span className="font-semibold text-slate-900 dark:text-slate-100">
                              剩余 {credit.remaining?.toLocaleString()} / {credit.total?.toLocaleString()}
                            </span>
                            {credit.plan_name && (
                              <span className="text-slate-500 dark:text-slate-400">
                                {' '}· {credit.plan_name}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-slate-500 dark:text-slate-400">
                            {credit?.note ? '等待 Go 核心实时查询' : '暂未查询'}
                          </span>
                        )}
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono text-xs tabular-nums text-slate-600 dark:text-slate-300">
                        {acc.failures}
                      </td>
                      <td className="py-3.5 px-4 text-right">
                        <div className="inline-flex items-center gap-2 text-xs">
                          <button
                            type="button"
                            onClick={() => void handleClaim(acc.id)}
                            className="text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap"
                          >
                            {acc.claimed_today ? '今日已登记' : '活动领取'}
                          </button>
                          <span aria-hidden="true" className="text-slate-300 dark:text-slate-700">
                            ·
                          </span>
                          <button
                            type="button"
                            onClick={() => void handleAccountAction('toggle', acc)}
                            className="text-slate-600 dark:text-slate-300 hover:underline whitespace-nowrap"
                          >
                            {acc.enabled ? '停用' : '启用'}
                          </button>
                          <span aria-hidden="true" className="text-slate-300 dark:text-slate-700">
                            ·
                          </span>
                          <button
                            type="button"
                            onClick={() => void handleAccountAction('export', acc)}
                            className="text-slate-600 dark:text-slate-300 hover:underline whitespace-nowrap"
                          >
                            导出
                          </button>
                          <span aria-hidden="true" className="text-slate-300 dark:text-slate-700">
                            ·
                          </span>
                          <button
                            type="button"
                            aria-label={`移除账号 ${acc.name}`}
                            onClick={() => void handleAccountAction('remove', acc)}
                            className="text-rose-600 dark:text-rose-400 hover:underline inline-flex items-center gap-1 whitespace-nowrap"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            <span>移除</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Export Redacted JSON Drawer */}
      {exportPreview && (
        <section className="p-5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              脱敏导出信息 · {exportPreview.name}
            </h3>
            <button
              type="button"
              onClick={() => setExportPreview(null)}
              aria-label="关闭导出预览"
              className="p-1 text-slate-500 hover:text-slate-900 dark:hover:text-slate-100"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <pre className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-xs font-mono text-slate-700 dark:text-slate-300 overflow-x-auto">
            {exportPreview.json}
          </pre>
        </section>
      )}

      {/* 4-Tab Add Account Modal */}
      {modalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="add-account-title"
          className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4"
        >
          <div className="w-full max-w-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <h3
                id="add-account-title"
                className="text-base font-semibold text-slate-900 dark:text-slate-100"
              >
                添加 CodeArts 账号
              </h3>
              <button
                type="button"
                aria-label="关闭弹窗"
                onClick={() => setModalOpen(false)}
                className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="px-6 pt-4">
              <div className="grid grid-cols-4 gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-xs font-medium">
                {(
                  [
                    ['import', '导入 IDE'],
                    ['manual', '手动凭证'],
                    ['session-json', '会话 JSON'],
                    ['oauth', '浏览器 OAuth'],
                  ] as Array<[ModalTab, string]>
                ).map(([tab, label]) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setModalTab(tab)}
                    className={`py-1.5 rounded-md transition-colors whitespace-nowrap ${
                      modalTab === tab
                        ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                        : 'text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {modalTab === 'oauth' ? (
              <div className="p-6 space-y-4">
                {runtimeMode === 'node-preview' ? (
                  <div className="space-y-4">
                    <div className="p-4 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/60 text-xs text-amber-900 dark:text-amber-200 leading-relaxed space-y-1.5">
                      <div className="font-semibold">
                        浏览器 OAuth 需连接本地 Go CodeArts2API 核心
                      </div>
                      <p>
                        华为云 CodeArts 登录依赖 Go 核心的 PKCE + DPoP 签名与两段式本地回调换票；当前运行在独立 Node.js 预览模式，直接打开登录页会被华为云拒绝。
                      </p>
                      <p>
                        如果你本机已启动 <code className="font-mono">CodeArts2API</code>（默认 <code className="font-mono">127.0.0.1:10087</code>），点击下方按钮即可一键直连，随后即可直接进行真实华为云 OAuth 登录、积分查询与实时模型同步。
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={busyAction === 'connect-go'}
                        onClick={async () => {
                          setBusyAction('connect-go');
                          await onConnectGoBridge('http://127.0.0.1:10087', true);
                          setBusyAction(null);
                        }}
                        className="px-4 py-2 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
                      >
                        {busyAction === 'connect-go'
                          ? '正在探测 127.0.0.1:10087…'
                          : '一键连接本机 Go 核心 (127.0.0.1:10087)'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setModalTab('manual')}
                        className="px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300"
                      >
                        改用手动凭证 / 会话 JSON
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                      已直连 Go CodeArts2API 核心。点击下方按钮发起真实华为云 PKCE + DPoP 浏览器登录，完成授权后系统会自动回跳并入库，无需手动复制。
                    </p>

                    {!loginSession ? (
                      <button
                        type="button"
                        onClick={() => void handleStartOAuth()}
                        disabled={busyAction === 'oauth-start'}
                        className="px-4 py-2 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
                      >
                        {busyAction === 'oauth-start' ? '正在启动本地回调…' : '生成华为云登录授权链接'}
                      </button>
                    ) : (
                      <div className="space-y-3">
                        <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-xs space-y-2.5">
                          <div className="text-slate-600 dark:text-slate-400">{oauthStatusText}</div>
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() => void handleOpenAuthUrl()}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium"
                            >
                              <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                              <span>在系统浏览器中打开华为云登录页</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleCopyAuthUrl()}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium"
                            >
                              <span>复制登录链接</span>
                            </button>
                          </div>
                        </div>
                        <div>
                          <label
                            htmlFor="oauth-callback-url"
                            className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                          >
                            手动粘贴回调 URL（仅在浏览器未自动回跳时使用）
                          </label>
                          <input
                            id="oauth-callback-url"
                            type="url"
                            value={callbackUrl}
                            onChange={(e) => setCallbackUrl(e.target.value)}
                            placeholder={`http://127.0.0.1:${loginSession.port || loginSession.callback_port || 18765}/callback?code=...`}
                            className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                          />
                        </div>
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => void handleCancelOAuth()}
                            className="px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300"
                          >
                            取消会话
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleSubmitOAuthCallback()}
                            disabled={!callbackUrl.trim() || busyAction === 'oauth-callback'}
                            className="px-4 py-2 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
                          >
                            提交回调完成绑定
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            ) : (
              <form onSubmit={handleSubmitModal} className="p-6 space-y-4">
                {modalTab === 'import' && (
                  <>
                    <div>
                      <label
                        htmlFor="import-name"
                        className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                      >
                        账号备注名称（可选）
                      </label>
                      <input
                        id="import-name"
                        type="text"
                        value={importName}
                        onChange={(e) => setImportName(e.target.value)}
                        placeholder="例如：本机主账号"
                        className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="import-dir"
                        className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                      >
                        CodeArts IDE 用户目录（留空则自动探测）
                      </label>
                      <input
                        id="import-dir"
                        type="text"
                        value={importUserData}
                        onChange={(e) => setImportUserData(e.target.value)}
                        placeholder="留空自动读取本机默认目录"
                        className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                      />
                    </div>
                  </>
                )}

                {modalTab === 'manual' && (
                  <>
                    <div className="flex items-center gap-4 text-xs">
                      <label className="inline-flex items-center gap-1.5 cursor-pointer text-slate-700 dark:text-slate-300">
                        <input
                          type="radio"
                          name="cred-kind"
                          checked={credentialKind === 'sts'}
                          onChange={() => setCredentialKind('sts')}
                        />
                        <span>STS 临时凭证（含 Security Token）</span>
                      </label>
                      <label className="inline-flex items-center gap-1.5 cursor-pointer text-slate-700 dark:text-slate-300">
                        <input
                          type="radio"
                          name="cred-kind"
                          checked={credentialKind === 'aksk'}
                          onChange={() => setCredentialKind('aksk')}
                        />
                        <span>永久 AK / SK</span>
                      </label>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label
                          htmlFor="manual-name"
                          className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                        >
                          显示名称
                        </label>
                        <input
                          id="manual-name"
                          type="text"
                          value={manualName}
                          onChange={(e) => setManualName(e.target.value)}
                          placeholder="例如：研发主力号"
                          className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                        />
                      </div>
                      <div>
                        <label
                          htmlFor="manual-domain"
                          className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                        >
                          Domain ID（可选）
                        </label>
                        <input
                          id="manual-domain"
                          type="text"
                          value={domainId}
                          onChange={(e) => setDomainId(e.target.value)}
                          placeholder="华为云租户 ID"
                          className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label
                          htmlFor="manual-ak"
                          className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                        >
                          Access Key *
                        </label>
                        <input
                          id="manual-ak"
                          type="text"
                          required
                          value={accessKey}
                          onChange={(e) => setAccessKey(e.target.value)}
                          className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                        />
                      </div>
                      <div>
                        <label
                          htmlFor="manual-sk"
                          className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                        >
                          Secret Key *
                        </label>
                        <input
                          id="manual-sk"
                          type="password"
                          required
                          value={secretKey}
                          onChange={(e) => setSecretKey(e.target.value)}
                          className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                        />
                      </div>
                    </div>
                    {credentialKind === 'sts' && (
                      <div>
                        <label
                          htmlFor="manual-st"
                          className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                        >
                          Security Token *
                        </label>
                        <textarea
                          id="manual-st"
                          rows={2}
                          required
                          value={securityToken}
                          onChange={(e) => setSecurityToken(e.target.value)}
                          className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                        />
                      </div>
                    )}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label
                          htmlFor="manual-rt"
                          className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                        >
                          Refresh Token（可选，用于自动续期）
                        </label>
                        <input
                          id="manual-rt"
                          type="password"
                          value={refreshToken}
                          onChange={(e) => setRefreshToken(e.target.value)}
                          className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                        />
                      </div>
                      <div>
                        <label
                          htmlFor="manual-note"
                          className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                        >
                          备注
                        </label>
                        <input
                          id="manual-note"
                          type="text"
                          value={manualNote}
                          onChange={(e) => setManualNote(e.target.value)}
                          className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                        />
                      </div>
                    </div>
                  </>
                )}

                {modalTab === 'session-json' && (
                  <>
                    <div>
                      <label
                        htmlFor="session-name"
                        className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                      >
                        显示名称（可选）
                      </label>
                      <input
                        id="session-name"
                        type="text"
                        value={sessionName}
                        onChange={(e) => setSessionName(e.target.value)}
                        className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="session-json-text"
                        className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                      >
                        CodeArts 会话 JSON *
                      </label>
                      <textarea
                        id="session-json-text"
                        rows={5}
                        required
                        value={sessionJson}
                        onChange={(e) => setSessionJson(e.target.value)}
                        placeholder='{"accessKey":"...","secretKey":"...","securityToken":"..."}'
                        className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                      />
                    </div>
                  </>
                )}

                <div className="pt-2 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setModalOpen(false)}
                    className="px-4 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    disabled={busyAction === 'modal-submit'}
                    className="px-4 py-2 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
                  >
                    {busyAction === 'modal-submit' ? '正在提交…' : '确认添加'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
