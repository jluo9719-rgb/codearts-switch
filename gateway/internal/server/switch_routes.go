package server

import (
	"encoding/json"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"codearts2api/internal/switcher"
)

const (
	defaultAppVersion     = "1.0.2"
	githubReleasesAPIURL  = "https://api.github.com/repos/jluo9719-rgb/codearts-switch/releases/latest"
	githubReleasesPageURL = "https://github.com/jluo9719-rgb/codearts-switch/releases"
)

var (
	switchProfilesMu     sync.RWMutex
	switchProfilesLoaded bool
	switchProfiles       = switcher.DefaultProfiles()
)

// RegisterSwitchRoutes mounts the CodeArts Switch routes onto CodeArts2API's mux.
func (s *Server) RegisterSwitchRoutes(mux *http.ServeMux, distFS fs.FS) {
	// Claude Code token estimator + Codex Responses API
	mux.HandleFunc("/v1/messages/count_tokens", s.withAuth(s.handleCountTokens))
	mux.HandleFunc("/v1/responses", s.withAuth(s.withRateLimit(errOpenAI, s.handleCodexResponses)))

	// Dual-mode zero-conflict switcher admin endpoints (same withAdminAuth guard)
	mux.HandleFunc("/admin/api/switch/detect", s.withAdminAuth(s.handleSwitchDetect))
	mux.HandleFunc("/admin/api/switch/profiles/", s.withAdminAuth(s.handleSwitchProfileSave))
	mux.HandleFunc("/admin/api/switch/preview", s.withAdminAuth(s.handleSwitchPreview))
	mux.HandleFunc("/admin/api/switch/apply", s.withAdminAuth(s.handleSwitchApply))
	mux.HandleFunc("/admin/api/switch/restore", s.withAdminAuth(s.handleSwitchRestore))
	mux.HandleFunc("/admin/api/switch/open-url", s.withAdminAuth(s.handleSwitchOpenURL))
	mux.HandleFunc("/admin/api/switch/update-check", s.withAdminAuth(s.handleSwitchUpdateCheck))

	// Serve embedded React dist/ static assets if built
	if distFS != nil {
		fileServer := http.FileServer(http.FS(distFS))
		mux.HandleFunc("/assets/", func(w http.ResponseWriter, r *http.Request) {
			fileServer.ServeHTTP(w, r)
		})
	}
}

// ServeSwitchIndex serves the embedded React console index.html from distFS.
// Falls back cleanly to CodeArts2API's built-in console if dist/ hasn't been copied yet.
func (s *Server) ServeSwitchIndex(w http.ResponseWriter, _ *http.Request, distFS fs.FS) bool {
	if distFS == nil {
		return false
	}
	b, err := fs.ReadFile(distFS, "index.html")
	if err != nil || len(b) == 0 {
		return false
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(b)
	return true
}

func (s *Server) switchBaseURL(r *http.Request) string {
	host := r.Host
	if strings.TrimSpace(host) == "" {
		host = "127.0.0.1:10087"
	}
	return switcher.SanitizeBaseURL("http://" + host)
}

func (s *Server) switchDataDir() string {
	if envDir := strings.TrimSpace(os.Getenv("CODEARTS_SWITCH_DATA_DIR")); envDir != "" {
		return envDir
	}
	if s.Store != nil && strings.TrimSpace(s.Store.Path()) != "" {
		return filepath.Join(filepath.Dir(s.Store.Path()), "switch-data")
	}
	return "data"
}

func parseAgentID(raw string) (switcher.AgentID, bool) {
	switch switcher.AgentID(strings.TrimSpace(raw)) {
	case switcher.AgentClaude, switcher.AgentCodex, switcher.AgentDSH:
		return switcher.AgentID(strings.TrimSpace(raw)), true
	default:
		return "", false
	}
}

func (s *Server) getSwitchProfiles() switcher.ProfilesState {
	switchProfilesMu.RLock()
	if switchProfilesLoaded {
		p := switchProfiles
		switchProfilesMu.RUnlock()
		return p
	}
	switchProfilesMu.RUnlock()

	switchProfilesMu.Lock()
	defer switchProfilesMu.Unlock()
	if !switchProfilesLoaded {
		switchProfiles = switcher.LoadProfiles(s.switchDataDir())
		switchProfilesLoaded = true
	}
	return switchProfiles
}

func (s *Server) updateSwitchProfiles(agentID switcher.AgentID, raw json.RawMessage) switcher.ProfilesState {
	switchProfilesMu.Lock()
	if !switchProfilesLoaded {
		switchProfiles = switcher.LoadProfiles(s.switchDataDir())
		switchProfilesLoaded = true
	}
	applyProfilePatchLocked(agentID, raw)
	snapshot := switchProfiles
	switchProfilesMu.Unlock()

	_ = switcher.SaveProfiles(s.switchDataDir(), snapshot)
	return snapshot
}

func (s *Server) handleSwitchDetect(w http.ResponseWriter, r *http.Request) {
	baseURL := s.switchBaseURL(r)
	dataDir := s.switchDataDir()
	profiles := s.getSwitchProfiles()

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":             true,
		"gatewayBaseUrl": baseURL,
		"profiles":       profiles,
		"agents": map[string]switcher.Detection{
			"claude": switcher.Detect(dataDir, switcher.AgentClaude, baseURL),
			"codex":  switcher.Detect(dataDir, switcher.AgentCodex, baseURL),
			"dsh":    switcher.Detect(dataDir, switcher.AgentDSH, baseURL),
		},
	})
}

