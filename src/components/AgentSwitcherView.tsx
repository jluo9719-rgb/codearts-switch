import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  Copy,
  FileDiff,
  History,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Terminal,
} from 'lucide-react';
import { adminApi } from '../lib/apiClient';
import { DEFAULT_SWITCH_PROFILES } from '../lib/switcherEngine';
import { formatDateTimeCN } from '../lib/timeFormat';
import type {
  AdminModel,
  SwitchAgentDetection,
  SwitchAgentId,
  SwitchMode,
  SwitchPreviewResponse,
  SwitchProfilesState,
} from '../types';

interface AgentSwitcherViewProps {
  models: AdminModel[];
  onNotify: (kind: 'success' | 'error' | 'info', message: string) => void;
}

const AGENT_META: Record<
  SwitchAgentId,
  { name: string; protocol: string; cli: string; configSummary: string }
> = {
  claude: {
    name: 'Claude Code',
    protocol: 'Anthropic Messages (/v1/messages)',
    cli: 'claude',
    configSummary: '~/.claude/settings.json',
  },
  codex: {
    name: 'Codex CLI · 桌面软件',
    protocol: 'OpenAI Responses (/v1/responses)',
    cli: 'codex',
    configSummary: '~/.codex/config.toml · auth.json',
  },
  dsh: {
    name: 'DeepSeek Harness',
    protocol: 'OpenAI Chat (/v1/chat/completions)',
    cli: 'dsh web',
    configSummary: '~/.dsh/settings.yaml · .credentials.yaml',
  },
};

function managedLabel(status: SwitchAgentDetection['managedBy']): string {
  if (status === 'codearts-switch') return '当前指向码道网关';
  if (status === 'cc-switch-or-custom') return '检测到外部配置（CC Switch 或自定义）';
  return '默认或尚未配置';
}

