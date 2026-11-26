import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_FALLBACK_MODELS,
  DEFAULT_SWITCH_PROFILES,
  buildClaudeOverrideSettingsJson,
  buildCodexCCSwitchSnippet,
  buildZeroIntrusionLaunchers,
  computeLineDiff,
  estimateMixedTokens,
  mergeClaudeSettings,
  mergeCodexAuthJson,
  mergeCodexConfigToml,
  mergeDshSettingsYaml,
} from './switcherEngine';

test('mergeClaudeSettings preserves hooks, permissions, plugins, and custom env vars while overriding model', () => {
  const existing = JSON.stringify(
    {
      model: 'deepseek-v4-flash',
      permissions: { allow: ['Bash(git status)'] },
      hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [] }] },
      enabledPlugins: { 'my-plugin': true },
      env: {
        CUSTOM_USER_FLAG: 'keep-me',
        ANTHROPIC_API_KEY: 'sk-old-ccswitch',
        ANTHROPIC_BASE_URL: 'https://old-ccswitch.example',
      },
    },
    null,
    2
  );

  const merged = mergeClaudeSettings(
    existing,
    DEFAULT_SWITCH_PROFILES.claude,
    'http://127.0.0.1:10087',
    'ca2a-secret-key'
  );

  const parsed = JSON.parse(merged.content);
  assert.deepEqual(parsed.permissions, { allow: ['Bash(git status)'] });
  assert.deepEqual(parsed.hooks, { PreToolUse: [{ matcher: 'Edit', hooks: [] }] });
  assert.deepEqual(parsed.enabledPlugins, { 'my-plugin': true });
  assert.equal(parsed.model, 'GLM-5.3');
  assert.equal(parsed.env.CUSTOM_USER_FLAG, 'keep-me');
  assert.equal(parsed.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(parsed.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:10087');
  assert.equal(parsed.env.ANTHROPIC_AUTH_TOKEN, 'ca2a-secret-key');
  assert.equal(parsed.env.ANTHROPIC_MODEL, 'GLM-5.3');
  assert.ok(merged.preservedKeys.includes('hooks'));
  assert.ok(merged.preservedKeys.includes('permissions'));
  assert.ok(merged.preservedKeys.includes('env.CUSTOM_USER_FLAG'));
});

test('mergeCodexConfigToml preserves mcp_servers, projects, and supports desktop-direct & env-key auth', () => {
  const existing = [
    'model_provider = "openai"',
    'model = "gpt-5"',
    'sandbox_mode = "workspace-write"',
    '',
    '[mcp_servers.filesystem]',
    'command = "npx"',
    'args = ["-y", "@modelcontextprotocol/server-filesystem"]',
    '',
    '[projects."/work/repo"]',
    'trust_level = "trusted"',
  ].join('\n');

  const mergedDesktop = mergeCodexConfigToml(
    existing,
    DEFAULT_SWITCH_PROFILES.codex,
    'http://127.0.0.1:10087',
    'ca2a-desktop-token'
  );

  assert.ok(mergedDesktop.content.includes('sandbox_mode = "workspace-write"'));
  assert.ok(mergedDesktop.content.includes('[mcp_servers.filesystem]'));
  assert.ok(mergedDesktop.content.includes('[projects."/work/repo"]'));
  assert.ok(mergedDesktop.content.includes('model_provider = "codearts"'));
  assert.ok(mergedDesktop.content.includes('[model_providers.codearts]'));
  assert.ok(mergedDesktop.content.includes('base_url = "http://127.0.0.1:10087/v1"'));
  assert.ok(mergedDesktop.content.includes('requires_openai_auth = false'));
  assert.ok(mergedDesktop.content.includes('http_headers = { "Authorization" = "Bearer ca2a-desktop-token" }'));
  assert.ok(!mergedDesktop.content.includes('env_key = "CODEARTS_API_KEY"'));
  assert.ok(mergedDesktop.preservedKeys.includes('[mcp_servers.filesystem]'));
  assert.ok(mergedDesktop.preservedKeys.includes('sandbox_mode'));

  const mergedEnvKey = mergeCodexConfigToml(
    existing,
    { ...DEFAULT_SWITCH_PROFILES.codex, authMode: 'env-key' },
    'http://127.0.0.1:10087',
    'ca2a-desktop-token'
  );
  assert.ok(mergedEnvKey.content.includes('env_key = "CODEARTS_API_KEY"'));
  assert.ok(!mergedEnvKey.content.includes('ca2a-desktop-token'));

  const ccSnippet = buildCodexCCSwitchSnippet(
    DEFAULT_SWITCH_PROFILES.codex,
    'http://127.0.0.1:10087',
    'ca2a-desktop-token'
  );
  assert.equal(ccSnippet.baseUrl, 'http://127.0.0.1:10087/v1');
  assert.equal(ccSnippet.apiKey, 'ca2a-desktop-token');
  assert.equal(ccSnippet.wireApi, 'responses');
  assert.ok(ccSnippet.tomlSnippet.includes('requires_openai_auth = false'));
});

