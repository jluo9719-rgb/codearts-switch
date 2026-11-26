import type {
  AdminModel,
  ClaudeProfileConfig,
  CodexCCSwitchSnippet,
  CodexProfileConfig,
  DshProfileConfig,
  SwitchAgentId,
  SwitchDiffLine,
  SwitchProfilesState,
  ZeroIntrusionLaunchers,
} from '../types';

/**
 * Builtin fallback model catalog aligned with live Huawei Cloud CodeArts credit channel
 * (synced with CodeArts official model catalog & credit multipliers).
 */
export const BUILTIN_FALLBACK_MODELS: AdminModel[] = [
  {
    id: 'GLM-5.3',
    name: 'GLM-5.3',
    source: 'fallback',
    context_window: 202752,
    credit_multiplier: 0.79,
    supports_images: false,
    supports_tools: true,
    enable: true,
    description: '码道主力编程与智能体模型，综合代码生成与工具调用均衡。',
  },
  {
    id: 'GLM-5.3-Flash',
    name: 'GLM-5.3-Flash',
    source: 'fallback',
    context_window: 202752,
    credit_multiplier: 0.08,
    supports_images: false,
    supports_tools: true,
    enable: true,
    description: '超低倍率极速响应模型（0.08x），适合高频检索、Haiku 槽位与轻量任务。',
  },
  {
    id: 'Kimi-K3.1-Pro',
    name: 'Kimi-K3.1-Pro',
    source: 'fallback',
    context_window: 262144,
    credit_multiplier: 1.63,
    supports_images: false,
    supports_tools: true,
    enable: true,
    description: '【限时体验】为编程与智能体而生，深度与速度兼得（适合 Opus / 复杂架构任务）。',
  },
  {
    id: 'Kimi-K3',
    name: 'Kimi-K3',
    source: 'fallback',
    context_window: 262144,
    credit_multiplier: 2.38,
    supports_images: false,
    supports_tools: true,
    enable: true,
    description: '旗舰深度推理模型，适合大型疑难重构与复杂多步规划。',
  },
  {
    id: 'DeepSeek-V4.1-Flash',
    name: 'DeepSeek-V4.1-Flash',
    source: 'fallback',
    context_window: 131072,
    credit_multiplier: 0.18,
    supports_images: false,
    supports_tools: true,
    enable: true,
    description: '高性价比快速推理与编码模型（0.18x），日常开发与长对话首选。',
  },
  {
    id: 'DeepSeek-V4.1-Flash-1M',
    name: 'DeepSeek-V4.1-Flash-1M',
    source: 'fallback',
    context_window: 1048576,
    credit_multiplier: 0.18,
    supports_images: false,
    supports_tools: true,
    enable: true,
    description: '百万上下文长窗口版本（0.18x），适合大型代码仓库跨文件检索。',
  },
  {
    id: 'GLM-5.2',
    name: 'GLM-5.2',
    source: 'fallback',
    context_window: 202752,
    credit_multiplier: 0.7,
    supports_images: false,
    supports_tools: true,
    enable: true,
    description: '稳定版码道编程模型（0.7x），多文件工具调用成熟稳定。',
  },
  {
    id: 'GLM-5.2-ArkTS-SPARK',
    name: 'GLM-5.2-ArkTS-SPARK',
    source: 'fallback',
    context_window: 131072,
    credit_multiplier: 0.7,
    supports_images: false,
    supports_tools: true,
    enable: true,
    description: '针对 HarmonyOS / ArkTS 与华为云生态专项微调的编程模型（0.7x）。',
  },
  {
    id: 'OpenPangu-2.1-Pro',
    name: 'OpenPangu-2.1-Pro',
    source: 'fallback',
    context_window: 131072,
    credit_multiplier: 0.07,
    supports_images: false,
    supports_tools: true,
    enable: true,
    description: '极低消耗系数（0.07x）盘古开源专业版，适合常规问答与脚本生成。',
  },
];

export const DEFAULT_SWITCH_PROFILES: SwitchProfilesState = {
  claude: {
    primaryModel: 'GLM-5.3',
    sonnetModel: 'GLM-5.3',
    opusModel: 'Kimi-K3.1-Pro',
    haikuModel: 'GLM-5.3-Flash',
  },
  codex: {
    model: 'GLM-5.3',
    wireApi: 'responses',
    approvalPolicy: 'on-request',
    authMode: 'desktop-direct',
  },
  dsh: {
    model: 'DeepSeek-V4.1-Flash',
    fallbackModel: 'GLM-5.3-Flash',
    telemetryDisabled: true,
  },
};

