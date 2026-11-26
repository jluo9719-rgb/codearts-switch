package switcher

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

type AgentID string

const (
	AgentClaude AgentID = "claude"
	AgentCodex  AgentID = "codex"
	AgentDSH    AgentID = "dsh"
)

type ClaudeProfile struct {
	PrimaryModel string `json:"primaryModel"`
	SonnetModel  string `json:"sonnetModel"`
	OpusModel    string `json:"opusModel"`
	HaikuModel   string `json:"haikuModel"`
}

type CodexProfile struct {
	Model                string `json:"model"`
	WireAPI              string `json:"wireApi"`
	ApprovalPolicy       string `json:"approvalPolicy"`
	AuthMode             string `json:"authMode,omitempty"`
	FallbackUnknownModel *bool  `json:"fallbackUnknownModel,omitempty"`
}

// ShouldFallbackUnknownModel reports whether unknown OpenAI/Codex Desktop model slugs
// (e.g. gpt-6.2-sol, gpt-5.6-sol) should automatically route to CodexProfile.Model.
// Defaults to true when omitted so Codex Desktop works out-of-the-box without global force_model.
func (c CodexProfile) ShouldFallbackUnknownModel() bool {
	if c.FallbackUnknownModel == nil {
		return true
	}
	return *c.FallbackUnknownModel
}

type DSHProfile struct {
	Model             string `json:"model"`
	FallbackModel     string `json:"fallbackModel"`
	TelemetryDisabled bool   `json:"telemetryDisabled"`
}

type ProfilesState struct {
	Claude ClaudeProfile `json:"claude"`
	Codex  CodexProfile  `json:"codex"`
	DSH    DSHProfile    `json:"dsh"`
}

type Detection struct {
	AgentID        AgentID  `json:"agentId"`
	ConfigPath     string   `json:"configPath"`
	ConfigExists   bool     `json:"configExists"`
	HistoryPath    string   `json:"historyPath"`
	ManagedBy      string   `json:"managedBy"`
	CurrentBaseURL string   `json:"currentBaseUrl,omitempty"`
	PreservedItems []string `json:"preservedItems"`
	HasBackup      bool     `json:"hasBackup"`
	LastBackupAt   string   `json:"lastBackupAt,omitempty"`
	BackupCount    int      `json:"backupCount"`
}

type DiffLine struct {
	Type string `json:"type"`
	Line string `json:"line"`
}

type FilePreview struct {
	ID            string     `json:"id"`
	Label         string     `json:"label"`
	TargetPath    string     `json:"targetPath"`
	BeforeContent string     `json:"beforeContent"`
	AfterContent  string     `json:"afterContent"`
	DiffLines     []DiffLine `json:"diffLines"`
	PreservedKeys []string   `json:"preservedKeys"`
	ModifiedKeys  []string   `json:"modifiedKeys"`
}

type ZeroIntrusionLaunchers struct {
	PowerShell             string `json:"powershell"`
	Cmd                    string `json:"cmd"`
	Bash                   string `json:"bash"`
	AliasName              string `json:"aliasName"`
	PowerShellAliasSnippet string `json:"powershellAliasSnippet"`
	CmdAliasSnippet        string `json:"cmdAliasSnippet"`
	BashAliasSnippet       string `json:"bashAliasSnippet"`
	HistorySharedNote      string `json:"historySharedNote"`
	OverrideSettingsPath   string `json:"overrideSettingsPath,omitempty"`
}

type CodexCCSwitchSnippet struct {
	Name        string `json:"name"`
	BaseURL     string `json:"baseUrl"`
	APIKey      string `json:"apiKey"`
	WireAPI     string `json:"wireApi"`
	Model       string `json:"model"`
	TomlSnippet string `json:"tomlSnippet"`
}

type PreviewResponse struct {
	OK               bool                   `json:"ok"`
	AgentID          AgentID                `json:"agentId"`
	GatewayBaseURL   string                 `json:"gatewayBaseUrl"`
	Files            []FilePreview          `json:"files"`
	ZeroIntrusion    ZeroIntrusionLaunchers `json:"zeroIntrusion"`
	CCSwitchProvider *CodexCCSwitchSnippet  `json:"ccSwitchProvider,omitempty"`
}

type ApplyResponse struct {
	OK           bool     `json:"ok"`
	AgentID      AgentID  `json:"agentId"`
	WrittenFiles []string `json:"writtenFiles"`
	SnapshotID   string   `json:"snapshotId"`
	SnapshotPath string   `json:"snapshotPath"`
	CLICommand   string   `json:"cliCommand"`
	Message      string   `json:"message"`
}

type RestoreResponse struct {
	OK            bool     `json:"ok"`
	AgentID       AgentID  `json:"agentId"`
	RestoredFiles []string `json:"restoredFiles"`
	Message       string   `json:"message"`
}

type snapshotFile struct {
	TargetPath string `json:"targetPath"`
	Existed    bool   `json:"existed"`
	Content    string `json:"content"`
	SHA256     string `json:"sha256"`
}