export const AgentSwitcherView: React.FC<AgentSwitcherViewProps> = ({ models, onNotify }) => {
  const [selectedAgent, setSelectedAgent] = useState<SwitchAgentId>('claude');
  const [mode, setMode] = useState<SwitchMode>('zero-intrusion');
  const [shellKind, setShellKind] = useState<'cmd' | 'powershell' | 'bash'>('cmd');
  const [profiles, setProfiles] = useState<SwitchProfilesState>(DEFAULT_SWITCH_PROFILES);
  const [detections, setDetections] = useState<Record<SwitchAgentId, SwitchAgentDetection> | null>(
    null
  );
  const [preview, setPreview] = useState<SwitchPreviewResponse | null>(null);
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [loadingDetect, setLoadingDetect] = useState(true);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [applying, setApplying] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showCcKey, setShowCcKey] = useState(false);

  const availableModels = useMemo(() => {
    const enabled = models.filter((m) => m.enable !== false && m.source !== 'alias');
    return enabled.length > 0
      ? enabled.map((m) => m.id)
      : ['GLM-5.3', 'Kimi-K3.1-Pro', 'GLM-5.3-Flash', 'DeepSeek-V4.1-Flash'];
  }, [models]);

  const loadDetection = useCallback(async () => {
    setLoadingDetect(true);
    try {
      const data = await adminApi.detectAgents();
      setProfiles(data.profiles);
      setDetections(data.agents);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : '读取本机智能体配置失败');
    } finally {
      setLoadingDetect(false);
    }
  }, [onNotify]);

  const refreshPreview = useCallback(
    async (agentId: SwitchAgentId, nextProfiles?: SwitchProfilesState) => {
      setLoadingPreview(true);
      try {
        const profilePayload = nextProfiles ? nextProfiles[agentId] : undefined;
        const data = await adminApi.previewSwitch(
          agentId,
          profilePayload as Record<string, unknown> | undefined
        );
        setPreview(data);
        setSelectedFileIndex(0);
      } catch (err) {
        onNotify('error', err instanceof Error ? err.message : '生成配置预览失败');
      } finally {
        setLoadingPreview(false);
      }
    },
    [onNotify]
  );

  useEffect(() => {
    void loadDetection();
  }, [loadDetection]);

  useEffect(() => {
    void refreshPreview(selectedAgent);
  }, [selectedAgent, refreshPreview]);

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 1800);
    } catch {
      onNotify('error', '无法访问系统剪贴板，请手动选中复制');
    }
  };

  const handleUpdateClaude = async (patch: Partial<SwitchProfilesState['claude']>) => {
    const next: SwitchProfilesState = {
      ...profiles,
      claude: { ...profiles.claude, ...patch },
    };
    setProfiles(next);
    await refreshPreview('claude', next);
  };

  const handleUpdateCodex = async (patch: Partial<SwitchProfilesState['codex']>) => {
    const next: SwitchProfilesState = {
      ...profiles,
      codex: { ...profiles.codex, ...patch },
    };
    setProfiles(next);
    await refreshPreview('codex', next);
  };

  const handleUpdateDsh = async (patch: Partial<SwitchProfilesState['dsh']>) => {
    const next: SwitchProfilesState = {
      ...profiles,
      dsh: { ...profiles.dsh, ...patch },
    };
    setProfiles(next);
    await refreshPreview('dsh', next);
  };

  const handleApplyMerge = async () => {
    setApplying(true);
    try {
      const res = await adminApi.applySwitchMerge(
        selectedAgent,
        profiles[selectedAgent] as unknown as Record<string, unknown>
      );
      onNotify('success', res.message);
      await loadDetection();
      await refreshPreview(selectedAgent);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : '写入配置文件失败');
    } finally {
      setApplying(false);
    }
  };

  const handleRestore = async () => {
    setRestoring(true);
    try {
      const res = await adminApi.restoreSwitchBackup(selectedAgent);
      onNotify('success', res.message);
      await loadDetection();
      await refreshPreview(selectedAgent);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : '还原快照失败');
    } finally {
      setRestoring(false);
    }
  };

  const activeDetection = detections?.[selectedAgent];
  const activeFile = preview?.files[selectedFileIndex] || preview?.files[0];

  return (
    <div className="space-y-6">
      {/* Top Overview Strip: Honest detection of local CLI state */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {(['claude', 'codex', 'dsh'] as SwitchAgentId[]).map((id) => {
          const det = detections?.[id];
          const isSelected = selectedAgent === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setSelectedAgent(id)}
              className={`text-left p-5 rounded-xl border transition-colors ${
                isSelected
                  ? 'bg-white dark:bg-slate-900 border-blue-600 dark:border-blue-500'
                  : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {AGENT_META[id].name}
                </h2>
                <span className="text-xs font-mono text-slate-500 dark:text-slate-400">
                  {AGENT_META[id].cli}
                </span>
              </div>
              <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
                {AGENT_META[id].protocol}
              </p>
              <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-2 text-xs">
                <span
                  className={
                    det?.managedBy === 'codearts-switch'
                      ? 'text-emerald-700 dark:text-emerald-400 font-medium'
                      : 'text-slate-600 dark:text-slate-400'
                  }
                >
                  {loadingDetect ? '正在探测本机配置…' : det ? managedLabel(det.managedBy) : '未探测'}
                </span>
                {det && det.backupCount > 0 && (
                  <span className="text-slate-500 dark:text-slate-400 tabular-nums">
                    快照 {det.backupCount}
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {/* Mode Selector & Profile Configuration */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-6">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 pb-5 border-b border-slate-200 dark:border-slate-800">
          <div>
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {AGENT_META[selectedAgent].name} 路由与接入方式
            </h3>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <span>配置文件：{activeDetection?.configPath || AGENT_META[selectedAgent].configSummary}</span>
              <span aria-hidden="true">·</span>
              <span>历史目录：{activeDetection?.historyPath || '默认用户目录'}</span>
            </div>
          </div>

          <div
            role="tablist"
            aria-label="切换模式"
            className="inline-flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800 shrink-0"
          >
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'zero-intrusion'}
              onClick={() => setMode('zero-intrusion')}
              className={`px-3.5 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                mode === 'zero-intrusion'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              模式 A · 零侵入接力（推荐）
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'merge-global'}
              onClick={() => setMode('merge-global')}
              className={`px-3.5 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                mode === 'merge-global'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              模式 B · 全局无损合并
            </button>
          </div>
        </div>

        {/* Agent-specific Model Mapping Controls */}
        {selectedAgent === 'claude' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <label
                htmlFor="claude-primary"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
              >
                默认主模型 (ANTHROPIC_MODEL)
              </label>
              <select
                id="claude-primary"
                value={profiles.claude.primaryModel}
                onChange={(e) => void handleUpdateClaude({ primaryModel: e.target.value })}
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 font-mono"
              >
                {availableModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                htmlFor="claude-sonnet"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
              >
                Sonnet 槽位映射
              </label>
              <select
                id="claude-sonnet"
                value={profiles.claude.sonnetModel}
                onChange={(e) => void handleUpdateClaude({ sonnetModel: e.target.value })}
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 font-mono"
              >
                {availableModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                htmlFor="claude-opus"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
              >
                Opus 槽位映射
              </label>
              <select
                id="claude-opus"
                value={profiles.claude.opusModel}
                onChange={(e) => void handleUpdateClaude({ opusModel: e.target.value })}
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 font-mono"
              >
                {availableModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                htmlFor="claude-haiku"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
              >
                Haiku 槽位映射
              </label>
              <select
                id="claude-haiku"
                value={profiles.claude.haikuModel}
                onChange={(e) => void handleUpdateClaude({ haikuModel: e.target.value })}
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 font-mono"
              >
                {availableModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {selectedAgent === 'codex' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <label
                htmlFor="codex-model"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
              >
                Codex 模型
              </label>
              <select
                id="codex-model"
                value={profiles.codex.model}
                onChange={(e) => void handleUpdateCodex({ model: e.target.value })}
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 font-mono"
              >
                {availableModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                htmlFor="codex-wire"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
              >
                传输协议 (wire_api)
              </label>
              <select
                id="codex-wire"
                value={profiles.codex.wireApi}
                onChange={(e) =>
                  void handleUpdateCodex({ wireApi: e.target.value as 'responses' | 'chat' })
                }
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 font-mono"
              >
                <option value="responses">responses（桌面推荐）</option>
                <option value="chat">chat（兼容模式）</option>
              </select>
            </div>
            <div>
              <label
                htmlFor="codex-approval"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
              >
                命令审批策略 (approval_policy)
              </label>
              <select
                id="codex-approval"
                value={profiles.codex.approvalPolicy}
                onChange={(e) =>
                  void handleUpdateCodex({
                    approvalPolicy: e.target.value as 'on-request' | 'untrusted' | 'never',
                  })
                }
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 font-mono"
              >
                <option value="on-request">on-request（按需确认）</option>
                <option value="untrusted">untrusted（非信任确认）</option>
                <option value="never">never（全自动）</option>
              </select>
            </div>
            <div>
              <label
                htmlFor="codex-auth-mode"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
              >
                模式 B 鉴权（桌面软件支持）
              </label>
              <select
                id="codex-auth-mode"
                value={profiles.codex.authMode || 'desktop-direct'}
                onChange={(e) =>
                  void handleUpdateCodex({
                    authMode: e.target.value as 'desktop-direct' | 'env-key',
                  })
                }
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              >
                <option value="desktop-direct">桌面软件直连（推荐）</option>
                <option value="env-key">环境变量 env_key（CLI）</option>
              </select>
            </div>
            <div className="sm:col-span-2 lg:col-span-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 px-4 py-3">
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  id="codex-fallback-unknown"
                  type="checkbox"
                  checked={profiles.codex.fallbackUnknownModel !== false}
                  onChange={(e) =>
                    void handleUpdateCodex({ fallbackUnknownModel: e.target.checked })
                  }
                  className="mt-0.5 rounded border-slate-300 dark:border-slate-700 text-blue-600 focus:ring-blue-500"
                />
                <div className="text-xs leading-relaxed">
                  <div className="font-medium text-slate-900 dark:text-slate-100">
                    Codex 桌面端未知模型自动映射到当前码道模型（推荐，无需开启全局强制）
                  </div>
                  <div className="text-slate-500 dark:text-slate-400 mt-0.5">
                    当 Codex 桌面软件发送内置模型名（如 <code className="font-mono">gpt-6.2-sol</code>、<code className="font-mono">gpt-5.6-sol</code>）时，<code className="font-mono">/v1/responses</code> 自动路由至当前选定的{' '}
                    <code className="font-mono text-slate-700 dark:text-slate-200">{profiles.codex.model}</code>，完全不影响 Claude Code 与 DeepSeek Harness。
                  </div>
                </div>
              </label>
            </div>
          </div>
        )}

        {selectedAgent === 'dsh' && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label
                htmlFor="dsh-model"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
              >
                主模型 (default-model)
              </label>
              <select
                id="dsh-model"
                value={profiles.dsh.model}
                onChange={(e) => void handleUpdateDsh({ model: e.target.value })}
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 font-mono"
              >
                {availableModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                htmlFor="dsh-fallback"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
              >
                回退模型 (agent-fallback-model)
              </label>
              <select
                id="dsh-fallback"
                value={profiles.dsh.fallbackModel}
                onChange={(e) => void handleUpdateDsh({ fallbackModel: e.target.value })}
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 font-mono"
              >
                {availableModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-end pb-1">
              <label className="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={profiles.dsh.telemetryDisabled}
                  onChange={(e) => void handleUpdateDsh({ telemetryDisabled: e.target.checked })}
                  className="rounded border-slate-300 dark:border-slate-700 text-blue-600 focus:ring-blue-500"
                />
                <span>关闭客户端遥测 (DISABLED)</span>
              </label>
            </div>
          </div>
        )}

        {/* Mode A: Zero-Intrusion Shared /resume Relay */}
        {mode === 'zero-intrusion' && preview && (
          <div className="space-y-5 pt-2">
            <div className="p-4 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/70 flex items-start gap-3">
              <History className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
              <div className="text-xs leading-relaxed text-slate-700 dark:text-slate-300 space-y-1">
                <div>
                  <span className="font-semibold text-slate-900 dark:text-slate-100">
                    与 CC Switch 零冲突且 100% 双向共享 /resume 会话记录：
                  </span>
                  {preview.zeroIntrusion.historySharedNote}
                </div>
                {preview.zeroIntrusion.overrideSettingsPath && (
                  <div className="text-slate-500 dark:text-slate-400">
                    独立覆盖文件已自动同步至{' '}
                    <code className="font-mono text-slate-700 dark:text-slate-200">
                      {preview.zeroIntrusion.overrideSettingsPath}
                    </code>
                    （调整上方模型后自动刷新，始终不修改你的 <code className="font-mono">~/.claude/settings.json</code>）。
                  </div>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4">
              <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                单次终端启动命令（不改动磁盘配置文件）
              </h4>
              <div
                role="tablist"
                aria-label="终端类型"
                className="inline-flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={shellKind === 'cmd'}
                  onClick={() => setShellKind('cmd')}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                    shellKind === 'cmd'
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  CMD (命令提示符)
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={shellKind === 'powershell'}
                  onClick={() => setShellKind('powershell')}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                    shellKind === 'powershell'
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  PowerShell
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={shellKind === 'bash'}
                  onClick={() => setShellKind('bash')}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                    shellKind === 'bash'
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  Bash / Zsh (macOS · Linux)
                </button>
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-950 text-slate-100 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 mb-2.5 border-b border-slate-800 text-xs text-slate-400">
                <span className="inline-flex items-center gap-1.5">
                  <Terminal className="w-3.5 h-3.5 shrink-0" />
                  {shellKind === 'cmd'
                    ? '在 Windows 命令提示符 (cmd.exe) 进入项目目录后直接粘贴运行（随时可执行 /resume）'
                    : shellKind === 'powershell'
                      ? '在 PowerShell 窗口进入项目目录后粘贴运行（若使用黑框 cmd.exe，请切换到「CMD」标签）'
                      : '在 Bash / Zsh 终端进入项目目录后直接粘贴运行（随时可执行 /resume）'}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    void handleCopy(
                      'oneshot',
                      shellKind === 'cmd'
                        ? preview.zeroIntrusion.cmd
                        : shellKind === 'powershell'
                          ? preview.zeroIntrusion.powershell
                          : preview.zeroIntrusion.bash
                    )
                  }
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-100 transition-colors whitespace-nowrap"
                >
                  {copiedId === 'oneshot' ? (
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                  <span>{copiedId === 'oneshot' ? '已复制' : '复制启动命令'}</span>
                </button>
              </div>
              <pre className="text-xs font-mono leading-relaxed whitespace-pre-wrap break-all overflow-x-auto">
                {shellKind === 'cmd'
                  ? preview.zeroIntrusion.cmd
                  : shellKind === 'powershell'
                    ? preview.zeroIntrusion.powershell
                    : preview.zeroIntrusion.bash}
              </pre>
            </div>

            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    推荐：配置快捷命令{' '}
                    <code className="font-mono text-blue-600 dark:text-blue-400">
                      {shellKind === 'cmd'
                        ? `${preview.zeroIntrusion.aliasName}.cmd`
                        : preview.zeroIntrusion.aliasName}
                    </code>
                  </h4>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    {shellKind === 'cmd' ? (
                      <>
                        保存为 <code className="font-mono">{preview.zeroIntrusion.aliasName}.cmd</code>{' '}
                        放到系统 <code className="font-mono">PATH</code> 目录（如{' '}
                        <code className="font-mono">%USERPROFILE%\.local\bin</code>）后：输入{' '}
                        <code className="font-mono">{AGENT_META[selectedAgent].cli}</code> 走你原有的 CC
                        Switch，输入{' '}
                        <code className="font-mono">{preview.zeroIntrusion.aliasName}</code>{' '}
                        走码道网关，退出后自动清理环境变量。
                      </>
                    ) : (
                      <>
                        写入{' '}
                        <code className="font-mono">
                          {shellKind === 'powershell' ? '$PROFILE' : '~/.zshrc 或 ~/.bashrc'}
                        </code>{' '}
                        后：输入 <code className="font-mono">{AGENT_META[selectedAgent].cli}</code>{' '}
                        走你原有的 CC Switch，输入{' '}
                        <code className="font-mono">{preview.zeroIntrusion.aliasName}</code>{' '}
                        走码道网关，两边共享同一份历史。
                      </>
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    void handleCopy(
                      'alias',
                      shellKind === 'cmd'
                        ? preview.zeroIntrusion.cmdAliasSnippet
                        : shellKind === 'powershell'
                          ? preview.zeroIntrusion.powershellAliasSnippet
                          : preview.zeroIntrusion.bashAliasSnippet
                    )
                  }
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
                >
                  {copiedId === 'alias' ? (
                    <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                  <span>
                    {copiedId === 'alias'
                      ? '已复制'
                      : shellKind === 'cmd'
                        ? `复制 ${preview.zeroIntrusion.aliasName}.cmd`
                        : `复制 ${preview.zeroIntrusion.aliasName}`}
                  </span>
                </button>
              </div>
              <pre className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-4 text-xs font-mono text-slate-800 dark:text-slate-200 overflow-x-auto leading-relaxed">
                {shellKind === 'cmd'
                  ? preview.zeroIntrusion.cmdAliasSnippet
                  : shellKind === 'powershell'
                    ? preview.zeroIntrusion.powershellAliasSnippet
                    : preview.zeroIntrusion.bashAliasSnippet}
              </pre>
            </div>
          </div>
        )}

        {/* Mode B: Lossless Deep-Merge + Diff Preview + One-Click Restore */}
        {mode === 'merge-global' && preview && (
          <div className="space-y-5 pt-2">
            <div className="p-4 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/70 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="flex items-start gap-3">
                <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                <div className="text-xs leading-relaxed text-slate-700 dark:text-slate-300">
                  <span className="font-semibold text-slate-900 dark:text-slate-100">
                    无损深合并 + 写入前自动快照：
                  </span>
                  仅精准更新码道路由字段，保留你原有的 hooks、permissions、MCP 服务器与其他提供商配置，并在应用目录留存快照随时一键还原。
                </div>
              </div>
              <button
                type="button"
                onClick={() => void refreshPreview(selectedAgent)}
                disabled={loadingPreview}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loadingPreview ? 'animate-spin' : ''}`} />
                <span>重新比对 Diff</span>
              </button>
            </div>

            {/* File selector when multiple files are merged */}
            {preview.files.length > 1 && (
              <div className="flex items-center gap-2 border-b border-slate-200 dark:border-slate-800 pb-2">
                {preview.files.map((f, idx) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setSelectedFileIndex(idx)}
                    className={`px-3 py-1.5 text-xs font-mono rounded-md transition-colors whitespace-nowrap ${
                      idx === selectedFileIndex
                        ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900'
                        : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            )}

            {activeFile && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-400">
                  <span className="inline-flex items-center gap-1.5 font-mono text-slate-800 dark:text-slate-200">
                    <FileDiff className="w-3.5 h-3.5 text-slate-500" />
                    {activeFile.targetPath}
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    <span>
                      保留原有项：
                      {activeFile.preservedKeys.length > 0
                        ? activeFile.preservedKeys.join(' · ')
                        : '无原有自定义字段'}
                    </span>
                  </div>
                </div>

                <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-950 overflow-hidden">
                  <div className="max-h-80 overflow-y-auto p-3 font-mono text-xs leading-relaxed">
                    {activeFile.diffLines.map((d, idx) => (
                      <div
                        key={idx}
                        className={`px-2 py-0.5 whitespace-pre-wrap break-all ${
                          d.type === 'add'
                            ? 'bg-emerald-950/70 text-emerald-300'
                            : d.type === 'remove'
                              ? 'bg-rose-950/70 text-rose-300'
                              : 'text-slate-400'
                        }`}
                      >
                        <span className="inline-block w-4 select-none opacity-70">
                          {d.type === 'add' ? '+' : d.type === 'remove' ? '-' : ' '}
                        </span>
                        {d.line}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-200 dark:border-slate-800">
              <div className="text-xs text-slate-500 dark:text-slate-400">
                {activeDetection?.hasBackup && activeDetection.lastBackupAt
                  ? `最近快照时间：${formatDateTimeCN(activeDetection.lastBackupAt)}（共保留 ${activeDetection.backupCount} 份）`
                  : '首次写入时将自动保存原始文件快照'}
              </div>

              <div className="flex items-center gap-3">
                {activeDetection?.hasBackup && (
                  <button
                    type="button"
                    onClick={() => void handleRestore()}
                    disabled={restoring}
                    className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap disabled:opacity-50"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>{restoring ? '正在还原…' : '一键还原到接管前'}</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => void handleApplyMerge()}
                  disabled={applying}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors whitespace-nowrap disabled:opacity-50"
                >
                  <span>
                    {applying
                      ? '正在安全合并写入…'
                      : `应用无损合并到 ${AGENT_META[selectedAgent].name}`}
                  </span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Codex Desktop App + CC Switch Custom Provider Quick-Copy Card */}
        {selectedAgent === 'codex' && preview?.ccSwitchProvider && (
          <div className="pt-5 border-t border-slate-200 dark:border-slate-800 space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  配合 CC Switch 使用（推荐给 Codex 桌面软件 / VS Code 插件用户）
                </h4>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
                  在 CC Switch → Codex 点击「+ 添加供应商」填入以下参数，即可在官方 / 中转站 / 码道之间随时一键切换；切换后请彻底退出并重开 Codex 桌面版或编辑器窗口。
                </p>
              </div>
              <button
                type="button"
                onClick={() =>
                  void handleCopy('ccswitch-toml', preview.ccSwitchProvider!.tomlSnippet)
                }
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
              >
                {copiedId === 'ccswitch-toml' ? (
                  <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
                <span>{copiedId === 'ccswitch-toml' ? '已复制 TOML' : '复制完整 TOML 片段'}</span>
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
              <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-1">
                <div className="flex items-center justify-between text-slate-500 dark:text-slate-400">
                  <span>Base URL (含 /v1)</span>
                  <button
                    type="button"
                    onClick={() => void handleCopy('cc-url', preview.ccSwitchProvider!.baseUrl)}
                    className="text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap"
                  >
                    {copiedId === 'cc-url' ? '已复制' : '复制'}
                  </button>
                </div>
                <div className="font-mono text-slate-900 dark:text-slate-100 break-all">
                  {preview.ccSwitchProvider.baseUrl}
                </div>
              </div>

              <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-1">
                <div className="flex items-center justify-between text-slate-500 dark:text-slate-400">
                  <span>API Key</span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setShowCcKey((v) => !v)}
                      className="text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 whitespace-nowrap"
                    >
                      {showCcKey ? '隐藏' : '显示'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleCopy('cc-key', preview.ccSwitchProvider!.apiKey)}
                      className="text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap"
                    >
                      {copiedId === 'cc-key' ? '已复制' : '复制'}
                    </button>
                  </div>
                </div>
                <div className="font-mono text-slate-900 dark:text-slate-100 truncate">
                  {showCcKey
                    ? preview.ccSwitchProvider.apiKey
                    : preview.ccSwitchProvider.apiKey.length > 12
                      ? `${preview.ccSwitchProvider.apiKey.slice(0, 8)}••••${preview.ccSwitchProvider.apiKey.slice(-4)}`
                      : preview.ccSwitchProvider.apiKey}
                </div>
              </div>

              <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-1">
                <div className="flex items-center justify-between text-slate-500 dark:text-slate-400">
                  <span>推荐模型 (model)</span>
                  <button
                    type="button"
                    onClick={() => void handleCopy('cc-model', preview.ccSwitchProvider!.model)}
                    className="text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap"
                  >
                    {copiedId === 'cc-model' ? '已复制' : '复制'}
                  </button>
                </div>
                <div className="font-mono text-slate-900 dark:text-slate-100">
                  {preview.ccSwitchProvider.model}
                </div>
              </div>

              <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-1">
                <div className="text-slate-500 dark:text-slate-400">协议 (wire_api)</div>
                <div className="font-mono text-slate-900 dark:text-slate-100">
                  {preview.ccSwitchProvider.wireApi}（桌面版必选）
                </div>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
};