export function sanitizeModelId(value: string, fallback = 'GLM-5.2'): string {
  const cleaned = value.trim().replace(/[^a-zA-Z0-9._:/-]/g, '');
  return cleaned || fallback;
}

export function sanitizeGatewayBaseUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'http://127.0.0.1:10087';
    }
    return parsed.origin;
  } catch {
    return 'http://127.0.0.1:10087';
  }
}

export function sanitizeApiKeyValue(key: string): string {
  return key.replace(/[\r\n"'`$\\]/g, '').trim();
}

function escapeSingleQuotedBash(val: string): string {
  return val.replace(/'/g, `'\\''`);
}

function escapeSingleQuotedPowerShell(val: string): string {
  return val.replace(/'/g, `''`);
}

function escapeCmdValue(val: string): string {
  return val.replace(/[\r\n"]/g, '').replace(/%/g, '%%');
}

export interface MergeResult {
  content: string;
  preservedKeys: string[];
  modifiedKeys: string[];
}

/**
 * Lossless deep-merge for ~/.claude/settings.json.
 * Strictly preserves hooks, permissions, enabledPlugins, statusLine, and non-CodeArts env vars.
 */
export function mergeClaudeSettings(
  existingRaw: string,
  config: ClaudeProfileConfig,
  gatewayBaseUrl: string,
  apiKey: string
): MergeResult {
  const origin = sanitizeGatewayBaseUrl(gatewayBaseUrl);
  const token = sanitizeApiKeyValue(apiKey);

  let root: Record<string, unknown> = {};
  if (existingRaw.trim()) {
    try {
      const parsed = JSON.parse(existingRaw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        root = { ...(parsed as Record<string, unknown>) };
      }
    } catch {
      // Keep empty base if corrupted; caller snapshots original raw text before writing
      root = {};
    }
  }

  const preservedKeys: string[] = [];
  for (const key of Object.keys(root)) {
    if (key !== 'env' && key !== 'model') {
      preservedKeys.push(key);
    }
  }

  const existingEnv =
    root.env && typeof root.env === 'object' && !Array.isArray(root.env)
      ? { ...(root.env as Record<string, unknown>) }
      : {};

  // Drop stale ANTHROPIC_API_KEY so Claude Code uses ANTHROPIC_AUTH_TOKEN cleanly without conflict
  delete existingEnv.ANTHROPIC_API_KEY;

  const primaryModel = sanitizeModelId(config.primaryModel, 'GLM-5.3');
  const managedEnv: Record<string, string> = {
    ANTHROPIC_BASE_URL: origin,
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_MODEL: primaryModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: sanitizeModelId(config.sonnetModel, 'GLM-5.3'),
    ANTHROPIC_DEFAULT_OPUS_MODEL: sanitizeModelId(config.opusModel, 'Kimi-K3.1-Pro'),
    ANTHROPIC_DEFAULT_HAIKU_MODEL: sanitizeModelId(config.haikuModel, 'GLM-5.3-Flash'),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };

  for (const envKey of Object.keys(existingEnv)) {
    if (!(envKey in managedEnv)) {
      preservedKeys.push(`env.${envKey}`);
    }
  }

  root.model = primaryModel;
  root.env = {
    ...existingEnv,
    ...managedEnv,
  };

  return {
    content: `${JSON.stringify(root, null, 2)}\n`,
    preservedKeys,
    modifiedKeys: ['model', ...Object.keys(managedEnv).map((k) => `env.${k}`)],
  };
}

/**
 * Generates an isolated Claude Code `--settings` JSON file placed outside ~/.claude/settings.json
 * (e.g. ~/.codearts-switch/claude-override.json). Because CLI `--settings` + `--model` take higher
 * precedence than `~/.claude/settings.json`, this reliably overrides CC Switch's `env` and `model`
 * fields without modifying `~/.claude/settings.json` or breaking shared `/resume` history.
 */
export function buildClaudeOverrideSettingsJson(
  config: ClaudeProfileConfig,
  gatewayBaseUrl: string,
  apiKey: string
): string {
  const origin = sanitizeGatewayBaseUrl(gatewayBaseUrl);
  const token = sanitizeApiKeyValue(apiKey) || '<YOUR_GATEWAY_API_KEY>';
  const primary = sanitizeModelId(config.primaryModel, 'GLM-5.3');
  const sonnet = sanitizeModelId(config.sonnetModel, 'GLM-5.3');
  const opus = sanitizeModelId(config.opusModel, 'Kimi-K3.1-Pro');
  const haiku = sanitizeModelId(config.haikuModel, 'GLM-5.3-Flash');

  const payload = {
    model: primary,
    env: {
      ANTHROPIC_BASE_URL: origin,
      ANTHROPIC_AUTH_TOKEN: token,
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_MODEL: primary,
      ANTHROPIC_DEFAULT_SONNET_MODEL: sonnet,
      ANTHROPIC_DEFAULT_OPUS_MODEL: opus,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: haiku,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/**
 * Lossless section-aware merge for ~/.codex/config.toml.
 * Preserves [mcp_servers.*], [projects.*], [profiles.*], and other [model_providers.*] blocks.
 * - desktop-direct (default): uses `requires_openai_auth = false` + `http_headers` Bearer token
 *   so Codex Desktop App, VS Code Extension, and CLI all work without OS environment variables
 *   and without overwriting OPENAI_API_KEY in auth.json.
 * - env-key: uses `env_key = "CODEARTS_API_KEY"` (no secret stored in config.toml).
 */
export function mergeCodexConfigToml(
  existingRaw: string,
  config: CodexProfileConfig,
  gatewayBaseUrl: string,
  apiKey = ''
): MergeResult {
  const origin = sanitizeGatewayBaseUrl(gatewayBaseUrl);
  const model = sanitizeModelId(config.model, 'GLM-5.3');
  const wireApi = config.wireApi === 'chat' ? 'chat' : 'responses';
  const approval = config.approvalPolicy || 'on-request';
  const authMode = config.authMode === 'env-key' ? 'env-key' : 'desktop-direct';
  const token = sanitizeApiKeyValue(apiKey) || '<YOUR_GATEWAY_API_KEY>';

  const lines = existingRaw ? existingRaw.replace(/\r\n/g, '\n').split('\n') : [];

  // Split into top-level lines (before first [section]) and named [section] blocks
  const topLines: string[] = [];
  const sections: Array<{ header: string; lines: string[] }> = [];
  let currentSection: { header: string; lines: string[] } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    const headerMatch = /^\[([^\]]+)\]\s*$/.exec(trimmed);
    if (headerMatch) {
      currentSection = { header: headerMatch[1].trim(), lines: [line] };
      sections.push(currentSection);
    } else if (currentSection) {
      currentSection.lines.push(line);
    } else {
      topLines.push(line);
    }
  }

  const managedTopKeys = new Set(['model_provider', 'model', 'approval_policy']);
  const preservedKeys: string[] = [];
  const keptTopLines: string[] = [];

  for (const line of topLines) {
    const trimmed = line.trim();
    const kv = /^([a-zA-Z0-9_-]+)\s*=/.exec(trimmed);
    if (kv && managedTopKeys.has(kv[1])) {
      continue;
    }
    if (kv) {
      preservedKeys.push(kv[1]);
    }
    keptTopLines.push(line);
  }

  // Trim trailing blank lines in keptTopLines
  while (keptTopLines.length > 0 && keptTopLines[keptTopLines.length - 1].trim() === '') {
    keptTopLines.pop();
  }

  const nextTopLines = [
    ...keptTopLines,
    ...(keptTopLines.length > 0 ? [''] : []),
    '# Managed by CodeArts Switch (preserves MCP / projects / other providers)',
    'model_provider = "codearts"',
    `model = "${model}"`,
    `approval_policy = "${approval}"`,
  ];

  const codeartsSectionLines =
    authMode === 'env-key'
      ? [
          '[model_providers.codearts]',
          'name = "CodeArts Switch"',
          `base_url = "${origin}/v1"`,
          'env_key = "CODEARTS_API_KEY"',
          `wire_api = "${wireApi}"`,
        ]
      : [
          '[model_providers.codearts]',
          'name = "CodeArts Switch"',
          `base_url = "${origin}/v1"`,
          `wire_api = "${wireApi}"`,
          'requires_openai_auth = false',
          `http_headers = { "Authorization" = "Bearer ${token}" }`,
        ];

  const keptSections: Array<{ header: string; lines: string[] }> = [];
  let replacedCodearts = false;

  for (const sec of sections) {
    if (sec.header === 'model_providers.codearts') {
      keptSections.push({ header: sec.header, lines: codeartsSectionLines });
      replacedCodearts = true;
    } else {
      preservedKeys.push(`[${sec.header}]`);
      // trim trailing empty lines inside section
      const cleaned = [...sec.lines];
      while (cleaned.length > 0 && cleaned[cleaned.length - 1].trim() === '') {
        cleaned.pop();
      }
      keptSections.push({ header: sec.header, lines: cleaned });
    }
  }

  if (!replacedCodearts) {
    keptSections.unshift({ header: 'model_providers.codearts', lines: codeartsSectionLines });
  }

  const outputBlocks = [
    nextTopLines.join('\n'),
    ...keptSections.map((s) => s.lines.join('\n')),
  ];

  return {
    content: `${outputBlocks.join('\n\n')}\n`,
    preservedKeys,
    modifiedKeys: [
      'model_provider',
      'model',
      'approval_policy',
      '[model_providers.codearts]',
    ],
  };
}

/**
 * Generates ready-to-paste parameters for adding CodeArts Switch as a custom provider
 * inside CC Switch -> Codex (ideal for Codex Desktop App & VS Code Extension users).
 */
export function buildCodexCCSwitchSnippet(
  config: CodexProfileConfig,
  gatewayBaseUrl: string,
  apiKey: string
): CodexCCSwitchSnippet {
  const origin = sanitizeGatewayBaseUrl(gatewayBaseUrl);
  const model = sanitizeModelId(config.model, 'GLM-5.3');
  const wireApi = config.wireApi === 'chat' ? 'chat' : 'responses';
  const token = sanitizeApiKeyValue(apiKey) || '<YOUR_GATEWAY_API_KEY>';
  const baseUrl = `${origin}/v1`;

  const tomlSnippet = [
    `model_provider = "codearts"`,
    `model = "${model}"`,
    ``,
    `[model_providers.codearts]`,
    `name = "码道 CodeArts"`,
    `base_url = "${baseUrl}"`,
    `wire_api = "${wireApi}"`,
    `requires_openai_auth = false`,
    `http_headers = { "Authorization" = "Bearer ${token}" }`,
  ].join('\n');

  return {
    name: '码道 CodeArts',
    baseUrl,
    apiKey: token,
    wireApi,
    model,
    tomlSnippet,
  };
}

/**
 * Lossless merge for ~/.codex/auth.json — adds/updates CODEARTS_API_KEY while preserving
 * OPENAI_API_KEY and other provider tokens.
 */
export function mergeCodexAuthJson(existingRaw: string, apiKey: string): MergeResult {
  const token = sanitizeApiKeyValue(apiKey);
  let root: Record<string, unknown> = {};
  if (existingRaw.trim()) {
    try {
      const parsed = JSON.parse(existingRaw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        root = { ...(parsed as Record<string, unknown>) };
      }
    } catch {
      root = {};
    }
  }

  const preservedKeys = Object.keys(root).filter((k) => k !== 'CODEARTS_API_KEY');
  root.CODEARTS_API_KEY = token;

  return {
    content: `${JSON.stringify(root, null, 2)}\n`,
    preservedKeys,
    modifiedKeys: ['CODEARTS_API_KEY'],
  };
}

/**
 * Lossless merge for ~/.dsh/settings.yaml — preserves unrelated top-level blocks and other providers
 * while upserting the `codearts` provider section cleanly.
 */
export function mergeDshSettingsYaml(
  existingRaw: string,
  config: DshProfileConfig,
  gatewayBaseUrl: string,
  models: AdminModel[]
): MergeResult {
  const origin = sanitizeGatewayBaseUrl(gatewayBaseUrl);
  const model = sanitizeModelId(config.model);
  const fallbackModel = sanitizeModelId(config.fallbackModel);
  const listed = (models.length > 0 ? models : BUILTIN_FALLBACK_MODELS).filter(
    (m) => m.source !== 'alias' && m.enable !== false
  );

  const modelLines = listed
    .map((m) => `        - id: ${sanitizeModelId(m.id)}`)
    .join('\n');

  const managedBlock = [
    '# >>> codearts-switch managed start >>>',
    `default-model: codearts/${model}`,
    `agent-fallback-model: codearts/${fallbackModel}`,
    'telemetry:',
    `  mode: ${config.telemetryDisabled ? 'DISABLED' : 'ENABLED'}`,
    'providers:',
    '  codearts:',
    '    type: openai-completions',
    `    base-url: ${origin}/v1`,
    '    api-key-ref: codearts',
    '    models:',
    modelLines,
    '# <<< codearts-switch managed end <<<',
  ].join('\n');

  const preservedKeys: string[] = [];
  if (!existingRaw.trim()) {
    return {
      content: `${managedBlock}\n`,
      preservedKeys,
      modifiedKeys: ['default-model', 'agent-fallback-model', 'providers.codearts'],
    };
  }

  const normalized = existingRaw.replace(/\r\n/g, '\n');
  const startMarker = '# >>> codearts-switch managed start >>>';
  const endMarker = '# <<< codearts-switch managed end <<<';
  const sIdx = normalized.indexOf(startMarker);
  const eIdx = normalized.indexOf(endMarker);

  if (sIdx !== -1 && eIdx !== -1 && eIdx > sIdx) {
    const before = normalized.slice(0, sIdx).trimEnd();
    const after = normalized.slice(eIdx + endMarker.length).trimStart();
    if (before) preservedKeys.push('existing-yaml-header');
    if (after) preservedKeys.push('existing-yaml-footer');
    const parts = [before, managedBlock, after].filter(Boolean);
    return {
      content: `${parts.join('\n\n')}\n`,
      preservedKeys,
      modifiedKeys: ['default-model', 'agent-fallback-model', 'providers.codearts'],
    };
  }

  // Strip only previous top-level default-model / agent-fallback-model lines if present
  const keptLines: string[] = [];
  for (const line of normalized.split('\n')) {
    if (/^(default-model|agent-fallback-model)\s*:/.test(line)) {
      continue;
    }
    const keyMatch = /^([a-zA-Z0-9_-]+)\s*:/.exec(line);
    if (keyMatch) {
      preservedKeys.push(keyMatch[1]);
    }
    keptLines.push(line);
  }
  const keptBody = keptLines.join('\n').trim();
  const content = keptBody ? `${keptBody}\n\n${managedBlock}\n` : `${managedBlock}\n`;

  return {
    content,
    preservedKeys,
    modifiedKeys: ['default-model', 'agent-fallback-model', 'providers.codearts'],
  };
}

export function mergeDshCredentialsYaml(existingRaw: string, apiKey: string): MergeResult {
  const token = sanitizeApiKeyValue(apiKey);
  const normalized = existingRaw.replace(/\r\n/g, '\n');
  const lines = normalized.trim() ? normalized.split('\n') : [];
  const preservedKeys: string[] = [];
  const keptLines: string[] = [];

  for (const line of lines) {
    if (/^\s*codearts\s*:/.test(line)) continue;
    const match = /^([a-zA-Z0-9_-]+)\s*:/.exec(line);
    if (match) preservedKeys.push(match[1]);
    keptLines.push(line);
  }

  keptLines.push(`codearts: "${token}"`);

  return {
    content: `${keptLines.join('\n')}\n`,
    preservedKeys,
    modifiedKeys: ['codearts'],
  };
}

/**
 * Simple, deterministic line-by-line LCS diff for config preview UI.
 */
export function computeLineDiff(before: string, after: string): SwitchDiffLine[] {
  const a = before ? before.replace(/\r\n/g, '\n').split('\n') : [];
  const b = after ? after.replace(/\r\n/g, '\n').split('\n') : [];

  // Guard against huge files by falling back to simple compare
  if (a.length * b.length > 250000) {
    return [
      ...a.map((line) => ({ type: 'remove' as const, line })),
      ...b.map((line) => ({ type: 'add' as const, line })),
    ];
  }

  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));

  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const diff: SwitchDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      diff.push({ type: 'same', line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      diff.push({ type: 'remove', line: a[i] });
      i++;
    } else {
      diff.push({ type: 'add', line: b[j] });
      j++;
    }
  }
  while (i < m) {
    diff.push({ type: 'remove', line: a[i++] });
  }
  while (j < n) {
    diff.push({ type: 'add', line: b[j++] });
  }

  return diff;
}

/**
 * Generates zero-intrusion launcher commands & shell alias functions that:
 * 1) NEVER touch ~/.claude/settings.json, ~/.codex/config.toml, or CC Switch state
 * 2) NEVER override CLAUDE_CONFIG_DIR or CODEX_HOME — preserving 100% bidirectional `/resume` history!
 */
export function buildZeroIntrusionLaunchers(
  agentId: SwitchAgentId,
  profiles: SwitchProfilesState,
  gatewayBaseUrl: string,
  apiKey: string,
  claudeOverrideSettingsPath?: string
): ZeroIntrusionLaunchers {
  const origin = sanitizeGatewayBaseUrl(gatewayBaseUrl);
  const key = sanitizeApiKeyValue(apiKey) || '<YOUR_GATEWAY_API_KEY>';
  const psKey = escapeSingleQuotedPowerShell(key);
  const shKey = escapeSingleQuotedBash(key);
  const cmdKey = escapeCmdValue(key);

  if (agentId === 'claude') {
    const c = profiles.claude;
    const primary = sanitizeModelId(c.primaryModel, 'GLM-5.3');
    const overridePath = (claudeOverrideSettingsPath || '~/.codearts-switch/claude-override.json').trim();
    const psPath = escapeSingleQuotedPowerShell(overridePath);
    const shPath = escapeSingleQuotedBash(overridePath);
    const cmdPath = escapeCmdValue(overridePath);

    // Claude Code v2.x applies ~/.claude/settings.json `env` ON TOP OF shell environment variables,
    // so bare `set ANTHROPIC_MODEL=... && claude` gets overwritten by CC Switch's settings.json.
    // Passing CLI `--settings <isolated-override-file> --model <primary>` sits at the top of Claude Code's
    // precedence stack, cleanly overriding CC Switch without touching ~/.claude/settings.json or /resume history.
    const powershell = `claude --settings '${psPath}' --model '${primary}'`;
    const cmd = `claude --settings "${cmdPath}" --model "${primary}"`;
    const bash = `claude --settings '${shPath}' --model '${primary}'`;

    const powershellAliasSnippet = [
      `function claude-md {`,
      `  claude --settings '${psPath}' --model '${primary}' @args`,
      `}`,
    ].join('\n');

    const cmdAliasSnippet = [
      `@echo off`,
      `claude --settings "${cmdPath}" --model "${primary}" %*`,
    ].join('\n');

    const bashAliasSnippet = [
      `claude-md() {`,
      `  claude --settings '${shPath}' --model '${primary}' "$@"`,
      `}`,
    ].join('\n');

    return {
      powershell,
      cmd,
      bash,
      aliasName: 'claude-md',
      powershellAliasSnippet,
      cmdAliasSnippet,
      bashAliasSnippet,
      overrideSettingsPath: overridePath,
      historySharedNote:
        '通过独立覆盖文件 + --settings / --model 命令行高优先级注入，彻底压过 CC Switch 写入 ~/.claude/settings.json 的 env 与 model，同时完全不改写 ~/.claude/settings.json，也不改变 CLAUDE_CONFIG_DIR，100% 双向共享 /resume 历史。',
    };
  }

  if (agentId === 'codex') {
    const cx = profiles.codex;
    const model = sanitizeModelId(cx.model, 'GLM-5.3');
    const wire = cx.wireApi === 'chat' ? 'chat' : 'responses';
    const approval = cx.approvalPolicy || 'on-request';
    const providerInline = `{name="CodeArts Switch",base_url="${origin}/v1",env_key="CODEARTS_API_KEY",wire_api="${wire}"}`;
    const cmdCodexArgs = `codex -c model_provider=codearts -c model=${model} -c approval_policy=${approval} -c model_providers.codearts.name=CodeArtsSwitch -c model_providers.codearts.base_url=${origin}/v1 -c model_providers.codearts.env_key=CODEARTS_API_KEY -c model_providers.codearts.wire_api=${wire}`;

    const powershell = [
      `$env:CODEARTS_API_KEY='${psKey}'`,
      `codex -c model_provider="codearts" -c model="${model}" -c approval_policy="${approval}" -c 'model_providers.codearts=${providerInline}'`,
    ].join('; ');

    const cmd = `set "CODEARTS_API_KEY=${cmdKey}" && ${cmdCodexArgs}`;

    const bash = `CODEARTS_API_KEY='${shKey}' codex -c model_provider="codearts" -c model="${model}" -c approval_policy="${approval}" -c 'model_providers.codearts=${providerInline}'`;

    const powershellAliasSnippet = [
      `function codex-md {`,
      `  $env:CODEARTS_API_KEY='${psKey}'`,
      `  codex -c model_provider="codearts" -c model="${model}" -c approval_policy="${approval}" -c 'model_providers.codearts=${providerInline}' @args`,
      `}`,
    ].join('\n');

    const cmdAliasSnippet = [
      `@echo off`,
      `setlocal`,
      `set "CODEARTS_API_KEY=${cmdKey}"`,
      `${cmdCodexArgs} %*`,
    ].join('\n');

    const bashAliasSnippet = [
      `codex-md() {`,
      `  CODEARTS_API_KEY='${shKey}' codex -c model_provider="codearts" -c model="${model}" -c approval_policy="${approval}" -c 'model_providers.codearts=${providerInline}' "$@"`,
      `}`,
    ].join('\n');

    return {
      powershell,
      cmd,
      bash,
      aliasName: 'codex-md',
      powershellAliasSnippet,
      cmdAliasSnippet,
      bashAliasSnippet,
      historySharedNote:
        '保持默认 ~/.codex（不隔离 CODEX_HOME），仅用 -c 命令行覆盖路由。与 CC Switch 零冲突且 100% 双向共享 codex resume 会话记录与 MCP 配置。',
    };
  }

  // DeepSeek Harness
  const d = profiles.dsh;
  const model = sanitizeModelId(d.model, 'DeepSeek-V4.1-Flash');
  const powershell = [
    `$env:OPENAI_BASE_URL='${origin}/v1'`,
    `$env:OPENAI_API_KEY='${psKey}'`,
    `dsh web --model '${model}'`,
  ].join('; ');
  const cmd = `set "OPENAI_BASE_URL=${origin}/v1" && set "OPENAI_API_KEY=${cmdKey}" && dsh web --model "${model}"`;
  const bash = `OPENAI_BASE_URL='${origin}/v1' OPENAI_API_KEY='${shKey}' dsh web --model '${model}'`;

  const powershellAliasSnippet = [
    `function dsh-md {`,
    `  $env:OPENAI_BASE_URL='${origin}/v1'`,
    `  $env:OPENAI_API_KEY='${psKey}'`,
    `  dsh web --model '${model}' @args`,
    `}`,
  ].join('\n');

  const cmdAliasSnippet = [
    `@echo off`,
    `setlocal`,
    `set "OPENAI_BASE_URL=${origin}/v1"`,
    `set "OPENAI_API_KEY=${cmdKey}"`,
    `dsh web --model "${model}" %*`,
  ].join('\n');

  const bashAliasSnippet = [
    `dsh-md() {`,
    `  OPENAI_BASE_URL='${origin}/v1' OPENAI_API_KEY='${shKey}' dsh web --model '${model}' "$@"`,
    `}`,
  ].join('\n');

  return {
    powershell,
    cmd,
    bash,
    aliasName: 'dsh-md',
    powershellAliasSnippet,
    cmdAliasSnippet,
    bashAliasSnippet,
    historySharedNote:
      '共享 ~/.dsh/ 原有会话历史，不覆盖你现有的其他提供商配置。',
  };
}

/**
 * CJK-aware token estimation for /v1/messages/count_tokens.
 * CJK characters count ~1 token each; ASCII/Latin counts ~1 token per 4 characters.
 */
export function estimateMixedTokens(text: string): number {
  if (!text) return 1;
  let cjkCount = 0;
  let otherCount = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) || 0;
    if (
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x3000 && cp <= 0x303f) ||
      (cp >= 0xff00 && cp <= 0xffef)
    ) {
      cjkCount++;
    } else {
      otherCount++;
    }
  }
  return Math.max(1, cjkCount + Math.ceil(otherCount / 4));
}