type snapshot struct {
	ID        string         `json:"id"`
	AgentID   AgentID        `json:"agentId"`
	CreatedAt string         `json:"createdAt"`
	Files     []snapshotFile `json:"files"`
}

var (
	reModelSanitize = regexp.MustCompile(`[^a-zA-Z0-9._:/-]`)
	reTomlHeader    = regexp.MustCompile(`^\[([^\]]+)\]\s*$`)
	reTomlKV        = regexp.MustCompile(`^([a-zA-Z0-9_-]+)\s*=`)
)

func boolPtr(v bool) *bool { return &v }

func DefaultProfiles() ProfilesState {
	return ProfilesState{
		Claude: ClaudeProfile{
			PrimaryModel: "glm-5.3",
			SonnetModel:  "glm-5.3",
			OpusModel:    "GLM-5.2",
			HaikuModel:   "deepseek-v4.1-flash",
		},
		Codex: CodexProfile{
			Model:                "glm-5.3",
			WireAPI:              "responses",
			ApprovalPolicy:       "on-request",
			AuthMode:             "desktop-direct",
			FallbackUnknownModel: boolPtr(true),
		},
		DSH: DSHProfile{
			Model:             "deepseek-v4.1-flash",
			FallbackModel:     "glm-5.3",
			TelemetryDisabled: true,
		},
	}
}

// LoadProfiles reads persisted switch-profiles.json from dataDir, merging onto defaults.
func LoadProfiles(dataDir string) ProfilesState {
	def := DefaultProfiles()
	if strings.TrimSpace(dataDir) == "" {
		return def
	}
	b, err := os.ReadFile(filepath.Join(dataDir, "switch-profiles.json"))
	if err != nil || len(b) == 0 {
		return def
	}
	var loaded ProfilesState
	if err := json.Unmarshal(b, &loaded); err != nil {
		return def
	}
	if loaded.Claude.PrimaryModel != "" {
		def.Claude.PrimaryModel = SanitizeModel(loaded.Claude.PrimaryModel, def.Claude.PrimaryModel)
	}
	if loaded.Claude.SonnetModel != "" {
		def.Claude.SonnetModel = SanitizeModel(loaded.Claude.SonnetModel, def.Claude.SonnetModel)
	}
	if loaded.Claude.OpusModel != "" {
		def.Claude.OpusModel = SanitizeModel(loaded.Claude.OpusModel, def.Claude.OpusModel)
	}
	if loaded.Claude.HaikuModel != "" {
		def.Claude.HaikuModel = SanitizeModel(loaded.Claude.HaikuModel, def.Claude.HaikuModel)
	}
	if loaded.Codex.Model != "" {
		def.Codex.Model = SanitizeModel(loaded.Codex.Model, def.Codex.Model)
	}
	if loaded.Codex.WireAPI == "responses" || loaded.Codex.WireAPI == "chat" {
		def.Codex.WireAPI = loaded.Codex.WireAPI
	}
	if loaded.Codex.ApprovalPolicy != "" {
		def.Codex.ApprovalPolicy = loaded.Codex.ApprovalPolicy
	}
	if loaded.Codex.AuthMode == "desktop-direct" || loaded.Codex.AuthMode == "env-key" {
		def.Codex.AuthMode = loaded.Codex.AuthMode
	}
	if loaded.Codex.FallbackUnknownModel != nil {
		def.Codex.FallbackUnknownModel = boolPtr(*loaded.Codex.FallbackUnknownModel)
	}
	if loaded.DSH.Model != "" {
		def.DSH.Model = SanitizeModel(loaded.DSH.Model, def.DSH.Model)
	}
	if loaded.DSH.FallbackModel != "" {
		def.DSH.FallbackModel = SanitizeModel(loaded.DSH.FallbackModel, def.DSH.FallbackModel)
	}
	def.DSH.TelemetryDisabled = loaded.DSH.TelemetryDisabled
	return def
}

// SaveProfiles atomically persists switch-profiles.json in dataDir so Codex/Claude choices survive restarts.
func SaveProfiles(dataDir string, p ProfilesState) error {
	if strings.TrimSpace(dataDir) == "" {
		return nil
	}
	b, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(filepath.Join(dataDir, "switch-profiles.json"), string(b)+"\n", false)
}

func SanitizeModel(val, fallback string) string {
	s := reModelSanitize.ReplaceAllString(strings.TrimSpace(val), "")
	if s == "" {
		return fallback
	}
	return s
}

func SanitizeBaseURL(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "http://127.0.0.1:10087"
	}
	return u.Scheme + "://" + u.Host
}

