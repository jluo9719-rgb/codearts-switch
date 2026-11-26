import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildClaudeOverrideSettingsJson,
  buildCodexCCSwitchSnippet,
  buildZeroIntrusionLaunchers,
  computeLineDiff,
  mergeClaudeSettings,
  mergeCodexAuthJson,
  mergeCodexConfigToml,
  mergeDshCredentialsYaml,
  mergeDshSettingsYaml,
} from '../src/lib/switcherEngine';
import type {
  AdminModel,
  SwitchAgentDetection,
  SwitchAgentId,
  SwitchApplyResponse,
  SwitchFilePreview,
  SwitchPreviewResponse,
  SwitchProfilesState,
  SwitchRestoreResponse,
} from '../src/types';

interface SwitchSnapshotFile {
  targetPath: string;
  existed: boolean;
  content: string;
  sha256: string;
}

interface SwitchSnapshot {
  id: string;
  agentId: SwitchAgentId;
  createdAt: string;
  files: SwitchSnapshotFile[];
}

function getSnapshotsDir(): string {
  const base = process.env.CODEARTS_SWITCH_DATA_DIR?.trim()
    ? path.resolve(process.env.CODEARTS_SWITCH_DATA_DIR.trim())
    : path.resolve(process.cwd(), 'data');
  const dir = path.join(base, 'switch-snapshots');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

/**
 * Strictly confines config file resolution inside user's home directory
 * under hardcoded CLI subdirectories (.claude, .codex, .dsh).
 */
function resolveHomeConfinedFile(
  subDir: '.claude' | '.codex' | '.dsh' | '.codearts-switch',
  fileName:
    | 'settings.json'
    | 'config.toml'
    | 'auth.json'
    | 'settings.yaml'
    | '.credentials.yaml'
    | 'claude-override.json'
): string {
  const home = path.resolve(os.homedir());
  const dir = path.resolve(home, subDir);
  const fullPath = path.resolve(dir, fileName);
  if (!dir.startsWith(home + path.sep) || !fullPath.startsWith(dir + path.sep)) {
    throw new Error('目标路径安全校验失败');
  }
  return fullPath;
}

function safeReadText(filePath: string): { exists: boolean; content: string } {
  try {
    if (fs.existsSync(filePath)) {
      return { exists: true, content: fs.readFileSync(filePath, 'utf8') };
    }
  } catch {
    // treat unreadable as missing
  }
  return { exists: false, content: '' };
}

function writeConfinedFileAtomic(filePath: string, content: string, sensitive = false): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const tmpPath = `${filePath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmpPath, content, {
    encoding: 'utf8',
    mode: sensitive ? 0o600 : 0o644,
  });
  fs.renameSync(tmpPath, filePath);
}

function listSnapshots(agentId: SwitchAgentId): SwitchSnapshot[] {
  const dir = getSnapshotsDir();
  const prefix = `${agentId}-`;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .sort()
    .reverse();

  const out: SwitchSnapshot[] = [];
  for (const name of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, name), 'utf8');
      const parsed = JSON.parse(raw) as SwitchSnapshot;
      if (parsed && parsed.agentId === agentId && Array.isArray(parsed.files)) {
        out.push(parsed);
      }
    } catch {
      // skip corrupt snapshot
    }
  }
  return out;
}

function saveSnapshot(agentId: SwitchAgentId, targetPaths: string[]): { snapshot: SwitchSnapshot; snapshotPath: string } {
  const dir = getSnapshotsDir();
  const id = `${agentId}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const snapshotFiles: SwitchSnapshotFile[] = targetPaths.map((targetPath) => {
    const { exists, content } = safeReadText(targetPath);
    return {
      targetPath,
      existed: exists,
      content,
      sha256: crypto.createHash('sha256').update(content, 'utf8').digest('hex'),
    };
  });

  const snapshot: SwitchSnapshot = {
    id,
    agentId,
    createdAt: new Date().toISOString(),
    files: snapshotFiles,
  };

  const snapshotPath = path.join(dir, `${id}.json`);
  writeConfinedFileAtomic(snapshotPath, JSON.stringify(snapshot, null, 2), true);

  // Retain at most 10 snapshots per agent
  const existing = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${agentId}-`) && f.endsWith('.json'))
    .sort()
    .reverse();
  for (const stale of existing.slice(10)) {
    try {
      fs.unlinkSync(path.join(dir, stale));
    } catch {
      // ignore cleanup error
    }
  }

  return { snapshot, snapshotPath };
}

export function detectAgentConfig(
  agentId: SwitchAgentId,
  gatewayBaseUrl: string
): SwitchAgentDetection {
  const home = os.homedir();
  const snapshots = listSnapshots(agentId);
  const hasBackup = snapshots.length > 0;
  const lastBackupAt = snapshots[0]?.createdAt;

  if (agentId === 'claude') {
    const configPath = resolveHomeConfinedFile('.claude', 'settings.json');
    const { exists, content } = safeReadText(configPath);
    let managedBy: SwitchAgentDetection['managedBy'] = 'official-or-empty';
    let currentBaseUrl: string | undefined;
    const preservedItems: string[] = [];

    if (exists && content.trim()) {
      try {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        for (const k of Object.keys(parsed)) {
          if (k !== 'env') preservedItems.push(k);
        }
        const env = parsed.env as Record<string, unknown> | undefined;
        if (env && typeof env.ANTHROPIC_BASE_URL === 'string') {
          currentBaseUrl = env.ANTHROPIC_BASE_URL;
          managedBy =
            currentBaseUrl === gatewayBaseUrl ? 'codearts-switch' : 'cc-switch-or-custom';
        }
      } catch {
        managedBy = 'cc-switch-or-custom';
      }
    }

    return {
      agentId,
      configPath,
      configExists: exists,
      historyPath: path.join(home, '.claude', 'projects'),
      managedBy,
      currentBaseUrl,
      preservedItems,
      hasBackup,
      lastBackupAt,
      backupCount: snapshots.length,
    };
  }

  if (agentId === 'codex') {
    const configPath = resolveHomeConfinedFile('.codex', 'config.toml');
    const { exists, content } = safeReadText(configPath);
    let managedBy: SwitchAgentDetection['managedBy'] = 'official-or-empty';
    let currentBaseUrl: string | undefined;
    const preservedItems: string[] = [];

    if (exists && content.trim()) {
      const sectionMatches = content.match(/^\[([^\]]+)\]/gm) || [];
      for (const m of sectionMatches) {
        if (m !== '[model_providers.codearts]') {
          preservedItems.push(m);
        }
      }
      const baseMatch = /base_url\s*=\s*"([^"]+)"/.exec(content);
      if (baseMatch) currentBaseUrl = baseMatch[1];
      if (/model_provider\s*=\s*"codearts"/.test(content)) {
        managedBy = 'codearts-switch';
      } else if (/model_provider\s*=/.test(content)) {
        managedBy = 'cc-switch-or-custom';
      }
    }

    return {
      agentId,
      configPath,
      configExists: exists,
      historyPath: path.join(home, '.codex', 'sessions'),
      managedBy,
      currentBaseUrl,
      preservedItems,
      hasBackup,
      lastBackupAt,
      backupCount: snapshots.length,
    };
  }

  const configPath = resolveHomeConfinedFile('.dsh', 'settings.yaml');
  const { exists, content } = safeReadText(configPath);
  let managedBy: SwitchAgentDetection['managedBy'] = 'official-or-empty';
  let currentBaseUrl: string | undefined;
  const preservedItems: string[] = [];

  if (exists && content.trim()) {
    const baseMatch = /base-url:\s*(\S+)/.exec(content);
    if (baseMatch) currentBaseUrl = baseMatch[1];
    if (content.includes('codearts-switch managed start') || /default-model:\s*codearts\//.test(content)) {
      managedBy = 'codearts-switch';
    } else {
      managedBy = 'cc-switch-or-custom';
    }
    const keys = content.match(/^[a-zA-Z0-9_-]+(?=:)/gm) || [];
    for (const k of keys) {
      if (k !== 'default-model' && k !== 'agent-fallback-model' && k !== 'providers') {
        preservedItems.push(k);
      }
    }
  }

  return {
    agentId,
    configPath,
    configExists: exists,
    historyPath: path.join(home, '.dsh'),
    managedBy,
    currentBaseUrl,
    preservedItems,
    hasBackup,
    lastBackupAt,
    backupCount: snapshots.length,
  };
}

export function previewAgentSwitch(
  agentId: SwitchAgentId,
  profiles: SwitchProfilesState,
  gatewayBaseUrl: string,
  apiKey: string,
  models: AdminModel[]
): SwitchPreviewResponse {
  let claudeOverridePath: string | undefined;
  if (agentId === 'claude') {
    claudeOverridePath = resolveHomeConfinedFile('.codearts-switch', 'claude-override.json');
    const overrideJson = buildClaudeOverrideSettingsJson(profiles.claude, gatewayBaseUrl, apiKey);
    writeConfinedFileAtomic(claudeOverridePath, overrideJson, true);
  }
  const zeroIntrusion = buildZeroIntrusionLaunchers(
    agentId,
    profiles,
    gatewayBaseUrl,
    apiKey,
    claudeOverridePath
  );
  const files: SwitchFilePreview[] = [];

  if (agentId === 'claude') {
    const targetPath = resolveHomeConfinedFile('.claude', 'settings.json');
    const before = safeReadText(targetPath).content;
    const merged = mergeClaudeSettings(before, profiles.claude, gatewayBaseUrl, apiKey);
    files.push({
      id: 'claude-settings',
      label: 'settings.json',
      targetPath,
      beforeContent: before,
      afterContent: merged.content,
      diffLines: computeLineDiff(before, merged.content),
      preservedKeys: merged.preservedKeys,
      modifiedKeys: merged.modifiedKeys,
    });
  } else if (agentId === 'codex') {
    const cfgPath = resolveHomeConfinedFile('.codex', 'config.toml');
    const authPath = resolveHomeConfinedFile('.codex', 'auth.json');
    const beforeCfg = safeReadText(cfgPath).content;
    const beforeAuth = safeReadText(authPath).content;
    const mergedCfg = mergeCodexConfigToml(beforeCfg, profiles.codex, gatewayBaseUrl, apiKey);
    const mergedAuth = mergeCodexAuthJson(beforeAuth, apiKey);

    files.push(
      {
        id: 'codex-config',
        label: 'config.toml',
        targetPath: cfgPath,
        beforeContent: beforeCfg,
        afterContent: mergedCfg.content,
        diffLines: computeLineDiff(beforeCfg, mergedCfg.content),
        preservedKeys: mergedCfg.preservedKeys,
        modifiedKeys: mergedCfg.modifiedKeys,
      },
      {
        id: 'codex-auth',
        label: 'auth.json',
        targetPath: authPath,
        beforeContent: beforeAuth,
        afterContent: mergedAuth.content,
        diffLines: computeLineDiff(beforeAuth, mergedAuth.content),
        preservedKeys: mergedAuth.preservedKeys,
        modifiedKeys: mergedAuth.modifiedKeys,
      }
    );
  } else {
    const cfgPath = resolveHomeConfinedFile('.dsh', 'settings.yaml');
    const credsPath = resolveHomeConfinedFile('.dsh', '.credentials.yaml');
    const beforeCfg = safeReadText(cfgPath).content;
    const beforeCreds = safeReadText(credsPath).content;
    const mergedCfg = mergeDshSettingsYaml(beforeCfg, profiles.dsh, gatewayBaseUrl, models);
    const mergedCreds = mergeDshCredentialsYaml(beforeCreds, apiKey);

    files.push(
      {
        id: 'dsh-settings',
        label: 'settings.yaml',
        targetPath: cfgPath,
        beforeContent: beforeCfg,
        afterContent: mergedCfg.content,
        diffLines: computeLineDiff(beforeCfg, mergedCfg.content),
        preservedKeys: mergedCfg.preservedKeys,
        modifiedKeys: mergedCfg.modifiedKeys,
      },
      {
        id: 'dsh-credentials',
        label: '.credentials.yaml',
        targetPath: credsPath,
        beforeContent: beforeCreds,
        afterContent: mergedCreds.content,
        diffLines: computeLineDiff(beforeCreds, mergedCreds.content),
        preservedKeys: mergedCreds.preservedKeys,
        modifiedKeys: mergedCreds.modifiedKeys,
      }
    );
  }

  return {
    ok: true,
    agentId,
    gatewayBaseUrl,
    files,
    zeroIntrusion,
    ccSwitchProvider:
      agentId === 'codex'
        ? buildCodexCCSwitchSnippet(profiles.codex, gatewayBaseUrl, apiKey)
        : undefined,
  };
}

export function applyAgentSwitchMerge(
  agentId: SwitchAgentId,
  profiles: SwitchProfilesState,
  gatewayBaseUrl: string,
  apiKey: string,
  models: AdminModel[]
): SwitchApplyResponse {
  const preview = previewAgentSwitch(agentId, profiles, gatewayBaseUrl, apiKey, models);
  const targetPaths = preview.files.map((f) => f.targetPath);
  const { snapshot, snapshotPath } = saveSnapshot(agentId, targetPaths);

  const writtenFiles: string[] = [];
  for (const file of preview.files) {
    const sensitive =
      file.targetPath.endsWith('settings.json') ||
      file.targetPath.endsWith('config.toml') ||
      file.targetPath.endsWith('auth.json') ||
      file.targetPath.endsWith('.credentials.yaml');
    writeConfinedFileAtomic(file.targetPath, file.afterContent, sensitive);
    writtenFiles.push(file.targetPath);
  }

  const cliCommand = agentId === 'claude' ? 'claude' : agentId === 'codex' ? 'codex' : 'dsh web';
  return {
    ok: true,
    agentId,
    writtenFiles,
    snapshotId: snapshot.id,
    snapshotPath,
    cliCommand,
    message: `已无损合并写入 ${writtenFiles.length} 个配置文件（已自动留存快照，随时可一键还原）。现在可直接在终端运行 ${cliCommand}。`,
  };
}

export function restoreAgentSwitchBackup(agentId: SwitchAgentId): SwitchRestoreResponse {
  const snapshots = listSnapshots(agentId);
  if (snapshots.length === 0) {
    throw new Error('未找到该智能体的历史快照，无法还原');
  }
  const latest = snapshots[0];
  const restoredFiles: string[] = [];

  for (const f of latest.files) {
    // Re-validate confinement before restoring
    const home = path.resolve(os.homedir());
    const resolved = path.resolve(f.targetPath);
    if (!resolved.startsWith(home + path.sep)) {
      throw new Error('快照路径越界，已中止还原');
    }
    if (f.existed) {
      writeConfinedFileAtomic(resolved, f.content, true);
    } else if (fs.existsSync(resolved)) {
      fs.unlinkSync(resolved);
    }
    restoredFiles.push(resolved);
  }

  // Remove the consumed snapshot so repeated restores walk back cleanly
  try {
    fs.unlinkSync(path.join(getSnapshotsDir(), `${latest.id}.json`));
  } catch {
    // ignore
  }

  return {
    ok: true,
    agentId,
    restoredFiles,
    message: `已还原至接管前快照（${new Date(latest.createdAt).toLocaleString('zh-CN', { hour12: false })}），你原有的 hooks / MCP / CC Switch 配置已恢复。`,
  };
}