func applyProfilePatchLocked(agentID switcher.AgentID, raw json.RawMessage) {
	if len(raw) == 0 || string(raw) == "null" {
		return
	}
	switch agentID {
	case switcher.AgentClaude:
		var p switcher.ClaudeProfile
		if err := json.Unmarshal(raw, &p); err == nil {
			if p.PrimaryModel != "" {
				switchProfiles.Claude.PrimaryModel = switcher.SanitizeModel(p.PrimaryModel, "glm-5.3")
			}
			if p.SonnetModel != "" {
				switchProfiles.Claude.SonnetModel = switcher.SanitizeModel(p.SonnetModel, "glm-5.3")
			}
			if p.OpusModel != "" {
				switchProfiles.Claude.OpusModel = switcher.SanitizeModel(p.OpusModel, "GLM-5.2")
			}
			if p.HaikuModel != "" {
				switchProfiles.Claude.HaikuModel = switcher.SanitizeModel(p.HaikuModel, "deepseek-v4.1-flash")
			}
		}
	case switcher.AgentCodex:
		var p switcher.CodexProfile
		if err := json.Unmarshal(raw, &p); err == nil {
			if p.Model != "" {
				switchProfiles.Codex.Model = switcher.SanitizeModel(p.Model, "glm-5.3")
			}
			if p.WireAPI == "responses" || p.WireAPI == "chat" {
				switchProfiles.Codex.WireAPI = p.WireAPI
			}
			if p.ApprovalPolicy != "" {
				switchProfiles.Codex.ApprovalPolicy = p.ApprovalPolicy
			}
			if p.AuthMode == "desktop-direct" || p.AuthMode == "env-key" {
				switchProfiles.Codex.AuthMode = p.AuthMode
			}
			if p.FallbackUnknownModel != nil {
				v := *p.FallbackUnknownModel
				switchProfiles.Codex.FallbackUnknownModel = &v
			}
		}
	case switcher.AgentDSH:
		var p switcher.DSHProfile
		if err := json.Unmarshal(raw, &p); err == nil {
			if p.Model != "" {
				switchProfiles.DSH.Model = switcher.SanitizeModel(p.Model, "deepseek-v4.1-flash")
			}
			if p.FallbackModel != "" {
				switchProfiles.DSH.FallbackModel = switcher.SanitizeModel(p.FallbackModel, "glm-5.3")
			}
			switchProfiles.DSH.TelemetryDisabled = p.TelemetryDisabled
		}
	}
}

func (s *Server) handleSwitchProfileSave(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error")
		return
	}
	rawID := strings.TrimPrefix(r.URL.Path, "/admin/api/switch/profiles/")
	agentID, ok := parseAgentID(rawID)
	if !ok {
		writeErr(w, http.StatusBadRequest, "不支持的智能体类型", "invalid_request_error")
		return
	}
	var raw json.RawMessage
	if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
		writeErr(w, http.StatusBadRequest, "无效的请求体", "invalid_request_error")
		return
	}
	snapshot := s.updateSwitchProfiles(agentID, raw)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "profiles": snapshot})
}