func SanitizeKey(k string) string {
	r := strings.NewReplacer("\r", "", "\n", "", `"`, "", "'", "", "`", "", "$", "", `\`, "")
	return strings.TrimSpace(r.Replace(k))
}

func resolveHomeConfined(subDir, fileName string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	homeAbs, err := filepath.Abs(home)
	if err != nil {
		return "", err
	}
	dir := filepath.Join(homeAbs, subDir)
	full := filepath.Join(dir, fileName)
	sep := string(os.PathSeparator)
	if !strings.HasPrefix(dir, homeAbs+sep) || !strings.HasPrefix(full, dir+sep) {
		return "", errors.New("目标路径超出用户主目录安全边界")
	}
	return full, nil
}

func snapshotsDir(dataDir string) (string, error) {
	base := dataDir
	if strings.TrimSpace(base) == "" {
		base = "data"
	}
	dir := filepath.Join(base, "switch-snapshots")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	return dir, nil
}

func readFileSafe(p string) (bool, string) {
	b, err := os.ReadFile(p)
	if err != nil {
		return false, ""
	}
	return true, string(b)
}

func writeAtomic(p, content string, sensitive bool) error {
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	var rnd [4]byte
	_, _ = rand.Read(rnd[:])
	tmp := p + "." + hex.EncodeToString(rnd[:]) + ".tmp"
	mode := os.FileMode(0o644)
	if sensitive {
		mode = 0o600
	}
	if err := os.WriteFile(tmp, []byte(content), mode); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

func listSnapshots(dataDir string, agentID AgentID) []snapshot {
	dir, err := snapshotsDir(dataDir)
	if err != nil {
		return nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	prefix := string(agentID) + "-"
	var names []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasPrefix(e.Name(), prefix) && strings.HasSuffix(e.Name(), ".json") {
			names = append(names, e.Name())
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(names)))
	var out []snapshot
	for _, n := range names {
		b, err := os.ReadFile(filepath.Join(dir, n))
		if err != nil {
			continue
		}
		var snap snapshot
		if err := json.Unmarshal(b, &snap); err == nil && snap.AgentID == agentID {
			out = append(out, snap)
		}
	}
	return out
}

func saveSnapshot(dataDir string, agentID AgentID, paths []string) (snapshot, string, error) {
	dir, err := snapshotsDir(dataDir)
	if err != nil {
		return snapshot{}, "", err
	}
	var rnd [3]byte
	_, _ = rand.Read(rnd[:])
	id := fmt.Sprintf("%s-%d-%s", agentID, time.Now().UnixMilli(), hex.EncodeToString(rnd[:]))

	var files []snapshotFile
	for _, p := range paths {
		existed, content := readFileSafe(p)
		sum := sha256.Sum256([]byte(content))
		files = append(files, snapshotFile{
			TargetPath: p,
			Existed:    existed,
			Content:    content,
			SHA256:     hex.EncodeToString(sum[:]),
		})
	}
	snap := snapshot{
		ID:        id,
		AgentID:   agentID,
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
		Files:     files,
	}
	raw, _ := json.MarshalIndent(snap, "", "  ")
	snapPath := filepath.Join(dir, id+".json")
	if err := writeAtomic(snapPath, string(raw), true); err != nil {
		return snapshot{}, "", err
	}
	return snap, snapPath, nil
}

// MergeClaudeSettings performs lossless JSON deep-merge on ~/.claude/settings.json.
func MergeClaudeSettings(existing string, cfg ClaudeProfile, baseURL, apiKey string) (string, []string, []string) {
	origin := SanitizeBaseURL(baseURL)
	token := SanitizeKey(apiKey)
	root := map[string]any{}
	if strings.TrimSpace(existing) != "" {
		_ = json.Unmarshal([]byte(existing), &root)
	}
	var preserved []string
	for k := range root {
		if k != "env" && k != "model" {
			preserved = append(preserved, k)
		}
	}
	envMap := map[string]any{}
	if rawEnv, ok := root["env"].(map[string]any); ok {
		for k, v := range rawEnv {
			envMap[k] = v
		}
	}
	delete(envMap, "ANTHROPIC_API_KEY")
	primary := SanitizeModel(cfg.PrimaryModel, "glm-5.3")
	managed := map[string]string{
		"ANTHROPIC_BASE_URL":                       origin,
		"ANTHROPIC_AUTH_TOKEN":                     token,
		"ANTHROPIC_MODEL":                          primary,
		"ANTHROPIC_DEFAULT_SONNET_MODEL":           SanitizeModel(cfg.SonnetModel, "glm-5.3"),
		"ANTHROPIC_DEFAULT_OPUS_MODEL":             SanitizeModel(cfg.OpusModel, "GLM-5.2"),
		"ANTHROPIC_DEFAULT_HAIKU_MODEL":            SanitizeModel(cfg.HaikuModel, "deepseek-v4.1-flash"),
		"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
	}
	for k := range envMap {
		if _, isManaged := managed[k]; !isManaged {
			preserved = append(preserved, "env."+k)
		}
	}
	modified := []string{"model"}
	for k, v := range managed {
		envMap[k] = v
		modified = append(modified, "env."+k)
	}
	sort.Strings(preserved)
	sort.Strings(modified)
	root["model"] = primary
	root["env"] = envMap
	b, _ := json.MarshalIndent(root, "", "  ")
	return string(b) + "\n", preserved, modified
}

// BuildClaudeOverrideSettingsJSON writes an isolated settings file for `claude --settings <path>`
// so CC Switch's ~/.claude/settings.json env/model are overridden cleanly without editing it.
func BuildClaudeOverrideSettingsJSON(cfg ClaudeProfile, baseURL, apiKey string) string {
	origin := SanitizeBaseURL(baseURL)
	token := SanitizeKey(apiKey)
	if token == "" {
		token = "<YOUR_GATEWAY_API_KEY>"
	}
	primary := SanitizeModel(cfg.PrimaryModel, "glm-5.3")
	payload := map[string]any{
		"model": primary,
		"env": map[string]string{
			"ANTHROPIC_BASE_URL":                       origin,
			"ANTHROPIC_AUTH_TOKEN":                     token,
			"ANTHROPIC_API_KEY":                        "",
			"ANTHROPIC_MODEL":                          primary,
			"ANTHROPIC_DEFAULT_SONNET_MODEL":           SanitizeModel(cfg.SonnetModel, "glm-5.3"),
			"ANTHROPIC_DEFAULT_OPUS_MODEL":             SanitizeModel(cfg.OpusModel, "GLM-5.2"),
			"ANTHROPIC_DEFAULT_HAIKU_MODEL":            SanitizeModel(cfg.HaikuModel, "deepseek-v4.1-flash"),
			"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
		},
	}
	b, _ := json.MarshalIndent(payload, "", "  ")
	return string(b) + "\n"
}

// MergeCodexConfigToml preserves [mcp_servers.*], [projects.*], and other providers.
// desktop-direct (default) writes requires_openai_auth=false + http_headers Authorization so
// Codex Desktop App, VS Code Extension, and CLI all work without OS environment variables.
func MergeCodexConfigToml(existing string, cfg CodexProfile, baseURL, apiKey string) (string, []string, []string) {
	origin := SanitizeBaseURL(baseURL)
	model := SanitizeModel(cfg.Model, "glm-5.3")
	wire := "responses"
	if cfg.WireAPI == "chat" {
		wire = "chat"
	}
	approval := cfg.ApprovalPolicy
	if approval == "" {
		approval = "on-request"
	}
	token := SanitizeKey(apiKey)
	if token == "" {
		token = "<YOUR_GATEWAY_API_KEY>"
	}

	type section struct {
		header string
		lines  []string
	}
	lines := strings.Split(strings.ReplaceAll(existing, "\r\n", "\n"), "\n")
	var topLines []string
	var sections []section
	var cur *section
	for _, line := range lines {
		trim := strings.TrimSpace(line)
		if m := reTomlHeader.FindStringSubmatch(trim); m != nil {
			sections = append(sections, section{header: strings.TrimSpace(m[1]), lines: []string{line}})
			cur = &sections[len(sections)-1]
		} else if cur != nil {
			cur.lines = append(cur.lines, line)
		} else {
			topLines = append(topLines, line)
		}
	}

	managedTop := map[string]bool{"model_provider": true, "model": true, "approval_policy": true}
	var preserved []string
	var keptTop []string
	for _, line := range topLines {
		trim := strings.TrimSpace(line)
		if m := reTomlKV.FindStringSubmatch(trim); m != nil {
			if managedTop[m[1]] {
				continue
			}
			preserved = append(preserved, m[1])
		}
		keptTop = append(keptTop, line)
	}
	for len(keptTop) > 0 && strings.TrimSpace(keptTop[len(keptTop)-1]) == "" {
		keptTop = keptTop[:len(keptTop)-1]
	}
	if len(keptTop) > 0 {
		keptTop = append(keptTop, "")
	}
	keptTop = append(keptTop,
		"# Managed by CodeArts Switch (preserves MCP / projects / other providers)",
		`model_provider = "codearts"`,
		fmt.Sprintf(`model = "%s"`, model),
		fmt.Sprintf(`approval_policy = "%s"`, approval),
	)

	var codeartsSec []string
	if cfg.AuthMode == "env-key" {
		codeartsSec = []string{
			"[model_providers.codearts]",
			`name = "CodeArts Switch"`,
			fmt.Sprintf(`base_url = "%s/v1"`, origin),
			`env_key = "CODEARTS_API_KEY"`,
			fmt.Sprintf(`wire_api = "%s"`, wire),
		}
	} else {
		codeartsSec = []string{
			"[model_providers.codearts]",
			`name = "CodeArts Switch"`,
			fmt.Sprintf(`base_url = "%s/v1"`, origin),
			fmt.Sprintf(`wire_api = "%s"`, wire),
			`requires_openai_auth = false`,
			fmt.Sprintf(`http_headers = { "Authorization" = "Bearer %s" }`, token),
		}
	}

	var keptSections []section
	replaced := false
	for _, sec := range sections {
		if sec.header == "model_providers.codearts" {
			keptSections = append(keptSections, section{header: sec.header, lines: codeartsSec})
			replaced = true
		} else {
			preserved = append(preserved, "["+sec.header+"]")
			cl := append([]string(nil), sec.lines...)
			for len(cl) > 0 && strings.TrimSpace(cl[len(cl)-1]) == "" {
				cl = cl[:len(cl)-1]
			}
			keptSections = append(keptSections, section{header: sec.header, lines: cl})
		}
	}
	if !replaced {
		keptSections = append([]section{{header: "model_providers.codearts", lines: codeartsSec}}, keptSections...)
	}

	blocks := []string{strings.Join(keptTop, "\n")}
	for _, s := range keptSections {
		blocks = append(blocks, strings.Join(s.lines, "\n"))
	}
	return strings.Join(blocks, "\n\n") + "\n", preserved, []string{"model_provider", "model", "approval_policy", "[model_providers.codearts]"}
}

func BuildCodexCCSwitchSnippet(cfg CodexProfile, baseURL, apiKey string) *CodexCCSwitchSnippet {
	origin := SanitizeBaseURL(baseURL)
	model := SanitizeModel(cfg.Model, "glm-5.3")
	wire := "responses"
	if cfg.WireAPI == "chat" {
		wire = "chat"
	}
	token := SanitizeKey(apiKey)
	if token == "" {
		token = "<YOUR_GATEWAY_API_KEY>"
	}
	fullBase := origin + "/v1"
	tomlSnippet := fmt.Sprintf("model_provider = \"codearts\"\nmodel = \"%s\"\n\n[model_providers.codearts]\nname = \"码道 CodeArts\"\nbase_url = \"%s\"\nwire_api = \"%s\"\nrequires_openai_auth = false\nhttp_headers = { \"Authorization\" = \"Bearer %s\" }", model, fullBase, wire, token)
	return &CodexCCSwitchSnippet{
		Name:        "码道 CodeArts",
		BaseURL:     fullBase,
		APIKey:      token,
		WireAPI:     wire,
		Model:       model,
		TomlSnippet: tomlSnippet,
	}
}

func MergeCodexAuthJSON(existing, apiKey string) (string, []string, []string) {
	root := map[string]any{}
	if strings.TrimSpace(existing) != "" {
		_ = json.Unmarshal([]byte(existing), &root)
	}
	var preserved []string
	for k := range root {
		if k != "CODEARTS_API_KEY" {
			preserved = append(preserved, k)
		}
	}
	sort.Strings(preserved)
	root["CODEARTS_API_KEY"] = SanitizeKey(apiKey)
	b, _ := json.MarshalIndent(root, "", "  ")
	return string(b) + "\n", preserved, []string{"CODEARTS_API_KEY"}
}

func escapeCmdValue(v string) string {
	r := strings.NewReplacer("\r", "", "\n", "", `"`, "", "%", "%%")
	return r.Replace(v)
}

func BuildZeroIntrusion(agentID AgentID, profiles ProfilesState, baseURL, apiKey, claudeOverridePath string) ZeroIntrusionLaunchers {
	origin := SanitizeBaseURL(baseURL)
	key := SanitizeKey(apiKey)
	if key == "" {
		key = "<YOUR_GATEWAY_API_KEY>"
	}
	cmdKey := escapeCmdValue(key)
	if agentID == AgentClaude {
		c := profiles.Claude
		p := SanitizeModel(c.PrimaryModel, "glm-5.3")
		overridePath := strings.TrimSpace(claudeOverridePath)
		if overridePath == "" {
			overridePath = "~/.codearts-switch/claude-override.json"
		}
		psPath := strings.ReplaceAll(overridePath, "'", "''")
		shPath := strings.ReplaceAll(overridePath, "'", `'\''`)
		cmdPath := escapeCmdValue(overridePath)
		return ZeroIntrusionLaunchers{
			PowerShell:             fmt.Sprintf(`claude --settings '%s' --model '%s'`, psPath, p),
			Cmd:                    fmt.Sprintf(`claude --settings "%s" --model "%s"`, cmdPath, p),
			Bash:                   fmt.Sprintf(`claude --settings '%s' --model '%s'`, shPath, p),
			AliasName:              "claude-md",
			PowerShellAliasSnippet: fmt.Sprintf("function claude-md {\n  claude --settings '%s' --model '%s' @args\n}", psPath, p),
			CmdAliasSnippet:        fmt.Sprintf("@echo off\nclaude --settings \"%s\" --model \"%s\" %%*", cmdPath, p),
			BashAliasSnippet:       fmt.Sprintf("claude-md() {\n  claude --settings '%s' --model '%s' \"$@\"\n}", shPath, p),
			OverrideSettingsPath:   overridePath,
			HistorySharedNote:      "通过独立覆盖文件 + --settings / --model 命令行高优先级注入，彻底压过 CC Switch 写入 ~/.claude/settings.json 的 env 与 model，同时完全不改写 ~/.claude/settings.json，也不改变 CLAUDE_CONFIG_DIR，100% 双向共享 /resume 历史。",
		}
	}
	if agentID == AgentCodex {
		cx := profiles.Codex
		m := SanitizeModel(cx.Model, "glm-5.3")
		w := "responses"
		if cx.WireAPI == "chat" {
			w = "chat"
		}
		ap := cx.ApprovalPolicy
		if ap == "" {
			ap = "on-request"
		}
		inline := fmt.Sprintf(`{name="CodeArts Switch",base_url="%s/v1",env_key="CODEARTS_API_KEY",wire_api="%s"}`, origin, w)
		cmdArgs := fmt.Sprintf(`codex -c model_provider=codearts -c model=%s -c approval_policy=%s -c model_providers.codearts.name=CodeArtsSwitch -c model_providers.codearts.base_url=%s/v1 -c model_providers.codearts.env_key=CODEARTS_API_KEY -c model_providers.codearts.wire_api=%s`, m, ap, origin, w)
		return ZeroIntrusionLaunchers{
			PowerShell:             fmt.Sprintf(`$env:CODEARTS_API_KEY='%s'; codex -c model_provider="codearts" -c model="%s" -c approval_policy="%s" -c 'model_providers.codearts=%s'`, key, m, ap, inline),
			Cmd:                    fmt.Sprintf(`set "CODEARTS_API_KEY=%s" && %s`, cmdKey, cmdArgs),
			Bash:                   fmt.Sprintf(`CODEARTS_API_KEY='%s' codex -c model_provider="codearts" -c model="%s" -c approval_policy="%s" -c 'model_providers.codearts=%s'`, key, m, ap, inline),
			AliasName:              "codex-md",
			PowerShellAliasSnippet: fmt.Sprintf("function codex-md {\n  $env:CODEARTS_API_KEY='%s'\n  codex -c model_provider=\"codearts\" -c model=\"%s\" -c approval_policy=\"%s\" -c 'model_providers.codearts=%s' @args\n}", key, m, ap, inline),
			CmdAliasSnippet:        fmt.Sprintf("@echo off\nsetlocal\nset \"CODEARTS_API_KEY=%s\"\n%s %%*", cmdKey, cmdArgs),
			BashAliasSnippet:       fmt.Sprintf("codex-md() {\n  CODEARTS_API_KEY='%s' codex -c model_provider=\"codearts\" -c model=\"%s\" -c approval_policy=\"%s\" -c 'model_providers.codearts=%s' \"$@\"\n}", key, m, ap, inline),
			HistorySharedNote:      "保持默认 ~/.codex（不隔离 CODEX_HOME），仅用 -c 命令行覆盖路由。与 CC Switch 零冲突且 100% 双向共享 codex resume 会话记录与 MCP 配置。",
		}
	}
	m := SanitizeModel(profiles.DSH.Model, "deepseek-v4.1-flash")
	return ZeroIntrusionLaunchers{
		PowerShell:             fmt.Sprintf(`$env:OPENAI_BASE_URL='%s/v1'; $env:OPENAI_API_KEY='%s'; dsh web --model '%s'`, origin, key, m),
		Cmd:                    fmt.Sprintf(`set "OPENAI_BASE_URL=%s/v1" && set "OPENAI_API_KEY=%s" && dsh web --model "%s"`, origin, cmdKey, m),
		Bash:                   fmt.Sprintf(`OPENAI_BASE_URL='%s/v1' OPENAI_API_KEY='%s' dsh web --model '%s'`, origin, key, m),
		AliasName:              "dsh-md",
		PowerShellAliasSnippet: fmt.Sprintf("function dsh-md {\n  $env:OPENAI_BASE_URL='%s/v1'\n  $env:OPENAI_API_KEY='%s'\n  dsh web --model '%s' @args\n}", origin, key, m),
		CmdAliasSnippet:        fmt.Sprintf("@echo off\nsetlocal\nset \"OPENAI_BASE_URL=%s/v1\"\nset \"OPENAI_API_KEY=%s\"\ndsh web --model \"%s\" %%*", origin, cmdKey, m),
		BashAliasSnippet:       fmt.Sprintf("dsh-md() {\n  OPENAI_BASE_URL='%s/v1' OPENAI_API_KEY='%s' dsh web --model '%s' \"$@\"\n}", origin, key, m),
		HistorySharedNote:      "共享 ~/.dsh/ 原有会话历史，不覆盖你现有的其他提供商配置。",
	}
}

func ComputeLineDiff(before, after string) []DiffLine {
	var a, b []string
	if before != "" {
		a = strings.Split(strings.ReplaceAll(before, "\r\n", "\n"), "\n")
	}
	if after != "" {
		b = strings.Split(strings.ReplaceAll(after, "\r\n", "\n"), "\n")
	}
	m, n := len(a), len(b)
	dp := make([][]int, m+1)
	for i := range dp {
		dp[i] = make([]int, n+1)
	}
	for i := m - 1; i >= 0; i-- {
		for j := n - 1; j >= 0; j-- {
			if a[i] == b[j] {
				dp[i][j] = dp[i+1][j+1] + 1
			} else if dp[i+1][j] >= dp[i][j+1] {
				dp[i][j] = dp[i+1][j]
			} else {
				dp[i][j] = dp[i][j+1]
			}
		}
	}
	var out []DiffLine
	i, j := 0, 0
	for i < m && j < n {
		if a[i] == b[j] {
			out = append(out, DiffLine{Type: "same", Line: a[i]})
			i++
			j++
		} else if dp[i+1][j] >= dp[i][j+1] {
			out = append(out, DiffLine{Type: "remove", Line: a[i]})
			i++
		} else {
			out = append(out, DiffLine{Type: "add", Line: b[j]})
			j++
		}
	}
	for i < m {
		out = append(out, DiffLine{Type: "remove", Line: a[i]})
		i++
	}
	for j < n {
		out = append(out, DiffLine{Type: "add", Line: b[j]})
		j++
	}
	return out
}

func Detect(dataDir string, agentID AgentID, baseURL string) Detection {
	home, _ := os.UserHomeDir()
	snaps := listSnapshots(dataDir, agentID)
	det := Detection{
		AgentID:        agentID,
		ManagedBy:      "official-or-empty",
		PreservedItems: []string{},
		HasBackup:      len(snaps) > 0,
		BackupCount:    len(snaps),
	}
	if len(snaps) > 0 {
		det.LastBackupAt = snaps[0].CreatedAt
	}
	if agentID == AgentClaude {
		p, _ := resolveHomeConfined(".claude", "settings.json")
		det.ConfigPath = p
		det.HistoryPath = filepath.Join(home, ".claude", "projects")
		exists, content := readFileSafe(p)
		det.ConfigExists = exists
		if exists {
			root := map[string]any{}
			if json.Unmarshal([]byte(content), &root) == nil {
				for k := range root {
					if k != "env" {
						det.PreservedItems = append(det.PreservedItems, k)
					}
				}
				if env, ok := root["env"].(map[string]any); ok {
					if u, ok := env["ANTHROPIC_BASE_URL"].(string); ok {
						det.CurrentBaseURL = u
						if u == SanitizeBaseURL(baseURL) {
							det.ManagedBy = "codearts-switch"
						} else {
							det.ManagedBy = "cc-switch-or-custom"
						}
					}
				}
			}
		}
		return det
	}
	if agentID == AgentCodex {
		p, _ := resolveHomeConfined(".codex", "config.toml")
		det.ConfigPath = p
		det.HistoryPath = filepath.Join(home, ".codex", "sessions")
		exists, content := readFileSafe(p)
		det.ConfigExists = exists
		if exists {
			if strings.Contains(content, `model_provider = "codearts"`) {
				det.ManagedBy = "codearts-switch"
			} else if strings.Contains(content, "model_provider") {
				det.ManagedBy = "cc-switch-or-custom"
			}
		}
		return det
	}
	p, _ := resolveHomeConfined(".dsh", "settings.yaml")
	det.ConfigPath = p
	det.HistoryPath = filepath.Join(home, ".dsh")
	exists, content := readFileSafe(p)
	det.ConfigExists = exists
	if exists {
		if strings.Contains(content, "codearts-switch managed start") {
			det.ManagedBy = "codearts-switch"
		} else {
			det.ManagedBy = "cc-switch-or-custom"
		}
	}
	return det
}

func Preview(agentID AgentID, profiles ProfilesState, baseURL, apiKey string) (PreviewResponse, error) {
	origin := SanitizeBaseURL(baseURL)
	var overridePath string
	if agentID == AgentClaude {
		if p, err := resolveHomeConfined(".codearts-switch", "claude-override.json"); err == nil {
			_ = writeAtomic(p, BuildClaudeOverrideSettingsJSON(profiles.Claude, origin, apiKey), true)
			overridePath = p
		}
	}
	resp := PreviewResponse{
		OK:             true,
		AgentID:        agentID,
		GatewayBaseURL: origin,
		ZeroIntrusion:  BuildZeroIntrusion(agentID, profiles, origin, apiKey, overridePath),
	}
	if agentID == AgentClaude {
		p, err := resolveHomeConfined(".claude", "settings.json")
		if err != nil {
			return resp, err
		}
		_, before := readFileSafe(p)
		after, preserved, modified := MergeClaudeSettings(before, profiles.Claude, origin, apiKey)
		resp.Files = []FilePreview{{
			ID: "claude-settings", Label: "settings.json", TargetPath: p,
			BeforeContent: before, AfterContent: after,
			DiffLines: ComputeLineDiff(before, after), PreservedKeys: preserved, ModifiedKeys: modified,
		}}
		return resp, nil
	}
	if agentID == AgentCodex {
		cfgPath, err := resolveHomeConfined(".codex", "config.toml")
		if err != nil {
			return resp, err
		}
		authPath, err := resolveHomeConfined(".codex", "auth.json")
		if err != nil {
			return resp, err
		}
		_, beforeCfg := readFileSafe(cfgPath)
		_, beforeAuth := readFileSafe(authPath)
		afterCfg, pCfg, mCfg := MergeCodexConfigToml(beforeCfg, profiles.Codex, origin, apiKey)
		afterAuth, pAuth, mAuth := MergeCodexAuthJSON(beforeAuth, apiKey)
		resp.CCSwitchProvider = BuildCodexCCSwitchSnippet(profiles.Codex, origin, apiKey)
		resp.Files = []FilePreview{
			{ID: "codex-config", Label: "config.toml", TargetPath: cfgPath, BeforeContent: beforeCfg, AfterContent: afterCfg, DiffLines: ComputeLineDiff(beforeCfg, afterCfg), PreservedKeys: pCfg, ModifiedKeys: mCfg},
			{ID: "codex-auth", Label: "auth.json", TargetPath: authPath, BeforeContent: beforeAuth, AfterContent: afterAuth, DiffLines: ComputeLineDiff(beforeAuth, afterAuth), PreservedKeys: pAuth, ModifiedKeys: mAuth},
		}
		return resp, nil
	}
	cfgPath, err := resolveHomeConfined(".dsh", "settings.yaml")
	if err != nil {
		return resp, err
	}
	credsPath, err := resolveHomeConfined(".dsh", ".credentials.yaml")
	if err != nil {
		return resp, err
	}
	_, beforeCfg := readFileSafe(cfgPath)
	_, beforeCreds := readFileSafe(credsPath)
	afterCfg := fmt.Sprintf("# >>> codearts-switch managed start >>>\ndefault-model: codearts/%s\nagent-fallback-model: codearts/%s\nproviders:\n  codearts:\n    type: openai-completions\n    base-url: %s/v1\n    api-key-ref: codearts\n# <<< codearts-switch managed end <<<\n",
		SanitizeModel(profiles.DSH.Model, "deepseek-v4.1-flash"),
		SanitizeModel(profiles.DSH.FallbackModel, "glm-5.3"),
		origin,
	)
	afterCreds := fmt.Sprintf("codearts: \"%s\"\n", SanitizeKey(apiKey))
	resp.Files = []FilePreview{
		{ID: "dsh-settings", Label: "settings.yaml", TargetPath: cfgPath, BeforeContent: beforeCfg, AfterContent: afterCfg, DiffLines: ComputeLineDiff(beforeCfg, afterCfg), PreservedKeys: []string{}, ModifiedKeys: []string{"providers.codearts"}},
		{ID: "dsh-credentials", Label: ".credentials.yaml", TargetPath: credsPath, BeforeContent: beforeCreds, AfterContent: afterCreds, DiffLines: ComputeLineDiff(beforeCreds, afterCreds), PreservedKeys: []string{}, ModifiedKeys: []string{"codearts"}},
	}
	return resp, nil
}

func Apply(dataDir string, agentID AgentID, profiles ProfilesState, baseURL, apiKey string) (ApplyResponse, error) {
	prev, err := Preview(agentID, profiles, baseURL, apiKey)
	if err != nil {
		return ApplyResponse{}, err
	}
	var paths []string
	for _, f := range prev.Files {
		paths = append(paths, f.TargetPath)
	}
	snap, snapPath, err := saveSnapshot(dataDir, agentID, paths)
	if err != nil {
		return ApplyResponse{}, err
	}
	var written []string
	for _, f := range prev.Files {
		sensitive := strings.HasSuffix(f.TargetPath, ".json") ||
			strings.HasSuffix(f.TargetPath, ".toml") ||
			strings.HasSuffix(f.TargetPath, ".credentials.yaml")
		if err := writeAtomic(f.TargetPath, f.AfterContent, sensitive); err != nil {
			return ApplyResponse{}, err
		}
		written = append(written, f.TargetPath)
	}
	cli := "claude"
	if agentID == AgentCodex {
		cli = "codex"
	} else if agentID == AgentDSH {
		cli = "dsh web"
	}
	return ApplyResponse{
		OK:           true,
		AgentID:      agentID,
		WrittenFiles: written,
		SnapshotID:   snap.ID,
		SnapshotPath: snapPath,
		CLICommand:   cli,
		Message:      fmt.Sprintf("已无损合并写入 %d 个配置文件并保存快照，随时可一键还原。", len(written)),
	}, nil
}

func Restore(dataDir string, agentID AgentID) (RestoreResponse, error) {
	snaps := listSnapshots(dataDir, agentID)
	if len(snaps) == 0 {
		return RestoreResponse{}, errors.New("未找到该智能体的历史快照")
	}
	latest := snaps[0]
	home, _ := os.UserHomeDir()
	homeAbs, _ := filepath.Abs(home)
	var restored []string
	for _, f := range latest.Files {
		resolved, err := filepath.Abs(f.TargetPath)
		if err != nil || !strings.HasPrefix(resolved, homeAbs+string(os.PathSeparator)) {
			return RestoreResponse{}, errors.New("快照路径越界，已中止还原")
		}
		if f.Existed {
			if err := writeAtomic(resolved, f.Content, true); err != nil {
				return RestoreResponse{}, err
			}
		} else {
			_ = os.Remove(resolved)
		}
		restored = append(restored, resolved)
	}
	if dir, err := snapshotsDir(dataDir); err == nil {
		_ = os.Remove(filepath.Join(dir, latest.ID+".json"))
	}
	return RestoreResponse{
		OK:            true,
		AgentID:       agentID,
		RestoredFiles: restored,
		Message:       "已还原至接管前快照，原有 hooks / MCP / CC Switch 配置已恢复。",
	}, nil
}
