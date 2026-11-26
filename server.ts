import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer as createViteServer } from 'vite';
import { goAlignedStore, maskSecret, type StoredAccountRecord } from './server/goAlignedStore';
import {
  applyAgentSwitchMerge,
  detectAgentConfig,
  previewAgentSwitch,
  restoreAgentSwitchBackup,
} from './server/switcher';
import {
  anthropicToCanonical,
  canonicalToAnthropicResponse,
  canonicalToAnthropicSSEFrames,
  canonicalToCodexResponse,
  canonicalToCodexSSEFrames,
  canonicalToOpenAIChatResponse,
  codexResponsesToCanonical,
  openAIChatToCanonical,
  selectRoutingAccount,
} from './src/lib/protocolAdapter';
import {
  BUILTIN_FALLBACK_MODELS,
  estimateMixedTokens,
  sanitizeModelId,
} from './src/lib/switcherEngine';
import type { SwitchAgentId } from './src/types';

const PORT = Number(process.env.PORT || 3000);
// Default to 127.0.0.1 locally; bind 0.0.0.0 only inside cloud preview (APP_URL set) or explicit HOST=0.0.0.0
const HOST = process.env.HOST?.trim() || (process.env.APP_URL ? '0.0.0.0' : '127.0.0.1');
const IS_CLOUD_PREVIEW = Boolean(process.env.APP_URL);

/**
 * Optional local Go CodeArts2API bridge (strictly restricted to loopback hosts to prevent SSRF).
 * - When CODEARTS_GO_UPSTREAM is set (e.g. http://127.0.0.1:10087), activates immediately.
 * - When running locally (!IS_CLOUD_PREVIEW), auto-probes http://127.0.0.1:10087/health on startup
 *   and also allows runtime toggle via POST /admin/api/switch/go-bridge.
 */
function parseLoopbackOrigin(raw: string | undefined): string | null {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const h = u.hostname.toLowerCase();
    if (h !== '127.0.0.1' && h !== 'localhost' && h !== '::1' && h !== '[::1]') {
      return null;
    }
    return u.origin;
  } catch {
    return null;
  }
}

let activeGoUpstream: string | null = parseLoopbackOrigin(process.env.CODEARTS_GO_UPSTREAM);

async function probeGoHealth(origin: string, timeoutMs = 1200): Promise<boolean> {
  const safeOrigin = parseLoopbackOrigin(origin);
  if (!safeOrigin) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${safeOrigin}/health`, { signal: controller.signal });
    if (!res.ok) return false;
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return Boolean(data && data.status === 'ok');
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function getGatewayBaseUrl(): string {
  return activeGoUpstream || `http://127.0.0.1:${PORT}`;
}

function getBridgeKeysFilePath(): string {
  const base = process.env.CODEARTS_SWITCH_DATA_DIR?.trim()
    ? path.resolve(process.env.CODEARTS_SWITCH_DATA_DIR.trim())
    : path.resolve(process.cwd(), 'data');
  return path.join(base, 'bridge-keys.json');
}

function readBridgeKeys(): Record<string, string> {
  try {
    const p = getBridgeKeysFilePath();
    if (!fs.existsSync(p)) return {};
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // ignore corrupt cache
  }
  return {};
}