test('mergeCodexAuthJson keeps existing OPENAI_API_KEY while updating CODEARTS_API_KEY', () => {
  const existing = JSON.stringify({ OPENAI_API_KEY: 'sk-existing' }, null, 2);
  const merged = mergeCodexAuthJson(existing, 'ca2a-new-token');
  const parsed = JSON.parse(merged.content);
  assert.equal(parsed.OPENAI_API_KEY, 'sk-existing');
  assert.equal(parsed.CODEARTS_API_KEY, 'ca2a-new-token');
  assert.deepEqual(merged.preservedKeys, ['OPENAI_API_KEY']);
});

test('mergeDshSettingsYaml preserves unrelated keys and replaces managed block idempotently', () => {
  const existing = 'custom-theme: dark\ndefault-model: openai/gpt-4o\n';
  const first = mergeDshSettingsYaml(
    existing,
    DEFAULT_SWITCH_PROFILES.dsh,
    'http://127.0.0.1:10087',
    BUILTIN_FALLBACK_MODELS
  );
  assert.ok(first.content.includes('custom-theme: dark'));
  assert.ok(first.content.includes('default-model: codearts/DeepSeek-V4.1-Flash'));

  const second = mergeDshSettingsYaml(
    first.content,
    { ...DEFAULT_SWITCH_PROFILES.dsh, model: 'GLM-5.3' },
    'http://127.0.0.1:10087',
    BUILTIN_FALLBACK_MODELS
  );
  assert.ok(second.content.includes('custom-theme: dark'));
  assert.ok(second.content.includes('default-model: codearts/GLM-5.3'));
  // Ensure no duplicate managed markers
  assert.equal(second.content.split('codearts-switch managed start').length, 2);
});

test('zero-intrusion launchers override CC Switch settings.json via --settings + --model and preserve /resume', () => {
  const overridePath = 'C:\\Users\\JaSon\\.codearts-switch\\claude-override.json';
  const overrideJson = JSON.parse(
    buildClaudeOverrideSettingsJson(
      DEFAULT_SWITCH_PROFILES.claude,
      'http://127.0.0.1:10087',
      'ca2a-key-1'
    )
  );
  assert.equal(overrideJson.model, 'GLM-5.3');
  assert.equal(overrideJson.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:10087');
  assert.equal(overrideJson.env.ANTHROPIC_AUTH_TOKEN, 'ca2a-key-1');
  assert.equal(overrideJson.env.ANTHROPIC_API_KEY, '');
  assert.equal(overrideJson.env.ANTHROPIC_MODEL, 'GLM-5.3');

  const claude = buildZeroIntrusionLaunchers(
    'claude',
    DEFAULT_SWITCH_PROFILES,
    'http://127.0.0.1:10087',
    'ca2a-key-1',
    overridePath
  );
  assert.equal(claude.overrideSettingsPath, overridePath);
  assert.equal(claude.cmd, `claude --settings "${overridePath}" --model "GLM-5.3"`);
  assert.equal(claude.powershell, `claude --settings '${overridePath}' --model 'GLM-5.3'`);
  assert.ok(!claude.powershell.includes('CLAUDE_CONFIG_DIR'));
  assert.ok(!claude.cmd.includes('$env:'));
  assert.ok(claude.cmdAliasSnippet.includes(`claude --settings "${overridePath}" --model "GLM-5.3" %*`));
  assert.ok(!claude.bash.includes('CLAUDE_CONFIG_DIR'));
  assert.equal(claude.aliasName, 'claude-md');

  const codex = buildZeroIntrusionLaunchers(
    'codex',
    DEFAULT_SWITCH_PROFILES,
    'http://127.0.0.1:10087',
    'ca2a-key%1'
  );
  assert.ok(codex.powershell.includes('model_provider="codearts"'));
  assert.ok(!codex.powershell.includes('CODEX_HOME'));
  assert.ok(codex.cmd.includes('set "CODEARTS_API_KEY=ca2a-key%%1"'));
  assert.ok(codex.cmd.includes('model_providers.codearts.base_url=http://127.0.0.1:10087/v1'));
  assert.ok(!codex.cmd.includes('$env:'));
  assert.ok(!codex.cmd.includes("'"));
  assert.ok(!codex.bash.includes('CODEX_HOME'));
  assert.equal(codex.aliasName, 'codex-md');

  const dsh = buildZeroIntrusionLaunchers(
    'dsh',
    DEFAULT_SWITCH_PROFILES,
    'http://127.0.0.1:10087',
    'ca2a-key-1'
  );
  assert.ok(dsh.cmd.includes('set "OPENAI_BASE_URL=http://127.0.0.1:10087/v1"'));
  assert.ok(dsh.cmdAliasSnippet.includes('dsh web --model'));
});

test('computeLineDiff marks additions and removals accurately', () => {
  const diff = computeLineDiff('a\nb\nc', 'a\nb2\nc\nd');
  assert.ok(diff.some((d) => d.type === 'remove' && d.line === 'b'));
  assert.ok(diff.some((d) => d.type === 'add' && d.line === 'b2'));
  assert.ok(diff.some((d) => d.type === 'add' && d.line === 'd'));
});

test('estimateMixedTokens distinguishes CJK vs ASCII density', () => {
  const ascii = estimateMixedTokens('hello world test'); // 16 chars -> 4 tokens
  const cjk = estimateMixedTokens('你好世界测试一下'); // 8 CJK chars -> 8 tokens
  assert.equal(ascii, 4);
  assert.equal(cjk, 8);
});
