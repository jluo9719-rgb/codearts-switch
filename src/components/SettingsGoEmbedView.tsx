import React, { useEffect, useState } from 'react';
import {
  ArrowDownToLine,
  Check,
  Copy,
  ExternalLink,
  Link2,
  Lock,
  Monitor,
  Package,
  Plus,
  RefreshCw,
  Save,
  Trash2,
} from 'lucide-react';
import { adminApi, setAdminPasswordMemory } from '../lib/apiClient';
import { formatDateTimeCN } from '../lib/timeFormat';
import type { AdminModel, AdminSettings, RuntimeMode, UpdateCheckResponse } from '../types';

interface SettingsGoEmbedViewProps {
  settings: AdminSettings;
  models: AdminModel[];
  runtimeMode: RuntimeMode;
  goUpstream: string;
  updateInfo: UpdateCheckResponse | null;
  checkingUpdate: boolean;
  onCheckUpdate: (manual?: boolean) => Promise<void>;
  onOpenExternalUrl: (url: string) => Promise<void>;
  onConnectGoBridge: (origin: string, autoDetect?: boolean) => Promise<boolean>;
  onRefreshState: () => Promise<void>;
  onNotify: (kind: 'success' | 'error' | 'info', message: string) => void;
}

const TAURI_DESKTOP_BUILD_CMD = `# 推荐直接用 npm 命令一键打包 Tauri v2 独立窗口桌面客户端（无 PowerShell 编码/策略限制）：
npm run build:desktop

# 或使用纯 ASCII PowerShell 脚本：
# .\\scripts\\build-tauri-windows.ps1
# 产物位置：src-tauri\\target\\release\\bundle\\nsis\\ 与 msi\\`;

const GO_EMBED_BUILD_CMD = `# 暂不装 Rust/Tauri 时，直接用本机 Go 编出零依赖单文件可执行程序：
npm run build:gateway

# 编译产物（双击或命令行运行，访问 http://127.0.0.1:10087/）：
#   dist-bin\\codearts-switch.exe`;