func (s *Server) ensureActiveAPIKey() string {
	for _, k := range s.Store.Keys() {
		if k.Enabled && k.Key != "" {
			return k.Key
		}
	}
	// Auto-provision a default key on first Switch preview/apply so launchers & CC Switch card work immediately.
	k := s.Store.AddKey("码道 Switch 默认密钥")
	s.persist()
	if k != nil {
		return k.Key
	}
	return ""
}

func (s *Server) handleSwitchPreview(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error")
		return
	}
	var req struct {
		AgentID string          `json:"agentId"`
		APIKey  string          `json:"apiKey"`
		Profile json.RawMessage `json:"profile"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "无效的请求体", "invalid_request_error")
		return
	}
	agentID, ok := parseAgentID(req.AgentID)
	if !ok {
		writeErr(w, http.StatusBadRequest, "无效的 agentId", "invalid_request_error")
		return
	}
	apiKey := strings.TrimSpace(req.APIKey)
	if apiKey == "" {
		apiKey = s.ensureActiveAPIKey()
	}

	profiles := s.updateSwitchProfiles(agentID, req.Profile)
	prev, err := switcher.Preview(agentID, profiles, s.switchBaseURL(r), apiKey)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error(), "api_error")
		return
	}
	writeJSON(w, http.StatusOK, prev)
}

func (s *Server) handleSwitchApply(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error")
		return
	}
	var req struct {
		AgentID string          `json:"agentId"`
		APIKey  string          `json:"apiKey"`
		Profile json.RawMessage `json:"profile"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "无效的请求体", "invalid_request_error")
		return
	}
	agentID, ok := parseAgentID(req.AgentID)
	if !ok {
		writeErr(w, http.StatusBadRequest, "无效的 agentId", "invalid_request_error")
		return
	}
	apiKey := strings.TrimSpace(req.APIKey)
	if apiKey == "" {
		apiKey = s.ensureActiveAPIKey()
	}
	if apiKey == "" {
		writeErr(w, http.StatusBadRequest, "请先在「日志与密钥」创建一条 API 密钥后再写入配置", "invalid_request_error")
		return
	}

	profiles := s.updateSwitchProfiles(agentID, req.Profile)
	res, err := switcher.Apply(s.switchDataDir(), agentID, profiles, s.switchBaseURL(r), apiKey)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error(), "api_error")
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleSwitchRestore(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error")
		return
	}
	var req struct {
		AgentID string `json:"agentId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "无效的请求体", "invalid_request_error")
		return
	}
	agentID, ok := parseAgentID(req.AgentID)
	if !ok {
		writeErr(w, http.StatusBadRequest, "无效的 agentId", "invalid_request_error")
		return
	}
	res, err := switcher.Restore(s.switchDataDir(), agentID)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error(), "invalid_request_error")
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// handleSwitchOpenURL opens a validated https:// (or loopback http://) URL in the OS default browser.
// Uses rundll32 url.dll,FileProtocolHandler on Windows to avoid cmd.exe splitting OAuth '&' parameters.
func (s *Server) handleSwitchOpenURL(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error")
		return
	}
	var req struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "无效的请求体", "invalid_request_error")
		return
	}
	rawURL := strings.TrimSpace(req.URL)
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Host == "" {
		writeErr(w, http.StatusBadRequest, "无效的链接地址", "invalid_request_error")
		return
	}
	allowed := parsed.Scheme == "https" || (parsed.Scheme == "http" && isLoopbackHost(parsed.Hostname()))
	if !allowed {
		writeErr(w, http.StatusBadRequest, "仅允许打开 https:// 或本机回环地址", "invalid_request_error")
		return
	}

	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", rawURL)
	case "darwin":
		cmd = exec.Command("open", rawURL)
	default:
		cmd = exec.Command("xdg-open", rawURL)
	}
	if err := cmd.Start(); err != nil {
		writeErr(w, http.StatusInternalServerError, "无法呼起系统默认浏览器: "+err.Error(), "api_error")
		return
	}
	go func() { _ = cmd.Wait() }()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": "已在系统默认浏览器打开"})
}

func (s *Server) currentAppVersion() string {
	v := strings.TrimSpace(s.Version)
	if v == "" || v == "dev" {
		return defaultAppVersion
	}
	return strings.TrimPrefix(strings.TrimPrefix(v, "v"), "V")
}

func parseSemverParts(v string) [3]int {
	cleaned := strings.TrimSpace(v)
	cleaned = strings.TrimPrefix(strings.TrimPrefix(cleaned, "v"), "V")
	if idx := strings.IndexByte(cleaned, '-'); idx >= 0 {
		cleaned = cleaned[:idx]
	}
	parts := strings.Split(cleaned, ".")
	var out [3]int
	for i := 0; i < 3 && i < len(parts); i++ {
		if n, err := strconv.Atoi(parts[i]); err == nil && n >= 0 {
			out[i] = n
		}
	}
	return out
}

func isNewerVersion(current, latest string) bool {
	c := parseSemverParts(current)
	l := parseSemverParts(latest)
	for i := 0; i < 3; i++ {
		if l[i] > c[i] {
			return true
		}
		if l[i] < c[i] {
			return false
		}
	}
	return false
}

// handleSwitchUpdateCheck queries GitHub Releases API server-side so WebView2 avoids CORS issues.
func (s *Server) handleSwitchUpdateCheck(w http.ResponseWriter, r *http.Request) {
	current := s.currentAppVersion()
	client := &http.Client{Timeout: 8 * time.Second}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, githubReleasesAPIURL, nil)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":             false,
			"currentVersion": current,
			"releaseUrl":     githubReleasesPageURL,
			"error":          "构造检查请求失败",
		})
		return
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "CodeArts-Switch/"+current)

	resp, err := client.Do(req)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":             false,
			"currentVersion": current,
			"releaseUrl":     githubReleasesPageURL,
			"error":          "无法连接 GitHub 检查更新（可手动打开 Releases 页面查看）",
		})
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":             true,
			"currentVersion": current,
			"latestVersion":  current,
			"hasUpdate":      false,
			"releaseUrl":     githubReleasesPageURL,
		})
		return
	}
	if resp.StatusCode >= 400 {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":             false,
			"currentVersion": current,
			"releaseUrl":     githubReleasesPageURL,
			"error":          "GitHub API 返回异常状态: " + resp.Status,
		})
		return
	}

	var rel struct {
		TagName     string `json:"tag_name"`
		Name        string `json:"name"`
		HTMLURL     string `json:"html_url"`
		PublishedAt string `json:"published_at"`
		Body        string `json:"body"`
		Assets      []struct {
			Name               string `json:"name"`
			BrowserDownloadURL string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":             false,
			"currentVersion": current,
			"releaseUrl":     githubReleasesPageURL,
			"error":          "解析 GitHub Release 响应失败",
		})
		return
	}

	latest := strings.TrimPrefix(strings.TrimPrefix(strings.TrimSpace(rel.TagName), "v"), "V")
	if latest == "" {
		latest = current
	}
	releaseURL := strings.TrimSpace(rel.HTMLURL)
	if releaseURL == "" {
		releaseURL = githubReleasesPageURL
	}
	downloadURL := releaseURL
	for _, asset := range rel.Assets {
		lower := strings.ToLower(asset.Name)
		if strings.HasSuffix(lower, "-setup.exe") || strings.HasSuffix(lower, ".exe") && strings.Contains(lower, "setup") {
			downloadURL = asset.BrowserDownloadURL
			break
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":             true,
		"currentVersion": current,
		"latestVersion":  latest,
		"hasUpdate":      isNewerVersion(current, latest),
		"releaseUrl":     releaseURL,
		"downloadUrl":    downloadURL,
		"publishedAt":    rel.PublishedAt,
		"releaseNotes":   rel.Body,
	})
}

// handleCountTokens implements POST /v1/messages/count_tokens with CJK-aware estimation.
func (s *Server) handleCountTokens(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error")
		return
	}
	var raw map[string]any
	if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json", "invalid_request_error")
		return
	}
	b, _ := json.Marshal(raw)
	tokens := estimateCJKTokens(string(b))
	writeJSON(w, http.StatusOK, map[string]int{"input_tokens": tokens})
}

func estimateCJKTokens(s string) int {
	if s == "" {
		return 1
	}
	cjk := 0
	other := 0
	for _, r := range s {
		if (r >= 0x4E00 && r <= 0x9FFF) || (r >= 0x3400 && r <= 0x4DBF) || (r >= 0x3000 && r <= 0x303F) || (r >= 0xFF00 && r <= 0xFFEF) {
			cjk++
		} else if utf8.ValidRune(r) {
			other++
		}
	}
	n := cjk + (other+3)/4
	if n < 1 {
		return 1
	}
	return n
}