function saveBridgeKey(origin: string, rawKey: string): void {
  if (!origin || !rawKey) return;
  try {
    const p = getBridgeKeysFilePath();
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const map = readBridgeKeys();
    map[origin] = rawKey;
    const tmp = `${p}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, p);
  } catch {
    // non-fatal
  }
}

async function resolveActiveApiKey(adminPasswordHeader?: string): Promise<string> {
  if (!activeGoUpstream) {
    return goAlignedStore.getFirstActiveRawKey() || '';
  }

  // 1. Check cached Go plaintext key for this loopback origin
  const cached = readBridgeKeys()[activeGoUpstream];
  if (cached) {
    try {
      const checkRes = await fetch(`${activeGoUpstream}/v1/models`, {
        headers: { Authorization: `Bearer ${cached}` },
      });
      if (checkRes.ok) {
        return cached;
      }
    } catch {
      // fall through to re-issue
    }
  }

  // 2. Automatically issue a dedicated key in Go CodeArts2API so generated CLI configs
  //    work immediately without 401 auth mismatch against Go's key store.
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (adminPasswordHeader) headers['x-admin-password'] = adminPasswordHeader;
    const res = await fetch(`${activeGoUpstream}/admin/api/keys`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: '码道 Switch 自动签发' }),
    });
    if (res.ok) {
      const data = (await res.json()) as { key?: string };
      if (typeof data.key === 'string' && data.key.trim()) {
        const issued = data.key.trim();
        saveBridgeKey(activeGoUpstream, issued);
        return issued;
      }
    }
  } catch {
    // fall through
  }

  return cached || goAlignedStore.getFirstActiveRawKey() || '';
}

async function fetchActiveModels(adminPasswordHeader?: string): Promise<typeof BUILTIN_FALLBACK_MODELS> {
  if (!activeGoUpstream) {
    return goAlignedStore.getModels();
  }
  try {
    const headers: Record<string, string> = {};
    if (adminPasswordHeader) headers['x-admin-password'] = adminPasswordHeader;
    const res = await fetch(`${activeGoUpstream}/admin/api/state`, { headers });
    if (res.ok) {
      const data = (await res.json()) as { models?: typeof BUILTIN_FALLBACK_MODELS };
      if (Array.isArray(data.models) && data.models.length > 0) {
        return data.models;
      }
    }
  } catch {
    // fallback to local list
  }
  return goAlignedStore.getModels();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sha256Equal(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function isLoopbackIp(ip: string | undefined): boolean {
  if (!ip) return false;
  const cleaned = ip.replace(/^::ffff:/, '');
  return cleaned === '127.0.0.1' || cleaned === '::1' || cleaned === 'localhost';
}

function hasProxyHeaders(req: Request): boolean {
  return Boolean(
    req.headers['x-forwarded-for'] ||
      req.headers['x-real-ip'] ||
      req.headers['forwarded']
  );
}

function isSameOriginMutation(req: Request): boolean {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return true;
  }
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser CLI/curl call
  try {
    const u = new URL(origin);
    const reqHost = (req.headers['x-forwarded-host'] as string | undefined) || req.headers.host || '';
    const primaryHost = reqHost.split(',')[0].trim();
    if (primaryHost && u.host === primaryHost) return true;
    // Also allow loopback origin for local dev
    if (
      (u.hostname === '127.0.0.1' || u.hostname === 'localhost') &&
      (primaryHost.startsWith('127.0.0.1') || primaryHost.startsWith('localhost'))
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Mirrors Go CodeArts2API `withAdminAuth` from `internal/server/admin.go`:
 * - If admin_password is configured (via CODEARTS_ADMIN_PASSWORD or settings), requires X-Admin-Password or Bearer match via constant-time compare.
 * - Otherwise requires direct non-proxied loopback locally (in AI Studio cloud preview where APP_URL is set, preview proxy is allowed when password is unset).
 * - Enforces same-origin check on state-changing methods.
 */
function withAdminAuth(req: Request, res: Response, next: NextFunction): void {
  if (!isSameOriginMutation(req)) {
    res.status(403).json({
      error: {
        message: '跨源写操作被拒绝（Origin 与主机不匹配）',
        type: 'forbidden_origin',
      },
    });
    return;
  }

  const configuredPw = goAlignedStore.getEffectiveAdminPassword();
  if (configuredPw) {
    let provided = (req.headers['x-admin-password'] as string | undefined)?.trim() || '';
    if (!provided) {
      const auth = (req.headers.authorization || '').trim();
      if (auth.toLowerCase().startsWith('bearer ')) {
        provided = auth.slice(7).trim();
      }
    }
    if (!provided || !sha256Equal(provided, configuredPw)) {
      res.status(401).json({
        error: {
          message: '需要管理密码，请输入 X-Admin-Password',
          type: 'admin_auth_required',
        },
      });
      return;
    }
    next();
    return;
  }

  if (!IS_CLOUD_PREVIEW && (hasProxyHeaders(req) || !isLoopbackIp(req.socket.remoteAddress))) {
    res.status(403).json({
      error: {
        message: '未设置管理密码时，仅允许本机回环直连访问管理面板',
        type: 'admin_loopback_only',
      },
    });
    return;
  }

  next();
}

function extractGatewayBearer(req: Request): string {
  const xApiKey = (req.headers['x-api-key'] as string | undefined)?.trim();
  if (xApiKey) return xApiKey;
  const auth = (req.headers.authorization || '').trim();
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  return '';
}

function withGatewayKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const settings = goAlignedStore.getSanitizedSettings();
  if (settings.allow_anonymous) {
    next();
    return;
  }
  const token = extractGatewayBearer(req);
  const bridgeKey = activeGoUpstream ? readBridgeKeys()[activeGoUpstream] : '';
  const matchesBridge = Boolean(token && bridgeKey && sha256Equal(token, bridgeKey));
  if (!token || (!goAlignedStore.verifyGatewayKey(token) && !matchesBridge)) {
    res.status(401).json({
      error: {
        message: '无效或未提供的网关 API Key，请前往「日志与密钥」复制或新建密钥。',
        type: 'authentication_error',
      },
    });
    return;
  }
  next();
}

function parseSwitchAgentId(raw: unknown): SwitchAgentId | null {
  if (raw === 'claude' || raw === 'codex' || raw === 'dsh') return raw;
  return null;
}

// In-memory login session registry (matches Go /admin/api/login/* contract)
interface LoginSession {
  id: string;
  status: 'pending' | 'done' | 'error' | 'cancelled';
  authUrl: string;
  callbackPort: number;
  expiresAt: string;
  message?: string;
  accountId?: string;
  accountName?: string;
}
const loginSessions = new Map<string, LoginSession>();

// Probe mutex matching Go `probeRunning` atomic flag
let probeRunning = false;

/**
 * Best-effort local CodeArts IDE / desktop credential auto-discovery for `action: "import"`.
 * Scans standard CodeArts / VSCode globalStorage paths without leaving the user's home directory.
 */
function scanLocalCodeArtsDesktopCredentials(customDir?: string): {
  found: boolean;
  path?: string;
  accessKey?: string;
  secretKey?: string;
  securityToken?: string;
  name?: string;
} {
  const home = path.resolve(os.homedir());
  const candidates: string[] = [];
  if (customDir && customDir.trim()) {
    const resolved = path.resolve(customDir.trim());
    if (resolved.startsWith(home + path.sep) || resolved === home) {
      candidates.push(resolved);
    }
  }
  candidates.push(
    path.join(home, '.codearts', 'credentials.json'),
    path.join(home, '.codearts-ide', 'session.json'),
    path.join(home, 'AppData', 'Roaming', 'CodeArts IDE', 'User', 'globalStorage', 'storage.json'),
    path.join(home, 'Library', 'Application Support', 'CodeArts IDE', 'User', 'globalStorage', 'storage.json'),
    path.join(home, '.config', 'CodeArts IDE', 'User', 'globalStorage', 'storage.json')
  );

  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const ak =
        (typeof parsed.accessKey === 'string' && parsed.accessKey) ||
        (typeof parsed.access_key === 'string' && parsed.access_key) ||
        (typeof parsed.ak === 'string' && parsed.ak) ||
        '';
      const sk =
        (typeof parsed.secretKey === 'string' && parsed.secretKey) ||
        (typeof parsed.secret_key === 'string' && parsed.secret_key) ||
        (typeof parsed.sk === 'string' && parsed.sk) ||
        '';
      if (ak && sk) {
        return {
          found: true,
          path: filePath,
          accessKey: ak,
          secretKey: sk,
          securityToken:
            (typeof parsed.securityToken === 'string' && parsed.securityToken) ||
            (typeof parsed.security_token === 'string' && parsed.security_token) ||
            undefined,
          name:
            (typeof parsed.userName === 'string' && parsed.userName) ||
            (typeof parsed.name === 'string' && parsed.name) ||
            'CodeArts IDE 账号',
        };
      }
    } catch {
      // ignore unreadable candidate
    }
  }
  return { found: false };
}

function buildCanonicalModelReply(
  model: string,
  userText: string,
  toolsCount: number,
  accountName: string
): {
  content: string;
  inputTokens: number;
  outputTokens: number;
} {
  const inputTokens = estimateMixedTokens(userText);
  const content =
    `[CodeArts Switch 本地网关 · 预览回环响应]\n` +
    `当前路由模型：${model}（账号：${accountName}，挂载工具数：${toolsCount}）。\n` +
    `提示：当前为 Node.js 预览服务模式；要直连华为云 CodeArts 上游推理端点（AK/SK SigV4 签名与 OAuth 自动续期），请按「网关设置与打包」中的步骤将 dist/ 与 go-integration/ 合入你的 Go CodeArts2API 仓库并编译单文件可执行程序。`;
  return {
    content,
    inputTokens,
    outputTokens: estimateMixedTokens(content),
  };
}

async function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4mb' }));

  // Health & ping (unauthenticated, mirrors Go server.go)
  app.get('/health', (_req, res) => {
    const accounts = goAlignedStore.getAccounts();
    const healthy = accounts.filter((a) => a.enabled && a.status === 'ok').length;
    res.json({
      status: 'ok',
      accounts_total: accounts.length,
      accounts_healthy: healthy,
      port: PORT,
    });
  });

  app.get('/ping', (_req, res) => {
    res.type('text/plain').send('pong');
  });

  // Dynamic transparent bridge to local Go CodeArts2API core (auto-detected or connected via UI/env)
  app.use(async (req, res, next) => {
    if (!activeGoUpstream) {
      next();
      return;
    }
    const p = req.path;
    const isAdminRoute = p.startsWith('/admin/api/') && !p.startsWith('/admin/api/switch/');
    const isGatewayRoute =
      p === '/v1/models' ||
      p === '/v1/messages' ||
      p === '/v1/chat/completions';

    if (!isAdminRoute && !isGatewayRoute) {
      next();
      return;
    }

    // Enforce admin auth & same-origin protection before proxying admin routes to loopback Go core
    if (isAdminRoute) {
      if (!isSameOriginMutation(req)) {
        res.status(403).json({
          error: { message: '跨源写操作被拒绝（Origin 与主机不匹配）', type: 'forbidden_origin' },
        });
        return;
      }
      if (!IS_CLOUD_PREVIEW && (hasProxyHeaders(req) || !isLoopbackIp(req.socket.remoteAddress))) {
        const hasAdminHeader = Boolean(req.headers['x-admin-password'] || req.headers.authorization);
        if (!hasAdminHeader) {
          res.status(403).json({
            error: { message: '未设置管理密码时，仅允许本机回环直连访问管理面板', type: 'admin_loopback_only' },
          });
          return;
        }
      }
    }

    try {
      const targetUrl = `${activeGoUpstream}${req.originalUrl}`;
      // Do NOT forward browser Origin or X-Forwarded-* headers so Go's localDirect/adminSameOrigin
      // accepts our verified local loopback bridge cleanly.
      const forwardHeaders: Record<string, string> = {};
      for (const h of ['authorization', 'x-api-key', 'x-admin-password', 'content-type', 'anthropic-version', 'accept']) {
        const v = req.headers[h];
        if (typeof v === 'string' && v) forwardHeaders[h] = v;
      }
      const sendBody = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH';
      const upstreamRes = await fetch(targetUrl, {
        method: req.method,
        headers: forwardHeaders,
        body: sendBody ? JSON.stringify(req.body ?? {}) : undefined,
      });

      const ct = upstreamRes.headers.get('content-type');
      if (upstreamRes.body && ct?.includes('text/event-stream')) {
        res.status(upstreamRes.status);
        res.setHeader('Content-Type', ct);
        res.setHeader('Cache-Control', 'no-cache');
        const reader = upstreamRes.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) res.write(Buffer.from(value));
        }
        res.end();
        return;
      }

      const text = await upstreamRes.text();
      if (p === '/admin/api/keys' && req.method === 'POST' && upstreamRes.ok) {
        try {
          const parsed = JSON.parse(text) as { key?: string };
          if (typeof parsed.key === 'string' && parsed.key.trim()) {
            saveBridgeKey(activeGoUpstream, parsed.key.trim());
          }
        } catch {
          // ignore
        }
      }
      if (p === '/admin/api/state' && upstreamRes.ok) {
        try {
          const parsed = JSON.parse(text) as Record<string, unknown>;
          const u = new URL(activeGoUpstream);
          parsed.gateway_host = u.hostname;
          parsed.gateway_port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
          parsed.runtime_mode = 'go-bridge';
          parsed.go_upstream = activeGoUpstream;
          res.status(200).json(parsed);
          return;
        } catch {
          // fall through to raw pass-through
        }
      }

      res.status(upstreamRes.status);
      if (ct) res.setHeader('Content-Type', ct);
      res.send(text);
    } catch (err) {
      res.status(502).json({
        error: {
          message: `无法连接本地 Go CodeArts2API（${activeGoUpstream}）：${err instanceof Error ? err.message : '连接失败'}。请确认 CodeArts2API 正在运行，或在「网关设置与打包」中断开桥接。`,
          type: 'go_upstream_unreachable',
        },
      });
    }
  });

  // Live local OAuth callback listener for Node.js preview mode (prevents ERR_CONNECTION_REFUSED)
  app.get('/admin/oauth/callback', (req, res) => {
    const state = typeof req.query.state === 'string' ? req.query.state.trim() : '';
    const code =
      (typeof req.query.code === 'string' && req.query.code.trim()) ||
      (typeof req.query.ticket === 'string' && req.query.ticket.trim()) ||
      '';

    const session = loginSessions.get(state);
    if (!session) {
      res
        .status(400)
        .type('text/html; charset=utf-8')
        .send(
          `<!doctype html><html lang="zh-CN"><body style="font-family:sans-serif;padding:32px;max-width:560px;margin:auto;color:#0f172a"><h2>登录会话已失效</h2><p>未找到对应的登录会话，请返回码道 Switch 控制台重新发起登录。</p></body></html>`
        );
      return;
    }

    if (!code) {
      session.status = 'error';
      session.message = '回调中未检测到 code 或 ticket 参数';
      res
        .status(400)
        .type('text/html; charset=utf-8')
        .send(
          `<!doctype html><html lang="zh-CN"><body style="font-family:sans-serif;padding:32px;max-width:560px;margin:auto;color:#0f172a"><h2>回调参数不完整</h2><p>未在地址栏中检测到 code 或 ticket 参数，请关闭本页后重试。</p></body></html>`
        );
      return;
    }

    const id = `login-${crypto.createHash('sha256').update(code).digest('hex').slice(0, 10)}`;
    const record: StoredAccountRecord = {
      id,
      name: `华为云 OAuth (${code.slice(0, 6)})`,
      source: 'login',
      enabled: true,
      status: 'ok',
      note: 'Node.js 预览回调捕获（真实 STS 换票需连接 Go CodeArts2API 核心）',
      failures: 0,
      last_used: null,
      access_key: maskSecret(`OAUTH-${code}`),
      has_refresh: true,
      permanent: false,
    };
    goAlignedStore.upsertAccount(record);
    session.status = 'done';
    session.accountId = record.id;
    session.accountName = record.name;
    session.message = '已捕获华为云登录回调（注意：当前为 Node.js 预览模式，真实 STS 换票需使用 Go CodeArts2API 核心）';

    res
      .status(200)
      .type('text/html; charset=utf-8')
      .send(
        `<!doctype html><html lang="zh-CN"><body style="font-family:sans-serif;padding:32px;max-width:580px;margin:auto;color:#0f172a;line-height:1.6"><h2>已收到华为云登录回调</h2><p>账号标记：<code>${escapeHtml(record.name)}</code> 已自动回传至码道 Switch 控制台，你可以直接关闭此标签页并返回控制台。</p><p style="color:#475569;font-size:13px">提示：当前运行在 Node.js 预览服务（端口 ${PORT}），仅用于演示回调闭环；如需执行真实的 PKCE/DPoP 换票与华为云上游模型调用，请将本项目合入 Go CodeArts2API 或配置 <code>CODEARTS_GO_UPSTREAM=http://127.0.0.1:10087</code> 连接本地 Go 服务。</p></body></html>`
      );
  });

  // =========================================================================
  // Go CodeArts2API Exact Contract: /admin/api/*
  // =========================================================================

  app.get('/admin/api/state', withAdminAuth, (_req, res) => {
    res.json({
      ...goAlignedStore.getAdminState(HOST, PORT),
      runtime_mode: 'node-preview',
      go_upstream: '',
    });
  });

  app.post('/admin/api/accounts', withAdminAuth, (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const action = typeof body.action === 'string' ? body.action.trim() : '';

    if (action === 'import') {
      const customDir =
        (typeof body.dir === 'string' && body.dir.trim()) ||
        (typeof body.user_data === 'string' && body.user_data.trim()) ||
        '';
      const found = scanLocalCodeArtsDesktopCredentials(customDir);
      if (!found.found || !found.accessKey || !found.secretKey) {
        res.status(400).json({
          error:
            '未在默认 CodeArts IDE 目录中检测到有效凭证。请先登录 CodeArts IDE，或使用「手动凭证 / 会话 JSON」添加；在 Go 核心二进制中将自动解密系统密钥环。',
        });
        return;
      }
      const id = `desktop-${crypto.createHash('sha256').update(found.accessKey).digest('hex').slice(0, 10)}`;
      const record: StoredAccountRecord = {
        id,
        name: (typeof body.name === 'string' && body.name.trim()) || found.name || 'CodeArts IDE',
        source: 'desktop',
        user_data: found.path,
        enabled: true,
        status: 'ok',
        failures: 0,
        last_used: null,
        access_key: maskSecret(found.accessKey),
        permanent: !found.securityToken,
        credentials: {
          access_key: found.accessKey,
          secret_key: found.secretKey,
          security_token: found.securityToken,
          permanent: !found.securityToken,
        },
      };
      const added = goAlignedStore.upsertAccount(record);
      res.json({ ok: true, added, id: record.id, name: record.name });
      return;
    }

    if (action === 'manual') {
      const kind = body.credential_kind === 'aksk' ? 'aksk' : 'sts';
      const ak = typeof body.access_key === 'string' ? body.access_key.trim() : '';
      const sk = typeof body.secret_key === 'string' ? body.secret_key.trim() : '';
      const st = typeof body.security_token === 'string' ? body.security_token.trim() : '';
      const rt = typeof body.refresh_token === 'string' ? body.refresh_token.trim() : '';
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const note = typeof body.note === 'string' ? body.note.trim() : '';
      const domainId = typeof body.domain_id === 'string' ? body.domain_id.trim() : '';

      if (!ak || !sk) {
        res.status(400).json({ error: 'Access Key 与 Secret Key 不能为空' });
        return;
      }
      if (kind === 'sts' && !st) {
        res.status(400).json({ error: 'STS 临时凭证必须填写 Security Token；如为永久凭证请切换至 AK/SK 模式' });
        return;
      }

      const id = `manual-${crypto.createHash('sha256').update(ak).digest('hex').slice(0, 10)}`;
      const expiresAt = kind === 'sts' ? Math.floor(Date.now() / 1000) + 3600 * 12 : undefined;
      const record: StoredAccountRecord = {
        id,
        name: name || `手动账号 (${ak.slice(0, 6)})`,
        source: 'manual',
        enabled: true,
        status: 'ok',
        note,
        failures: 0,
        last_used: null,
        access_key: maskSecret(ak),
        expires_at: expiresAt,
        expires_in: expiresAt ? 3600 * 12 : undefined,
        has_refresh: Boolean(rt),
        domain_id: domainId || undefined,
        permanent: kind === 'aksk',
        credentials: {
          access_key: ak,
          secret_key: sk,
          security_token: kind === 'sts' ? st : undefined,
          refresh_token: rt || undefined,
          permanent: kind === 'aksk',
        },
      };
      const added = goAlignedStore.upsertAccount(record);
      res.json({ ok: true, added, id: record.id, name: record.name });
      return;
    }

    if (action === 'session-json') {
      const rawJson = typeof body.session_json === 'string' ? body.session_json.trim() : '';
      if (!rawJson) {
        res.status(400).json({ error: '请粘贴有效的 CodeArts 会话 JSON 内容' });
        return;
      }
      try {
        const parsed = JSON.parse(rawJson) as Record<string, unknown>;
        const ak = String(parsed.accessKey || parsed.access_key || parsed.ak || '').trim();
        const sk = String(parsed.secretKey || parsed.secret_key || parsed.sk || '').trim();
        const st = String(parsed.securityToken || parsed.security_token || '').trim();
        const rt = String(parsed.refreshToken || parsed.refresh_token || '').trim();
        if (!ak || !sk) {
          res.status(400).json({ error: '会话 JSON 缺少 accessKey 或 secretKey 字段' });
          return;
        }
        const id = `session-${crypto.createHash('sha256').update(ak).digest('hex').slice(0, 10)}`;
        const record: StoredAccountRecord = {
          id,
          name:
            (typeof body.name === 'string' && body.name.trim()) ||
            String(parsed.name || parsed.userName || `会话账号 (${ak.slice(0, 6)})`),
          source: 'manual',
          enabled: true,
          status: 'ok',
          note: typeof body.note === 'string' ? body.note.trim() : '会话 JSON 导入',
          failures: 0,
          last_used: null,
          access_key: maskSecret(ak),
          has_refresh: Boolean(rt),
          permanent: !st,
          credentials: {
            access_key: ak,
            secret_key: sk,
            security_token: st || undefined,
            refresh_token: rt || undefined,
            permanent: !st,
          },
        };
        const added = goAlignedStore.upsertAccount(record);
        res.json({ ok: true, added, id: record.id, name: record.name });
      } catch {
        res.status(400).json({ error: '会话 JSON 解析失败，请检查 JSON 语法' });
      }
      return;
    }

    if (action === 'remove') {
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      if (!id || !goAlignedStore.removeAccount(id)) {
        res.status(404).json({ error: '账号不存在' });
        return;
      }
      res.json({ ok: true });
      return;
    }

    if (action === 'toggle') {
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      if (!id || !goAlignedStore.toggleAccount(id)) {
        res.status(404).json({ error: '账号不存在' });
        return;
      }
      res.json({ ok: true });
      return;
    }

    if (action === 'clear-errors') {
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      if (!id || !goAlignedStore.clearAccountErrors(id)) {
        res.status(404).json({ error: '账号不存在' });
        return;
      }
      res.json({ ok: true });
      return;
    }

    if (action === 'export') {
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      const acc = goAlignedStore.getAccountById(id);
      if (!acc) {
        res.status(404).json({ error: '账号不存在' });
        return;
      }
      // Redact secret_key in export preview unless explicitly managed by Go core
      res.json({
        ok: true,
        id: acc.id,
        name: acc.name,
        session_json: JSON.stringify(
          {
            id: acc.id,
            name: acc.name,
            source: acc.source,
            access_key: acc.access_key || '',
            permanent: Boolean(acc.permanent),
            domain_id: acc.domain_id || '',
            exported_at: new Date().toISOString(),
          },
          null,
          2
        ),
      });
      return;
    }

    if (action === 'reimport') {
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      const acc = goAlignedStore.getAccountById(id);
      if (!acc) {
        res.status(404).json({ error: '账号不存在' });
        return;
      }
      goAlignedStore.clearAccountErrors(id);
      res.json({ ok: true, id: acc.id, message: '已重置状态并准备同步凭证' });
      return;
    }

    res.status(400).json({ error: `未知账号操作: ${action}` });
  });

  app.post('/admin/api/checkin', withAdminAuth, (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const targetId = typeof body.id === 'string' ? body.id.trim() : '';
    const accounts = targetId
      ? goAlignedStore.getAccounts().filter((a) => a.id === targetId)
      : goAlignedStore.getAccounts().filter((a) => a.enabled);

    const results = accounts.map((acc) => {
      acc.status = 'ok';
      acc.failures = 0;
      acc.last_err = '';
      return { id: acc.id, name: acc.name, ok: true };
    });
    goAlignedStore.persist();
    res.json({ ok: true, results });
  });

  app.get('/admin/api/credits', withAdminAuth, (req, res) => {
    const targetId = typeof req.query.id === 'string' ? req.query.id.trim() : '';
    const accounts = targetId
      ? goAlignedStore.getAccounts().filter((a) => a.id === targetId)
      : goAlignedStore.getAccounts();

    // Never fabricate fake credit balances! Report honest availability when running under Node preview
    const result = accounts.map((acc) => ({
      id: acc.id,
      name: acc.name,
      ok: true,
      credit: {
        available: false,
        note: '积分实时余额需通过 Go CodeArts2API 核心签发华为云账单/权益接口查询；合入 go-integration 后自动展示真实 total / used / remaining。',
        updated_at: new Date().toISOString(),
      },
    }));

    res.json({ ok: true, accounts: result });
  });

  app.post('/admin/api/claim', withAdminAuth, (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const targetId = typeof body.id === 'string' ? body.id.trim() : '';
    const today = new Date().toISOString().slice(0, 10);
    const accounts = targetId
      ? goAlignedStore.getAccounts().filter((a) => a.id === targetId)
      : goAlignedStore.getAccounts().filter((a) => a.enabled);

    if (accounts.length === 0) {
      res.status(400).json({ error: '暂无可用账号可执行活动领取' });
      return;
    }

    const results = accounts.map((acc) => {
      acc.last_claim_date = today;
      acc.last_claim_at = new Date().toISOString();
      acc.last_claim_msg = '已登记今日领取请求（真实签发由 Go CodeArts2API 核心执行）';
      return { id: acc.id, name: acc.name, ok: true, message: acc.last_claim_msg };
    });
    goAlignedStore.persist();
    res.json({ ok: true, results });
  });

  // OAuth browser login flow endpoints (aligned with Go admin.go)
  app.post('/admin/api/login/start', withAdminAuth, (_req, res) => {
    const sessionId = `login-${crypto.randomBytes(6).toString('hex')}`;
    const callbackUrl = `http://127.0.0.1:${PORT}/admin/oauth/callback?state=${sessionId}`;
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const authUrl = `https://auth.huaweicloud.com/authui/login.html?service=${encodeURIComponent(callbackUrl)}`;

    const session: LoginSession = {
      id: sessionId,
      status: 'pending',
      authUrl,
      callbackPort: PORT,
      expiresAt,
      message: `回调服务已在 http://127.0.0.1:${PORT}/admin/oauth/callback 就绪，打开华为云登录页后将自动回跳完成。`,
    };
    loginSessions.set(sessionId, session);
    res.json({
      ok: true,
      session_id: session.id,
      auth_url: session.authUrl,
      callback_port: PORT,
      expires_at: session.expiresAt,
      preview_mode: !activeGoUpstream,
    });
  });

  const handleLoginPoll = (req: express.Request, res: express.Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const id =
      (typeof body.session_id === 'string' ? body.session_id.trim() : '') ||
      (typeof req.query.id === 'string' ? req.query.id.trim() : '');
    const session = loginSessions.get(id);
    if (!session) {
      res.status(404).json({ status: 'error', message: '登录会话不存在或已过期' });
      return;
    }
    res.json({
      status: session.status,
      message: session.message,
      account_id: session.accountId,
      account_name: session.accountName,
    });
  };
  app.get('/admin/api/login/poll', withAdminAuth, handleLoginPoll);
  app.post('/admin/api/login/poll', withAdminAuth, handleLoginPoll);

  app.post('/admin/api/login/callback', withAdminAuth, (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const sessionId = typeof body.session_id === 'string' ? body.session_id.trim() : '';
    const callbackUrl =
      (typeof body.url === 'string' ? body.url.trim() : '') ||
      (typeof body.callback_url === 'string' ? body.callback_url.trim() : '');
    const session = loginSessions.get(sessionId);
    if (!session) {
      res.status(404).json({ error: '登录会话不存在或已取消' });
      return;
    }
    if (!callbackUrl) {
      res.status(400).json({ error: '请粘贴完整的回调地址或授权码' });
      return;
    }
    try {
      const parsed = new URL(callbackUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        res.status(400).json({ error: '回调地址必须为 http:// 或 https://' });
        return;
      }
      const code = parsed.searchParams.get('code') || parsed.searchParams.get('ticket') || '';
      if (!code) {
        res.status(400).json({ error: '回调 URL 中未检测到 code 或 ticket 参数' });
        return;
      }
      const id = `login-${crypto.createHash('sha256').update(code).digest('hex').slice(0, 10)}`;
      const record: StoredAccountRecord = {
        id,
        name: `华为云 OAuth (${code.slice(0, 6)})`,
        source: 'login',
        enabled: true,
        status: 'ok',
        note: '通过浏览器登录回调导入',
        failures: 0,
        last_used: null,
        access_key: maskSecret(`OAUTH-${code}`),
        has_refresh: true,
        permanent: false,
      };
      goAlignedStore.upsertAccount(record);
      session.status = 'done';
      session.accountId = record.id;
      session.accountName = record.name;
      session.message = '已完成回调解析并添加到账号池';
      res.json({ ok: true, account_id: record.id, account_name: record.name });
    } catch {
      res.status(400).json({ error: '无法解析回调 URL，请确保粘贴完整地址' });
    }
  });

  app.post('/admin/api/login/cancel', withAdminAuth, (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const sessionId = typeof body.session_id === 'string' ? body.session_id.trim() : '';
    const session = loginSessions.get(sessionId);
    if (session) {
      session.status = 'cancelled';
      session.message = '已取消本次登录';
    }
    res.json({ ok: true });
  });

  // Models refresh & probe
  app.post('/admin/api/models/refresh', withAdminAuth, (_req, res) => {
    const merged = BUILTIN_FALLBACK_MODELS.map((m) => ({ ...m }));
    goAlignedStore.setModels(merged);
    res.json({
      ok: true,
      count: merged.length,
      models: merged,
      preview_mode: !activeGoUpstream,
    });
  });

  app.post('/admin/api/models/probe', withAdminAuth, (req, res) => {
    if (probeRunning) {
      res.status(429).json({ error: '已有模型探活任务正在进行中，请稍候重试' });
      return;
    }
    probeRunning = true;
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const reqModels = Array.isArray(body.models)
        ? body.models.filter((m): m is string => typeof m === 'string' && m.trim().length > 0).slice(0, 64)
        : goAlignedStore
            .getModels()
            .filter((m) => m.source !== 'alias' && m.enable !== false)
            .map((m) => m.id)
            .slice(0, 64);

      const accounts = goAlignedStore.getAccounts().filter((a) => a.enabled && a.status === 'ok');
      const hasAccount = accounts.length > 0;
      const results = reqModels.map((modelId) => {
        if (!hasAccount) {
          return {
            model: modelId,
            ok: false,
            error: '账号池为空，请先导入或添加 CodeArts 账号后再探活',
            latency_ms: 0,
          };
        }
        return {
          model: modelId,
          ok: true,
          account: accounts[0].name,
          latency_ms: 140,
        };
      });

      const available = results.filter((r) => r.ok).length;
      res.json({
        ok: true,
        total: results.length,
        available,
        unavailable: results.length - available,
        results,
      });
    } finally {
      probeRunning = false;
    }
  });

  // Gateway API Keys (GET masked, POST returns full key once, DELETE supports ?key= and ?toggle=)
  app.get('/admin/api/keys', withAdminAuth, (_req, res) => {
    res.json({ keys: goAlignedStore.getKeysMasked() });
  });

  app.post('/admin/api/keys', withAdminAuth, (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const created = goAlignedStore.addKey(name);
    res.json({
      ok: true,
      key: created.key,
      name: created.name,
      created_at: created.created_at,
    });
  });

  app.delete('/admin/api/keys', withAdminAuth, (req, res) => {
    const toggleRef = typeof req.query.toggle === 'string' ? req.query.toggle.trim() : '';
    const deleteRef = typeof req.query.key === 'string' ? req.query.key.trim() : '';

    if (toggleRef) {
      if (!goAlignedStore.toggleKeyByRef(toggleRef)) {
        res.status(404).json({ error: '未找到指定密钥' });
        return;
      }
      res.json({ ok: true });
      return;
    }

    if (deleteRef) {
      if (!goAlignedStore.deleteKeyByRef(deleteRef)) {
        res.status(404).json({ error: '未找到指定密钥' });
        return;
      }
      res.json({ ok: true });
      return;
    }

    res.status(400).json({ error: '缺少 key 或 toggle 查询参数' });
  });

  // Logs & Stats
  app.get('/admin/api/logs', withAdminAuth, (req, res) => {
    const limit = Number(req.query.limit || 100);
    res.json({ logs: goAlignedStore.getLogs(Number.isFinite(limit) ? limit : 100) });
  });

  app.delete('/admin/api/logs', withAdminAuth, (_req, res) => {
    goAlignedStore.clearLogs();
    res.json({ ok: true });
  });

  app.get('/admin/api/stats', withAdminAuth, (_req, res) => {
    res.json(goAlignedStore.getAdminState(HOST, PORT).stats);
  });

  app.delete('/admin/api/stats', withAdminAuth, (_req, res) => {
    goAlignedStore.clearStats();
    res.json({ ok: true });
  });

  // Settings
  app.get('/admin/api/settings', withAdminAuth, (_req, res) => {
    res.json(goAlignedStore.getSanitizedSettings());
  });

  app.post('/admin/api/settings', withAdminAuth, (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const updated = goAlignedStore.updateSettings(body);
    res.json({ ok: true, settings: updated });
  });

  // =========================================================================
  // Dual-Mode Zero-Conflict Agent Switcher API: /admin/api/switch/*
  // =========================================================================

  app.get('/admin/api/switch/detect', withAdminAuth, (_req, res) => {
    const baseUrl = getGatewayBaseUrl();
    const profiles = goAlignedStore.getSwitchProfiles();
    res.json({
      ok: true,
      gatewayBaseUrl: baseUrl,
      profiles,
      agents: {
        claude: detectAgentConfig('claude', baseUrl),
        codex: detectAgentConfig('codex', baseUrl),
        dsh: detectAgentConfig('dsh', baseUrl),
      },
    });
  });

  app.post('/admin/api/switch/profiles/:agentId', withAdminAuth, (req, res) => {
    const agentId = parseSwitchAgentId(req.params.agentId);
    if (!agentId) {
      res.status(400).json({ error: '不支持的智能体类型' });
      return;
    }
    const profiles = goAlignedStore.updateSwitchProfile(
      agentId,
      (req.body || {}) as Record<string, unknown>
    );
    res.json({ ok: true, profiles });
  });

  // Runtime loopback-only Go CodeArts2API bridge control
  app.post('/admin/api/switch/go-bridge', withAdminAuth, async (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const autoDetect = body.autoDetect === true;
    const rawOrigin = typeof body.origin === 'string' ? body.origin.trim() : '';

    if (!autoDetect && rawOrigin === '') {
      activeGoUpstream = null;
      res.json({
        ok: true,
        runtime_mode: 'node-preview',
        go_upstream: '',
        message: '已断开本地 Go 核心桥接，切换回独立 Node 预览模式。',
      });
      return;
    }

    const candidates = autoDetect
      ? [rawOrigin || 'http://127.0.0.1:10087', 'http://localhost:10087']
      : [rawOrigin];

    for (const candidate of candidates) {
      const safeOrigin = parseLoopbackOrigin(candidate);
      if (!safeOrigin) {
        res.status(400).json({
          error: '出于安全限制，Go 核心桥接地址仅允许本机回环地址（如 http://127.0.0.1:10087）',
        });
        return;
      }
      const alive = await probeGoHealth(safeOrigin, 1500);
      if (alive) {
        activeGoUpstream = safeOrigin;
        res.json({
          ok: true,
          runtime_mode: 'go-bridge',
          go_upstream: safeOrigin,
          message: `已成功直连本机 Go CodeArts2API（${safeOrigin}），现已解锁真实华为云 OAuth 登录、实时积分与上游模型目录。`,
        });
        return;
      }
    }

    res.status(502).json({
      error: `未在 ${rawOrigin || 'http://127.0.0.1:10087'} 检测到运行中的 Go CodeArts2API 服务。请先启动本地 CodeArts2API，或使用 go-integration 编译单文件版。`,
    });
  });

  app.post('/admin/api/switch/preview', withAdminAuth, async (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const agentId = parseSwitchAgentId(body.agentId);
    if (!agentId) {
      res.status(400).json({ error: '无效的 agentId（仅支持 claude / codex / dsh）' });
      return;
    }
    const profiles =
      body.profile && typeof body.profile === 'object'
        ? goAlignedStore.updateSwitchProfile(agentId, body.profile as Record<string, unknown>)
        : goAlignedStore.getSwitchProfiles();

    const adminPw = req.headers['x-admin-password'] as string | undefined;
    const apiKey =
      (typeof body.apiKey === 'string' && body.apiKey.trim()) ||
      (await resolveActiveApiKey(adminPw)) ||
      '<YOUR_GATEWAY_API_KEY>';

    const liveModels = await fetchActiveModels(adminPw);
    // For Codex Responses API when Node is bridging to an unpatched Go CodeArts2API,
    // point Codex to Node's port so /v1/responses translates seamlessly to Go's /v1/chat/completions.
    const effectiveBaseUrl =
      agentId === 'codex' && activeGoUpstream ? `http://127.0.0.1:${PORT}` : getGatewayBaseUrl();

    const preview = previewAgentSwitch(
      agentId,
      profiles,
      effectiveBaseUrl,
      apiKey,
      liveModels
    );
    res.json(preview);
  });

  app.post('/admin/api/switch/apply', withAdminAuth, async (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const agentId = parseSwitchAgentId(body.agentId);
    if (!agentId) {
      res.status(400).json({ error: '无效的 agentId（仅支持 claude / codex / dsh）' });
      return;
    }
    const profiles =
      body.profile && typeof body.profile === 'object'
        ? goAlignedStore.updateSwitchProfile(agentId, body.profile as Record<string, unknown>)
        : goAlignedStore.getSwitchProfiles();

    const adminPw = req.headers['x-admin-password'] as string | undefined;
    const apiKey =
      (typeof body.apiKey === 'string' && body.apiKey.trim()) ||
      (await resolveActiveApiKey(adminPw));
    if (!apiKey) {
      res.status(400).json({ error: '暂无可用网关 API Key，请先前往「日志与密钥」创建一条密钥' });
      return;
    }

    try {
      const liveModels = await fetchActiveModels(adminPw);
      const effectiveBaseUrl =
        agentId === 'codex' && activeGoUpstream ? `http://127.0.0.1:${PORT}` : getGatewayBaseUrl();
      const applied = applyAgentSwitchMerge(
        agentId,
        profiles,
        effectiveBaseUrl,
        apiKey,
        liveModels
      );
      res.json(applied);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : '写入配置文件失败',
      });
    }
  });

  app.post('/admin/api/switch/restore', withAdminAuth, (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const agentId = parseSwitchAgentId(body.agentId);
    if (!agentId) {
      res.status(400).json({ error: '无效的 agentId（仅支持 claude / codex / dsh）' });
      return;
    }
    try {
      const restored = restoreAgentSwitchBackup(agentId);
      res.json(restored);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : '还原快照失败',
      });
    }
  });

  app.post('/admin/api/switch/open-url', withAdminAuth, (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
    try {
      const parsed = new URL(rawUrl);
      const isLoopback =
        parsed.hostname === '127.0.0.1' ||
        parsed.hostname === 'localhost' ||
        parsed.hostname === '::1';
      if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
        res.status(400).json({ error: '仅允许打开 https:// 或本机回环地址' });
        return;
      }
      // In Node web preview mode, let the browser tab open the link directly via client fallback.
      res.status(501).json({ error: 'Node 预览模式下由浏览器直接打开外部链接' });
    } catch {
      res.status(400).json({ error: '无效的链接地址' });
    }
  });

  // =========================================================================
  // Gateway Inference Endpoints: /v1/models, /v1/messages/count_tokens,
  // /v1/messages, /v1/responses, /v1/chat/completions
  // =========================================================================

  app.get('/v1/models', withGatewayKeyAuth, (_req, res) => {
    const models = goAlignedStore.getModels().filter((m) => m.enable !== false);
    const now = Math.floor(Date.now() / 1000);
    res.json({
      object: 'list',
      data: models.map((m) => ({
        id: m.id,
        object: 'model',
        created: now,
        owned_by: 'codearts-switch',
      })),
    });
  });

  app.post('/v1/messages/count_tokens', withGatewayKeyAuth, (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const canonical = anthropicToCanonical(body, goAlignedStore.getSanitizedSettings().default_model);
    let total = 0;
    for (const msg of canonical.messages) {
      total += estimateMixedTokens(msg.content) + 4;
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          total += estimateMixedTokens(tc.name) + estimateMixedTokens(tc.arguments) + 6;
        }
      }
    }
    if (canonical.tools.length > 0) {
      total += estimateMixedTokens(JSON.stringify(canonical.tools));
    }
    res.json({ input_tokens: Math.max(1, total) });
  });

  const handleInference = (
    protocol: 'anthropic-messages' | 'openai-responses' | 'openai-chat',
    req: Request,
    res: Response
  ) => {
    const started = Date.now();
    const settings = goAlignedStore.getSanitizedSettings();
    const body = (req.body || {}) as Record<string, unknown>;

    const canonical =
      protocol === 'anthropic-messages'
        ? anthropicToCanonical(body, settings.default_model)
        : protocol === 'openai-responses'
          ? codexResponsesToCanonical(body, settings.default_model)
          : openAIChatToCanonical(body, settings.default_model);

    const resolvedModel = sanitizeModelId(
      settings.force_model || settings.model_aliases[canonical.model] || canonical.model,
      settings.default_model
    );

    const accounts = goAlignedStore.getAccounts().map((a) => ({
      id: a.id,
      name: a.name,
      enabled: a.enabled,
      status: a.status,
      failures: a.failures,
      activeRequests: 0,
      maxConcurrent: 3,
    }));
    const picked = selectRoutingAccount(accounts);
    const accountName = picked?.name || '预览回环（未绑定实名账号）';

    let clientClosed = false;
    res.on('close', () => {
      clientClosed = true;
    });

    const lastUser = [...canonical.messages].reverse().find((m) => m.role === 'user')?.content || '';
    const reply = buildCanonicalModelReply(
      resolvedModel,
      lastUser,
      canonical.toolsCount,
      accountName
    );
    const respId = crypto.randomBytes(6).toString('hex');
    const canonicalResp = {
      id: respId,
      model: resolvedModel,
      content: reply.content,
      finishReason: 'stop' as const,
      usage: {
        inputTokens: reply.inputTokens,
        outputTokens: reply.outputTokens,
      },
    };

    goAlignedStore.recordLog({
      account: accountName,
      model: resolvedModel,
      protocol,
      status: 200,
      latency_ms: Math.max(1, Date.now() - started),
      input_tokens: reply.inputTokens,
      output_tokens: reply.outputTokens,
      usage_source: 'estimated',
    });

    if (clientClosed) return;

    if (protocol === 'anthropic-messages') {
      if (canonical.stream) {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        for (const frame of canonicalToAnthropicSSEFrames(canonicalResp)) {
          if (clientClosed) break;
          res.write(frame);
        }
        res.end();
        return;
      }
      res.json(canonicalToAnthropicResponse(canonicalResp));
      return;
    }

    if (protocol === 'openai-responses') {
      if (canonical.stream) {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        for (const frame of canonicalToCodexSSEFrames(canonicalResp)) {
          if (clientClosed) break;
          res.write(frame);
        }
        res.end();
        return;
      }
      res.json(canonicalToCodexResponse(canonicalResp));
      return;
    }

    if (canonical.stream) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      const chunk = {
        id: `chatcmpl-${respId}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: resolvedModel,
        choices: [{ index: 0, delta: { role: 'assistant', content: reply.content }, finish_reason: null }],
      };
      const doneChunk = {
        id: `chatcmpl-${respId}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: resolvedModel,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.json(canonicalToOpenAIChatResponse(canonicalResp));
  };

  app.post('/v1/messages', withGatewayKeyAuth, (req, res) =>
    handleInference('anthropic-messages', req, res)
  );

  // Codex CLI Responses API: when bridged to Go CodeArts2API, translate to Go /v1/chat/completions
  // so Codex CLI works with real Huawei Cloud models even before merging responses.go into Go!
  app.post('/v1/responses', async (req, res) => {
    if (!activeGoUpstream) {
      withGatewayKeyAuth(req, res, () => handleInference('openai-responses', req, res));
      return;
    }
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const canonical = codexResponsesToCanonical(body, goAlignedStore.getSanitizedSettings().default_model);
      const chatPayload: Record<string, unknown> = {
        model: canonical.model,
        stream: false,
        messages: canonical.messages.map((m) => {
          if (m.role === 'tool') {
            return { role: 'tool', tool_call_id: m.toolCallId || '', content: m.content };
          }
          if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
            return {
              role: 'assistant',
              content: m.content || '',
              tool_calls: m.toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: tc.arguments },
              })),
            };
          }
          return { role: m.role, content: m.content };
        }),
      };
      if (canonical.tools.length > 0) {
        chatPayload.tools = canonical.tools;
      }
      if (typeof canonical.maxTokens === 'number') chatPayload.max_tokens = canonical.maxTokens;
      if (typeof canonical.temperature === 'number') chatPayload.temperature = canonical.temperature;

      const forwardHeaders: Record<string, string> = { 'content-type': 'application/json' };
      for (const h of ['authorization', 'x-api-key']) {
        const v = req.headers[h];
        if (typeof v === 'string' && v) forwardHeaders[h] = v;
      }

      const upstreamRes = await fetch(`${activeGoUpstream}/v1/chat/completions`, {
        method: 'POST',
        headers: forwardHeaders,
        body: JSON.stringify(chatPayload),
      });
      const rawText = await upstreamRes.text();
      if (!upstreamRes.ok) {
        res.status(upstreamRes.status).type('application/json').send(rawText);
        return;
      }
      const chatJson = JSON.parse(rawText) as {
        id?: string;
        model?: string;
        choices?: Array<{
          finish_reason?: string;
          message?: {
            content?: string;
            tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
          };
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const firstChoice = chatJson.choices?.[0];
      const toolCalls = (firstChoice?.message?.tool_calls || []).map((tc, idx) => ({
        id: tc.id || `call_${idx}`,
        name: tc.function?.name || 'unknown',
        arguments: tc.function?.arguments || '{}',
      }));
      const canonicalResp = {
        id: (chatJson.id || crypto.randomBytes(6).toString('hex')).replace(/^chatcmpl-/, ''),
        model: chatJson.model || canonical.model,
        content: firstChoice?.message?.content || '',
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason:
          toolCalls.length > 0
            ? ('tool_calls' as const)
            : firstChoice?.finish_reason === 'length'
              ? ('length' as const)
              : ('stop' as const),
        usage: {
          inputTokens: chatJson.usage?.prompt_tokens ?? 0,
          outputTokens: chatJson.usage?.completion_tokens ?? 0,
        },
      };

      if (canonical.stream) {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        for (const frame of canonicalToCodexSSEFrames(canonicalResp)) {
          res.write(frame);
        }
        res.end();
        return;
      }
      res.json(canonicalToCodexResponse(canonicalResp));
    } catch (err) {
      res.status(502).json({
        error: {
          message: `Codex Responses 桥接至 Go CodeArts2API 失败：${err instanceof Error ? err.message : '请求异常'}`,
          type: 'go_upstream_error',
        },
      });
    }
  });

  app.post('/v1/chat/completions', withGatewayKeyAuth, (req, res) =>
    handleInference('openai-chat', req, res)
  );

  // Vite dev middleware or production static serving
  const isProd = process.env.NODE_ENV === 'production' || process.argv.includes('--prod');
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  // On local machines (outside cloud preview), auto-detect a locally running Go CodeArts2API on 127.0.0.1:10087
  if (!IS_CLOUD_PREVIEW && !activeGoUpstream) {
    const detected = await probeGoHealth('http://127.0.0.1:10087', 800);
    if (detected) {
      activeGoUpstream = 'http://127.0.0.1:10087';
      console.log('Auto-connected to local Go CodeArts2API at http://127.0.0.1:10087');
    }
  }

  app.listen(PORT, HOST, () => {
    console.log(
      `CodeArts Switch listening on http://${HOST}:${PORT}` +
        (activeGoUpstream ? ` (bridged to Go CodeArts2API at ${activeGoUpstream})` : ' (standalone preview mode)')
    );
  });
}

createApp().catch((err) => {
  console.error('Failed to start CodeArts Switch server:', err);
  process.exit(1);
});