export const SettingsGoEmbedView: React.FC<SettingsGoEmbedViewProps> = ({
  settings,
  models,
  runtimeMode,
  goUpstream,
  updateInfo,
  checkingUpdate,
  onCheckUpdate,
  onOpenExternalUrl,
  onConnectGoBridge,
  onRefreshState,
  onNotify,
}) => {
  const [form, setForm] = useState<AdminSettings>(settings);
  const [newPassword, setNewPassword] = useState('');
  const [aliasFrom, setAliasFrom] = useState('');
  const [aliasTo, setAliasTo] = useState('');
  const [saving, setSaving] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState<'tauri' | 'go' | null>(null);
  const [bridgeInput, setBridgeInput] = useState(goUpstream || 'http://127.0.0.1:10087');
  const [bridging, setBridging] = useState(false);

  useEffect(() => {
    setForm(settings);
  }, [settings]);

  useEffect(() => {
    if (goUpstream) setBridgeInput(goUpstream);
  }, [goUpstream]);

  const modelIds = models.filter((m) => m.source !== 'alias').map((m) => m.id);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload: Partial<AdminSettings> & { admin_password?: string } = {
        default_model: form.default_model,
        force_model: form.force_model,
        model_aliases: form.model_aliases || {},
        request_timeout_sec: Number(form.request_timeout_sec),
        max_retries: Number(form.max_retries),
        log_keep: Number(form.log_keep),
        rate_limit_enabled: form.rate_limit_enabled,
        rate_limit_qps: Number(form.rate_limit_qps),
        rate_limit_burst: Number(form.rate_limit_burst),
        rate_limit_concurrency: Number(form.rate_limit_concurrency),
        auto_refresh: form.auto_refresh,
        allow_credit_models: form.allow_credit_models,
        allow_anonymous: form.allow_anonymous,
        auto_claim: form.auto_claim,
        write_back_to_ide: form.write_back_to_ide,
        login_port: Number(form.login_port) || 0,
      };
      if (newPassword.trim()) {
        payload.admin_password = newPassword.trim();
      }
      await adminApi.updateSettings(payload);
      if (newPassword.trim()) {
        setAdminPasswordMemory(newPassword.trim());
        setNewPassword('');
      }
      onNotify('success', '网关配置已持久化保存');
      await onRefreshState();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : '保存设置失败');
    } finally {
      setSaving(false);
    }
  };

  const handleClearPassword = async () => {
    setSaving(true);
    try {
      await adminApi.updateSettings({ clear_admin_password: true });
      setAdminPasswordMemory('');
      onNotify('success', '已清除自定义管理密码（将恢复本机回环直连保护）');
      await onRefreshState();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : '清除管理密码失败');
    } finally {
      setSaving(false);
    }
  };

  const handleCopyBuild = async (kind: 'tauri' | 'go', text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedCmd(kind);
      setTimeout(() => setCopiedCmd((prev) => (prev === kind ? null : prev)), 1800);
    } catch {
      onNotify('error', '复制失败');
    }
  };

  return (
    <div className="space-y-6">
      {/* Live Local Go CodeArts2API Bridge Control */}
      {runtimeMode !== 'go-embed' && (
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <Link2 className="w-5 h-5 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
              <div>
                <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                  本地 Go CodeArts2API 实时桥接
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
                  {runtimeMode === 'go-bridge'
                    ? `当前已直连本机 Go 核心（${goUpstream}），所有 OAuth 登录、实时积分、上游模型目录与推理请求均走真实华为云通道。`
                    : '当前运行在独立 Node.js 预览模式。如果你本机已启动 Go CodeArts2API，填入回环地址并点击连接即可立即切换为真实华为云引擎，无需重启服务。'}
                </p>
              </div>
            </div>
            <span
              className={`text-xs font-medium whitespace-nowrap ${
                runtimeMode === 'go-bridge'
                  ? 'text-emerald-700 dark:text-emerald-400'
                  : 'text-slate-500 dark:text-slate-400'
              }`}
            >
              {runtimeMode === 'go-bridge' ? '已直连 Go 核心' : '独立预览模式'}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <input
              type="url"
              value={bridgeInput}
              onChange={(e) => setBridgeInput(e.target.value)}
              aria-label="本地 Go CodeArts2API 回环地址"
              placeholder="http://127.0.0.1:10087"
              className="w-full sm:w-72 px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            />
            <button
              type="button"
              disabled={bridging || !bridgeInput.trim()}
              onClick={async () => {
                setBridging(true);
                await onConnectGoBridge(bridgeInput.trim(), false);
                setBridging(false);
              }}
              className="px-4 py-2 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white whitespace-nowrap disabled:opacity-50"
            >
              {bridging ? '连接探测中…' : runtimeMode === 'go-bridge' ? '重新连接' : '立即直连'}
            </button>
            {runtimeMode === 'go-bridge' && (
              <button
                type="button"
                disabled={bridging}
                onClick={async () => {
                  setBridging(true);
                  await onConnectGoBridge('', false);
                  setBridging(false);
                }}
                className="px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
              >
                断开桥接
              </button>
            )}
          </div>
        </section>
      )}

      <form
        onSubmit={handleSave}
        className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-6"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-200 dark:border-slate-800">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              网关核心参数（与 Go CodeArts2API 对齐）
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              字段命名与 Go 后端 <code className="font-mono">/admin/api/settings</code> 完全一致，编译合入后无缝接管。
            </p>
          </div>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white whitespace-nowrap disabled:opacity-50"
          >
            <Save className="w-3.5 h-3.5" />
            <span>{saving ? '保存中…' : '保存全部设置'}</span>
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label
              htmlFor="setting-default-model"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
            >
              默认回退模型 (default_model)
            </label>
            <select
              id="setting-default-model"
              value={form.default_model}
              onChange={(e) => setForm({ ...form, default_model: e.target.value })}
              className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            >
              {modelIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="setting-force-model"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
            >
              强制覆写模型 (force_model，留空不强制)
            </label>
            <input
              id="setting-force-model"
              type="text"
              value={form.force_model}
              onChange={(e) => setForm({ ...form, force_model: e.target.value })}
              placeholder="留空按客户端请求路由"
              className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            />
          </div>

          <div>
            <label
              htmlFor="setting-login-port"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
            >
              OAuth 回调端口 (login_port，0 为默认自动)
            </label>
            <input
              id="setting-login-port"
              type="number"
              min={0}
              max={65535}
              value={form.login_port}
              onChange={(e) => setForm({ ...form, login_port: Number(e.target.value) })}
              className="w-full px-3 py-2 text-sm font-mono tabular-nums rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <label
              htmlFor="setting-timeout"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
            >
              超时时间 (秒)
            </label>
            <input
              id="setting-timeout"
              type="number"
              min={10}
              max={900}
              value={form.request_timeout_sec}
              onChange={(e) => setForm({ ...form, request_timeout_sec: Number(e.target.value) })}
              className="w-full px-3 py-2 text-sm font-mono tabular-nums rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            />
          </div>
          <div>
            <label
              htmlFor="setting-retries"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
            >
              上游重试次数
            </label>
            <input
              id="setting-retries"
              type="number"
              min={1}
              max={8}
              value={form.max_retries}
              onChange={(e) => setForm({ ...form, max_retries: Number(e.target.value) })}
              className="w-full px-3 py-2 text-sm font-mono tabular-nums rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            />
          </div>
          <div>
            <label
              htmlFor="setting-qps"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
            >
              限流 QPS
            </label>
            <input
              id="setting-qps"
              type="number"
              min={1}
              max={100}
              value={form.rate_limit_qps}
              onChange={(e) => setForm({ ...form, rate_limit_qps: Number(e.target.value) })}
              className="w-full px-3 py-2 text-sm font-mono tabular-nums rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            />
          </div>
          <div>
            <label
              htmlFor="setting-concurrency"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
            >
              全局并发上限
            </label>
            <input
              id="setting-concurrency"
              type="number"
              min={1}
              max={64}
              value={form.rate_limit_concurrency}
              onChange={(e) =>
                setForm({ ...form, rate_limit_concurrency: Number(e.target.value) })
              }
              className="w-full px-3 py-2 text-sm font-mono tabular-nums rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 pt-2 border-t border-slate-100 dark:border-slate-800 text-sm">
          <label className="inline-flex items-center gap-2 text-slate-700 dark:text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={form.auto_refresh}
              onChange={(e) => setForm({ ...form, auto_refresh: e.target.checked })}
            />
            <span>自动刷新即将过期的 STS 令牌</span>
          </label>
          <label className="inline-flex items-center gap-2 text-slate-700 dark:text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={form.rate_limit_enabled}
              onChange={(e) => setForm({ ...form, rate_limit_enabled: e.target.checked })}
            />
            <span>启用令牌桶限流保护</span>
          </label>
          <label className="inline-flex items-center gap-2 text-slate-700 dark:text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={form.allow_credit_models}
              onChange={(e) => setForm({ ...form, allow_credit_models: e.target.checked })}
            />
            <span>允许调用积分模型</span>
          </label>
          <label className="inline-flex items-center gap-2 text-slate-700 dark:text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={form.auto_claim}
              onChange={(e) => setForm({ ...form, auto_claim: e.target.checked })}
            />
            <span>每日自动尝试领取活动积分</span>
          </label>
          <label className="inline-flex items-center gap-2 text-slate-700 dark:text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={form.write_back_to_ide}
              onChange={(e) => setForm({ ...form, write_back_to_ide: e.target.checked })}
            />
            <span>续期后回写 CodeArts IDE 凭证</span>
          </label>
          <label className="inline-flex items-center gap-2 text-slate-700 dark:text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={form.allow_anonymous}
              onChange={(e) => setForm({ ...form, allow_anonymous: e.target.checked })}
            />
            <span>允许 /v1 匿名调用（不建议开启）</span>
          </label>
        </div>

        {/* Admin Password Section */}
        <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-3">
          <div className="flex items-center gap-2">
            <Lock className="w-4 h-4 text-slate-500" />
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              管理控制台访问密码
            </h3>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              · {settings.admin_password_set ? '已启用密码保护' : '未设置（本地仅限 127.0.0.1 直连）'}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              aria-label="设置新的管理密码"
              placeholder="输入新密码后点击右上角「保存全部设置」生效"
              className="w-full sm:w-80 px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            />
            {settings.admin_password_set && (
              <button
                type="button"
                onClick={() => void handleClearPassword()}
                disabled={saving}
                className="px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-rose-700 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30"
              >
                清除密码
              </button>
            )}
          </div>
        </div>

        {/* Per-model Alias Mapping (for mapping Codex Desktop dropdown entries to distinct CodeArts models) */}
        <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              自定义模型别名映射 (model_aliases)
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              可选进阶功能：将客户端请求的特定模型名（如 Codex 桌面端的 <code className="font-mono">gpt-6.2-sol</code>、<code className="font-mono">gpt-6.2-astra</code>）分别映射到不同码道模型；新增或删除后点击右上角「保存全部设置」生效。
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={aliasFrom}
              onChange={(e) => setAliasFrom(e.target.value)}
              aria-label="客户端请求的模型别名"
              placeholder="客户端模型名，如 gpt-6.2-sol"
              className="w-full sm:w-56 px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            />
            <span className="text-xs text-slate-400">→</span>
            <select
              value={aliasTo || modelIds[0] || ''}
              onChange={(e) => setAliasTo(e.target.value)}
              aria-label="映射到的目标码道模型"
              className="w-full sm:w-56 px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            >
              {modelIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => {
                const from = aliasFrom.trim();
                const to = (aliasTo || modelIds[0] || '').trim();
                if (!from || !to) return;
                setForm({
                  ...form,
                  model_aliases: { ...(form.model_aliases || {}), [from]: to },
                });
                setAliasFrom('');
              }}
              className="inline-flex items-center gap-1 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>添加映射</span>
            </button>
          </div>

          {Object.keys(form.model_aliases || {}).length > 0 && (
            <div className="divide-y divide-slate-100 dark:divide-slate-800 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/40">
              {Object.entries(form.model_aliases || {}).map(([from, to]) => (
                <div
                  key={from}
                  className="px-3.5 py-2 flex items-center justify-between gap-3 text-xs font-mono"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-slate-900 dark:text-slate-100 truncate">{from}</span>
                    <span className="text-slate-400">→</span>
                    <span className="text-blue-700 dark:text-blue-400 truncate">{to}</span>
                  </div>
                  <button
                    type="button"
                    aria-label={`删除别名 ${from}`}
                    onClick={() => {
                      const next = { ...(form.model_aliases || {}) };
                      delete next[from];
                      setForm({ ...form, model_aliases: next });
                    }}
                    className="text-rose-600 dark:text-rose-400 hover:underline inline-flex items-center gap-1 shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>移除</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </form>

      {/* Software Version & GitHub Releases Update Check */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <ArrowDownToLine className="w-5 h-5 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
            <div>
              <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                软件版本与更新检查
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                当前版本：<span className="font-mono text-slate-800 dark:text-slate-200">v{updateInfo?.currentVersion || '1.0.2'}</span>
                {updateInfo?.ok && updateInfo.latestVersion && (
                  <>
                    {' '}· GitHub 最新版本：
                    <span className="font-mono text-slate-800 dark:text-slate-200">
                      v{updateInfo.latestVersion}
                    </span>
                    {updateInfo.publishedAt && (
                      <> · 发布于 {formatDateTimeCN(updateInfo.publishedAt)}</>
                    )}
                  </>
                )}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void onCheckUpdate(true)}
              disabled={checkingUpdate}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${checkingUpdate ? 'animate-spin' : ''}`} />
              <span>{checkingUpdate ? '检查中…' : '检查 GitHub 更新'}</span>
            </button>

            <button
              type="button"
              onClick={() =>
                void onOpenExternalUrl(
                  updateInfo?.hasUpdate && updateInfo.downloadUrl
                    ? updateInfo.downloadUrl
                    : updateInfo?.releaseUrl ||
                        'https://github.com/jluo9719-rgb/codearts-switch/releases'
                )
              }
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap ${
                updateInfo?.hasUpdate
                  ? 'bg-blue-600 hover:bg-blue-700 text-white'
                  : 'border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span>{updateInfo?.hasUpdate ? `下载新版 v${updateInfo.latestVersion}` : '打开 Releases 页面'}</span>
            </button>
          </div>
        </div>

        <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
          每次推送代码并在 GitHub Actions 发布新版本标签（如 <code className="font-mono">v1.0.2</code>）后，软件启动时会自动检测并弹出更新横幅；下载新版 <code className="font-mono">-setup.exe</code> 直接覆盖安装即可，你的账号、密钥、设置与快照数据保存在 <code className="font-mono">%APPDATA%\com.codearts.switch\</code>，升级不会丢失任何数据。
        </p>
      </section>

      {/* Tauri v2 Desktop Client Packaging Kit */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <Monitor className="w-5 h-5 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
            <div>
              <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                Tauri v2 独立窗口桌面客户端（src-tauri + Go Sidecar）
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                已内置完整 <code className="font-mono">src-tauri/</code> Rust 桌面壳与 Windows 一键打包脚本：自动将 Go <code className="font-mono">CodeArts2API</code>（含 Switch 扩展与 Codex <code className="font-mono">/v1/responses</code>）编译为无黑框 Sidecar 一起打进安装包，关闭窗口自动最小化到系统托盘。
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void handleCopyBuild('tauri', TAURI_DESKTOP_BUILD_CMD)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
          >
            {copiedCmd === 'tauri' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copiedCmd === 'tauri' ? '已复制命令' : '复制桌面打包命令'}</span>
          </button>
        </div>

        <pre className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-950 text-slate-100 p-4 text-xs font-mono leading-relaxed overflow-x-auto">
          {TAURI_DESKTOP_BUILD_CMD}
        </pre>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs text-slate-600 dark:text-slate-400">
          <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
            <div className="font-mono font-medium text-slate-900 dark:text-slate-100">
              src-tauri/src/lib.rs
            </div>
            <p className="mt-1 leading-relaxed">
              自动拉起内置 Go 网关 Sidecar、探活后直连 127.0.0.1:10087（天然同源零 CORS）、关闭最小化托盘与退出自动回收子进程。
            </p>
          </div>
          <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
            <div className="font-mono font-medium text-slate-900 dark:text-slate-100">
              scripts/build-tauri-windows.ps1
            </div>
            <p className="mt-1 leading-relaxed">
              一条命令完成 React 构建、Go 无窗口 Sidecar 编译与 Tauri NSIS/MSI 安装包输出。
            </p>
          </div>
          <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
            <div className="font-mono font-medium text-slate-900 dark:text-slate-100">
              单端口全能力合体
            </div>
            <p className="mt-1 leading-relaxed">
              打包后仅需双击桌面图标，127.0.0.1:10087 同时提供华为云 OAuth、Claude /v1/messages 与 Codex /v1/responses。
            </p>
          </div>
        </div>
      </section>

      {/* Go go:embed Single Binary Packaging Kit */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <Package className="w-5 h-5 text-slate-500 shrink-0 mt-0.5" />
            <div>
              <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                轻量单文件 Go 可执行程序（内置 gateway/）
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                项目已完整整合 <code className="font-mono">gateway/</code> Go 网关源码。暂不安装 Rust 时，直接运行脚本即可编出零依赖单文件 <code className="font-mono">dist-bin/codearts-switch.exe</code>。
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void handleCopyBuild('go', GO_EMBED_BUILD_CMD)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
          >
            {copiedCmd === 'go' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copiedCmd === 'go' ? '已复制命令' : '复制单文件步骤'}</span>
          </button>
        </div>

        <pre className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-950 text-slate-100 p-4 text-xs font-mono leading-relaxed overflow-x-auto">
          {GO_EMBED_BUILD_CMD}
        </pre>
      </section>
    </div>
  );
};
