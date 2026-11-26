import React, { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { adminApi } from '../lib/apiClient';
import type { AdminKey, AdminLogEntry, AdminStats } from '../types';

interface LogsKeysViewProps {
  keys: AdminKey[];
  stats: AdminStats;
  onRefreshState: () => Promise<void>;
  onNotify: (kind: 'success' | 'error' | 'info', message: string) => void;
}

export const LogsKeysView: React.FC<LogsKeysViewProps> = ({
  keys,
  stats,
  onRefreshState,
  onNotify,
}) => {
  const [newKeyName, setNewKeyName] = useState('');
  const [creatingKey, setCreatingKey] = useState(false);
  const [revealedKey, setRevealedKey] = useState<{ name: string; key: string } | null>(null);
  const [copiedNewKey, setCopiedNewKey] = useState(false);
  const [logs, setLogs] = useState<AdminLogEntry[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);

  const loadLogs = useCallback(async () => {
    setLoadingLogs(true);
    try {
      const res = await adminApi.getLogs(100);
      setLogs(res.logs || []);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : '读取请求日志失败');
    } finally {
      setLoadingLogs(false);
    }
  }, [onNotify]);

  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  const handleCreateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreatingKey(true);
    try {
      const res = await adminApi.createKey(newKeyName.trim() || '终端密钥');
      setRevealedKey({ name: newKeyName.trim() || '新建密钥', key: res.key });
      setNewKeyName('');
      onNotify('success', '已生成新的持久化网关密钥，请立即复制保存（关闭后仅显示脱敏摘要）');
      await onRefreshState();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : '创建密钥失败');
    } finally {
      setCreatingKey(false);
    }
  };

  const handleCopyRevealed = async () => {
    if (!revealedKey) return;
    try {
      await navigator.clipboard.writeText(revealedKey.key);
      setCopiedNewKey(true);
      setTimeout(() => setCopiedNewKey(false), 1800);
    } catch {
      onNotify('error', '复制失败，请手动选中复制');
    }
  };

  const handleToggleKey = async (maskedKey: string) => {
    try {
      await adminApi.toggleKey(maskedKey);
      await onRefreshState();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : '切换密钥状态失败');
    }
  };

  const handleDeleteKey = async (maskedKey: string) => {
    try {
      await adminApi.deleteKey(maskedKey);
      onNotify('success', '已删除该网关密钥');
      await onRefreshState();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : '删除密钥失败');
    }
  };

  const handleClearLogs = async () => {
    try {
      await adminApi.clearLogs();
      setLogs([]);
      onNotify('success', '已清空请求日志');
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : '清空日志失败');
    }
  };

  const handleClearStats = async () => {
    try {
      await adminApi.clearStats();
      onNotify('success', '已重置统计计数');
      await onRefreshState();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : '重置统计失败');
    }
  };

  return (
    <div className="space-y-6">
      {/* Persistent Multi-Key Management */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="p-5 border-b border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              持久化网关 API 密钥
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              密钥持久化保存在应用数据目录，重启服务不会失效；列表默认脱敏展示，仅在创建瞬间展示一次明文。
            </p>
          </div>

          <form onSubmit={handleCreateKey} className="flex items-center gap-2 shrink-0">
            <input
              type="text"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              aria-label="新密钥备注名"
              placeholder="备注名，如 Claude 专用"
              className="w-44 px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            />
            <button
              type="submit"
              disabled={creatingKey}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white whitespace-nowrap disabled:opacity-50"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{creatingKey ? '创建中…' : '新建密钥'}</span>
            </button>
          </form>
        </div>

        {/* One-time reveal banner for newly created key */}
        {revealedKey && (
          <div className="px-5 py-4 bg-blue-50/70 dark:bg-blue-950/30 border-b border-blue-200 dark:border-blue-900/60 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="space-y-1 min-w-0">
              <div className="text-xs font-semibold text-blue-900 dark:text-blue-200">
                新密钥已生成（仅展示这一次，请立即复制）：{revealedKey.name}
              </div>
              <code className="block text-xs font-mono text-slate-900 dark:text-slate-100 break-all">
                {revealedKey.key}
              </code>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => void handleCopyRevealed()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white whitespace-nowrap"
              >
                {copiedNewKey ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedNewKey ? '已复制' : '复制明文密钥'}</span>
              </button>
              <button
                type="button"
                onClick={() => setRevealedKey(null)}
                className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300"
              >
                我已保存
              </button>
            </div>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400 bg-slate-50/70 dark:bg-slate-950/40">
                <th className="py-3 px-4 whitespace-nowrap">备注名</th>
                <th className="py-3 px-4 whitespace-nowrap">脱敏密钥</th>
                <th className="py-3 px-4 whitespace-nowrap">状态</th>
                <th className="py-3 px-4 text-right whitespace-nowrap">累计调用</th>
                <th className="py-3 px-4 whitespace-nowrap">创建时间</th>
                <th className="py-3 px-4 text-right whitespace-nowrap">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
              {keys.map((k) => (
                <tr key={`${k.key}-${k.created_at}`} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                  <td className="py-3 px-4 font-medium text-slate-900 dark:text-slate-100">
                    {k.name}
                  </td>
                  <td className="py-3 px-4 font-mono text-xs text-slate-700 dark:text-slate-300">
                    {k.key}
                  </td>
                  <td className="py-3 px-4 text-xs">
                    <span
                      className={
                        k.enabled
                          ? 'text-emerald-700 dark:text-emerald-400 font-medium'
                          : 'text-slate-500 dark:text-slate-400'
                      }
                    >
                      {k.enabled ? '启用' : '已停用'}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-right font-mono text-xs tabular-nums text-slate-700 dark:text-slate-300">
                    {k.requests}
                  </td>
                  <td className="py-3 px-4 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                    {new Date(k.created_at).toLocaleString('zh-CN', { hour12: false })}
                  </td>
                  <td className="py-3 px-4 text-right text-xs">
                    <div className="inline-flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleToggleKey(k.key)}
                        className="text-slate-600 dark:text-slate-300 hover:underline whitespace-nowrap"
                      >
                        {k.enabled ? '停用' : '启用'}
                      </button>
                      <span aria-hidden="true" className="text-slate-300 dark:text-slate-700">
                        ·
                      </span>
                      <button
                        type="button"
                        aria-label={`删除密钥 ${k.name}`}
                        onClick={() => void handleDeleteKey(k.key)}
                        className="text-rose-600 dark:text-rose-400 hover:underline inline-flex items-center gap-1 whitespace-nowrap"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>删除</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Request Logs & Stats */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="p-5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              网关请求日志与统计
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
              <span>总请求 {(stats.total_requests ?? 0).toLocaleString()}</span>
              <span aria-hidden="true">·</span>
              <span>失败 {(stats.failed_requests ?? 0).toLocaleString()}</span>
              <span aria-hidden="true">·</span>
              <span>输入 Token {(stats.total_input_tokens ?? 0).toLocaleString()}</span>
              <span aria-hidden="true">·</span>
              <span>
                输出 Token {(stats.total_output_tokens ?? stats.total_output_chars ?? 0).toLocaleString()}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void loadLogs()}
              disabled={loadingLogs}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loadingLogs ? 'animate-spin' : ''}`} />
              <span>刷新日志</span>
            </button>
            <button
              type="button"
              onClick={() => void handleClearStats()}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              重置统计
            </button>
            <button
              type="button"
              onClick={() => void handleClearLogs()}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-rose-700 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30"
            >
              清空日志
            </button>
          </div>
        </div>

        {logs.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-500 dark:text-slate-400">
            暂无网关调用记录。在终端启动 Claude Code / Codex CLI / DeepSeek Harness 发起请求后将自动记录。
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400 bg-slate-50/70 dark:bg-slate-950/40">
                  <th className="py-3 px-4 whitespace-nowrap">时间</th>
                  <th className="py-3 px-4 whitespace-nowrap">协议</th>
                  <th className="py-3 px-4 whitespace-nowrap">模型</th>
                  <th className="py-3 px-4 whitespace-nowrap">路由账号</th>
                  <th className="py-3 px-4 text-right whitespace-nowrap">状态码</th>
                  <th className="py-3 px-4 text-right whitespace-nowrap">耗时</th>
                  <th className="py-3 px-4 text-right whitespace-nowrap">Token (入 / 出)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                {logs.map((item, idx) => {
                  const ts = item.at || item.time || '';
                  const latency = item.latency_ms ?? item.duration_ms ?? 0;
                  const inTok = item.input_tokens ?? item.in_tokens ?? 0;
                  const outTok = item.output_tokens ?? item.out_tokens ?? item.out_chars ?? 0;
                  return (
                    <tr
                      key={item.id || `${ts}-${item.model}-${idx}`}
                      className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40"
                    >
                      <td className="py-3 px-4 font-mono tabular-nums text-slate-500 dark:text-slate-400 whitespace-nowrap">
                        {ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }) : '—'}
                      </td>
                      <td className="py-3 px-4 font-mono text-slate-700 dark:text-slate-300 whitespace-nowrap">
                        {item.protocol || item.path || '—'}
                      </td>
                      <td className="py-3 px-4 font-mono font-medium text-slate-900 dark:text-slate-100 whitespace-nowrap">
                        {item.model}
                      </td>
                      <td className="py-3 px-4 text-slate-600 dark:text-slate-300">
                        {item.account || '—'}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums whitespace-nowrap">
                        <span
                          className={
                            item.status < 400
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : 'text-rose-700 dark:text-rose-400'
                          }
                        >
                          {item.status}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-600 dark:text-slate-300 whitespace-nowrap">
                        {latency}ms
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300 whitespace-nowrap">
                        {inTok} / {outTok}
                        <span className="text-slate-400 dark:text-slate-500">
                          {' '}({item.usage_source === 'upstream' ? '上游' : '估算'})
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};
