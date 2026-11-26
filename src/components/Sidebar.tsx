import React from 'react';
import {
  KeyRound,
  Layers,
  Moon,
  Settings,
  Sun,
  Terminal,
  Users,
} from 'lucide-react';

export type NavSection = 'agents' | 'accounts' | 'models' | 'logs_keys' | 'settings';

interface SidebarProps {
  activeSection: NavSection;
  onSelectSection: (section: NavSection) => void;
  gatewayBind: string;
  healthyAccounts: number;
  totalAccounts: number;
  activeKeysCount: number;
  darkMode: boolean;
  onToggleDarkMode: () => void;
}

const NAV_ITEMS: Array<{
  id: NavSection;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'agents', label: '智能体切换', icon: Terminal },
  { id: 'accounts', label: '账号与积分', icon: Users },
  { id: 'models', label: '模型目录', icon: Layers },
  { id: 'logs_keys', label: '日志与密钥', icon: KeyRound },
  { id: 'settings', label: '网关设置与打包', icon: Settings },
];

export const Sidebar: React.FC<SidebarProps> = ({
  activeSection,
  onSelectSection,
  gatewayBind,
  healthyAccounts,
  totalAccounts,
  activeKeysCount,
  darkMode,
  onToggleDarkMode,
}) => {
  return (
    <aside className="w-64 shrink-0 border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col justify-between h-screen sticky top-0">
      <div>
        <div className="h-16 px-6 flex items-center border-b border-slate-200 dark:border-slate-800">
          <span className="text-base font-bold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap">
            码道 Switch
          </span>
        </div>

        <nav aria-label="主导航" className="p-3 space-y-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = activeSection === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectSection(item.id)}
                aria-current={isActive ? 'page' : undefined}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium whitespace-nowrap ${
                  isActive
                    ? 'bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-300'
                    : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/70 hover:text-slate-900 dark:hover:text-slate-100'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      <div className="p-4 border-t border-slate-200 dark:border-slate-800 space-y-3">
        <div className="space-y-1.5 text-xs text-slate-500 dark:text-slate-400">
          <div className="flex items-center justify-between gap-2">
            <span>本机监听</span>
            <span className="font-mono tabular-nums text-slate-700 dark:text-slate-300 truncate">
              {gatewayBind}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span>可用账号</span>
            <span className="font-mono tabular-nums text-slate-700 dark:text-slate-300">
              {healthyAccounts} / {totalAccounts}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span>启用密钥</span>
            <span className="font-mono tabular-nums text-slate-700 dark:text-slate-300">
              {activeKeysCount}
            </span>
          </div>
        </div>

        <button
          type="button"
          onClick={onToggleDarkMode}
          aria-label={darkMode ? '切换为浅色外观' : '切换为深色外观'}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
        >
          {darkMode ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
          <span>{darkMode ? '浅色外观' : '深色外观'}</span>
        </button>
      </div>
    </aside>
  );
};
