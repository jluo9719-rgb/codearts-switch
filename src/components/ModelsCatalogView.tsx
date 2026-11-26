import React, { useMemo, useState } from 'react';
import { Activity, RefreshCw, Search, X } from 'lucide-react';
import { adminApi } from '../lib/apiClient';
import type { AdminModel, ModelProbeItem, RuntimeMode } from '../types';

interface ModelsCatalogViewProps {
  models: AdminModel[];
  runtimeMode: RuntimeMode;
  onConnectGoBridge: (origin: string, autoDetect?: boolean) => Promise<boolean>;
  onRefreshState: () => Promise<void>;
  onAssignModelToClaude: (modelId: string) => Promise<void>;
  onNotify: (kind: 'success' | 'error' | 'info', message: string) => void;
}

export const ModelsCatalogView: React.FC<ModelsCatalogViewProps> = ({
  models,
  runtimeMode,
  onConnectGoBridge,
  onRefreshState,
  onAssignModelToClaude,
  onNotify,
}) => {
  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'upstream' | 'fallback'>('all');
  const [refreshing, setRefreshing] = useState(false);
  const [connectingGo, setConnectingGo] = useState(false);
  const [probingModel, setProbingModel] = useState<string | null>(null);
  const [batchModalOpen, setBatchModalOpen] = useState(false);
  const [batchProbing, setBatchProbing] = useState(false);
  const [probeMap, setProbeMap] = useState<Record<string, ModelProbeItem>>({});

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return models.filter((m) => {
      if (m.source === 'alias') return false;
      if (sourceFilter !== 'all' && m.source !== sourceFilter) return false;
      if (!q) return true;
      return (
        m.id.toLowerCase().includes(q) ||
        (m.name || '').toLowerCase().includes(q) ||
        (m.description || '').toLowerCase().includes(q)
      );
    });
  }, [models, query, sourceFilter]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const res = await adminApi.refreshModels();
      const isPreview = Boolean((res as { preview_mode?: boolean }).preview_mode);
      onNotify(
        'info',
        isPreview
          ? `已同步内置对照模型清单（${res.count} 个，与码道 2026 实时目录对齐）。如需直连拉取你账号专属上游列表，请连接本地 Go CodeArts2API。`
          : `已从上游实时拉取模型目录，当前共 ${res.count} 个模型`
      );
      await onRefreshState();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : '拉取模型目录失败');
    } finally {
      setRefreshing(false);
    }
  };

  const handleProbeSingle = async (modelId: string) => {
    setProbingModel(modelId);
    try {
      const res = await adminApi.probeModels([modelId]);
      const next = { ...probeMap };
      for (const item of res.results) {
        next[item.model] = item;
      }
      setProbeMap(next);
      const first = res.results[0];
      if (first?.ok) {
        onNotify('success', `模型 ${modelId} 探活通过（${first.latency_ms ?? 0}ms）`);
      } else {
        onNotify('error', first?.error || `模型 ${modelId} 探活失败`);
      }
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : '模型探活失败');
    } finally {
      setProbingModel(null);
    }
  };

  const handleBatchProbe = async () => {
    setBatchProbing(true);
    try {
      const targetIds = filtered.map((m) => m.id).slice(0, 64);
      const res = await adminApi.probeModels(targetIds);
      const next = { ...probeMap };
      for (const item of res.results) {
        next[item.model] = item;
      }
      setProbeMap(next);
      setBatchModalOpen(false);
      onNotify(
        'info',
        `批量探活完成：共 ${res.total} 个，可用 ${res.available} 个，不可用 ${res.unavailable} 个`
      );
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : '批量探活失败');
    } finally {
      setBatchProbing(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="p-5 border-b border-slate-200 dark:border-slate-800 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              积分通道模型目录
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              已移除官方下线的 benefit 通道；列表仅保留当前可用的内置积分模型与上游同步模型。
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {runtimeMode === 'node-preview' && (
              <button
                type="button"
                disabled={connectingGo}
                onClick={async () => {
                  setConnectingGo(true);
                  await onConnectGoBridge('http://127.0.0.1:10087', true);
                  setConnectingGo(false);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50/70 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300 hover:bg-blue-100/70 dark:hover:bg-blue-900/40 whitespace-nowrap disabled:opacity-50"
              >
                <span>{connectingGo ? '连接中…' : '直连本地 Go 核心同步'}</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => void handleRefresh()}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              <span>刷新目录</span>
            </button>
            <button
              type="button"
              onClick={() => setBatchModalOpen(true)}
              disabled={filtered.length === 0}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white whitespace-nowrap disabled:opacity-50"
            >
              <Activity className="w-3.5 h-3.5" />
              <span>批量探活 ({filtered.length})</span>
            </button>
          </div>
        </div>

        {/* Filter Toolbar */}
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-slate-50/60 dark:bg-slate-950/30">
          <div className="relative w-full sm:w-72">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="搜索模型名称或描述"
              placeholder="搜索模型 ID 或说明…"
              className="w-full pl-9 pr-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
            />
          </div>

          <div className="inline-flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-xs font-medium">
            {(
              [
                ['all', '全部'],
                ['upstream', '上游实时'],
                ['fallback', '内置基准'],
              ] as const
            ).map(([val, label]) => (
              <button
                key={val}
                type="button"
                onClick={() => setSourceFilter(val)}
                className={`px-3 py-1 rounded-md transition-colors whitespace-nowrap ${
                  sourceFilter === val
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-500 dark:text-slate-400">
            没有匹配的模型记录，请调整筛选条件或点击「刷新目录」。
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400 bg-slate-50/70 dark:bg-slate-950/40">
                  <th className="py-3 px-4 whitespace-nowrap">模型 ID</th>
                  <th className="py-3 px-4 whitespace-nowrap">能力与来源</th>
                  <th className="py-3 px-4 text-right whitespace-nowrap">上下文窗口</th>
                  <th className="py-3 px-4 text-right whitespace-nowrap">消耗系数</th>
                  <th className="py-3 px-4 whitespace-nowrap">最近探活结果</th>
                  <th className="py-3 px-4 text-right whitespace-nowrap">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
                {filtered.map((m) => {
                  const probe = probeMap[m.id];
                  return (
                    <tr
                      key={m.id}
                      className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40 transition-colors"
                    >
                      <td className="py-3.5 px-4">
                        <div className="font-mono font-medium text-slate-900 dark:text-slate-100">
                          {m.id}
                        </div>
                        {m.description && (
                          <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 max-w-md">
                            {m.description}
                          </div>
                        )}
                      </td>
                      <td className="py-3.5 px-4 text-xs text-slate-600 dark:text-slate-300 whitespace-nowrap">
                        {m.source === 'upstream' ? '上游实时' : '内置基准'}
                        {m.supports_tools ? ' · 支持工具' : ''}
                        {m.supports_images ? ' · 图像' : ''}
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono text-xs tabular-nums text-slate-700 dark:text-slate-300 whitespace-nowrap">
                        {(() => {
                          const ctx = m.context_window ?? m.max_tokens;
                          if (!ctx) return '—';
                          return ctx >= 1000000 ? '1M' : `${Math.round(ctx / 1024)}K`;
                        })()}
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono text-xs tabular-nums text-slate-700 dark:text-slate-300 whitespace-nowrap">
                        {(() => {
                          const mult = m.credit_multiplier ?? m.multiplier;
                          return mult !== undefined ? `${Number(mult.toFixed(2))}x` : '1x';
                        })()}
                      </td>
                      <td className="py-3.5 px-4 text-xs">
                        {!probe ? (
                          <span className="text-slate-400 dark:text-slate-500">未探活</span>
                        ) : probe.ok ? (
                          <span className="text-emerald-700 dark:text-emerald-400 font-medium tabular-nums">
                            可用 · {probe.latency_ms ?? 0}ms
                          </span>
                        ) : (
                          <span
                            className="text-rose-700 dark:text-rose-400 block max-w-xs truncate"
                            title={probe.error}
                          >
                            失败 · {probe.error}
                          </span>
                        )}
                      </td>
                      <td className="py-3.5 px-4 text-right">
                        <div className="inline-flex items-center gap-2 text-xs">
                          <button
                            type="button"
                            disabled={probingModel === m.id}
                            onClick={() => void handleProbeSingle(m.id)}
                            className="text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap disabled:opacity-50"
                          >
                            {probingModel === m.id ? '探活中…' : '单测探活'}
                          </button>
                          <span aria-hidden="true" className="text-slate-300 dark:text-slate-700">
                            ·
                          </span>
                          <button
                            type="button"
                            onClick={() => void onAssignModelToClaude(m.id)}
                            className="text-slate-600 dark:text-slate-300 hover:underline whitespace-nowrap"
                          >
                            设为 Claude 主模型
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

      {/* Batch Probe Cost Confirmation Modal */}
      {batchModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="batch-probe-title"
          className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4"
        >
          <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3
                id="batch-probe-title"
                className="text-base font-semibold text-slate-900 dark:text-slate-100"
              >
                确认执行批量模型探活
              </h3>
              <button
                type="button"
                aria-label="关闭确认弹窗"
                onClick={() => setBatchModalOpen(false)}
                className="p-1 text-slate-500 hover:text-slate-900 dark:hover:text-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-300">
              本次将对当前筛选出的 <strong className="tabular-nums">{filtered.length}</strong> 个模型逐一发送极小推理探针（单次上限 64 个）。连接真实 CodeArts 账号时，每个被探测模型会消耗少量积分，请确认后继续。
            </p>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setBatchModalOpen(false)}
                className="px-4 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void handleBatchProbe()}
                disabled={batchProbing}
                className="px-4 py-2 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
              >
                {batchProbing ? '正在逐一探活…' : '确认开始探活'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
