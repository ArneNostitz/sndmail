import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { useAccountStore } from "@/stores/accountStore";
import { getSecureSetting, getSetting, setSecureSetting, setSetting } from "@/services/db/settings";
import { PROVIDER_MODELS, resolveModelId } from "@/services/ai/types";
import { Section } from "../SettingsSection";
import { SettingRow } from "../SettingRow";
import { SelectField } from "../SelectField";
import { ToggleRow } from "../ToggleRow";

type AiProvider = "claude" | "openai" | "gemini" | "ollama" | "copilot";

const AUTO_ARCHIVE_CATEGORIES = ["Updates", "Promotions", "Social", "Newsletters"] as const;

/** Provider, key and model, then which AI features are switched on. */
export function IntelligenceTab() {
  const accounts = useAccountStore((s) => s.accounts);

  const [aiProvider, setAiProvider] = useState<AiProvider>("claude");
  const [claudeApiKey, setClaudeApiKey] = useState("");
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [geminiApiKey, setGeminiApiKey] = useState("");
  const [copilotApiKey, setCopilotApiKey] = useState("");
  const [ollamaServerUrl, setOllamaServerUrl] = useState("http://localhost:11434");
  const [ollamaModel, setOllamaModel] = useState("llama3.2");
  const [claudeModel, setClaudeModel] = useState("claude-haiku-4-5-20251001");
  const [openaiModel, setOpenaiModel] = useState("gpt-4o-mini");
  const [geminiModel, setGeminiModel] = useState("gemini-3.8-flash");
  const [copilotModel, setCopilotModel] = useState("openai/gpt-4o-mini");
  const [aiEnabled, setAiEnabled] = useState(true);
  const [aiAutoCategorize, setAiAutoCategorize] = useState(true);
  const [aiAutoSummarize, setAiAutoSummarize] = useState(true);
  const [aiKeySaved, setAiKeySaved] = useState(false);
  const [aiTesting, setAiTesting] = useState(false);
  const [aiTestResult, setAiTestResult] = useState<"success" | "fail" | null>(null);
  const [aiAutoDraftEnabled, setAiAutoDraftEnabled] = useState(true);
  const [aiWritingStyleEnabled, setAiWritingStyleEnabled] = useState(true);
  const [styleAnalyzing, setStyleAnalyzing] = useState(false);
  const [styleAnalyzeDone, setStyleAnalyzeDone] = useState(false);
  const [autoArchiveCategories, setAutoArchiveCategories] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    async function load() {
      const provider = await getSetting("ai_provider");
      if (provider === "openai" || provider === "gemini" || provider === "ollama" || provider === "copilot") setAiProvider(provider);
      const ollamaUrl = await getSetting("ollama_server_url");
      if (ollamaUrl) setOllamaServerUrl(ollamaUrl);
      const ollamaModelVal = await getSetting("ollama_model");
      if (ollamaModelVal) setOllamaModel(ollamaModelVal);
      const claudeModelVal = await getSetting("claude_model");
      if (claudeModelVal) setClaudeModel(claudeModelVal);
      const openaiModelVal = await getSetting("openai_model");
      if (openaiModelVal) setOpenaiModel(openaiModelVal);
      const geminiModelVal = await getSetting("gemini_model");
      if (geminiModelVal) setGeminiModel(resolveModelId(geminiModelVal));
      setClaudeApiKey((await getSecureSetting("claude_api_key")) ?? "");
      setOpenaiApiKey((await getSecureSetting("openai_api_key")) ?? "");
      setGeminiApiKey((await getSecureSetting("gemini_api_key")) ?? "");
      setCopilotApiKey((await getSecureSetting("copilot_api_key")) ?? "");
      const copilotModelVal = await getSetting("copilot_model");
      if (copilotModelVal) setCopilotModel(copilotModelVal);
      setAiEnabled((await getSetting("ai_enabled")) !== "false");
      setAiAutoCategorize((await getSetting("ai_auto_categorize")) !== "false");
      setAiAutoSummarize((await getSetting("ai_auto_summarize")) !== "false");
      setAiAutoDraftEnabled((await getSetting("ai_auto_draft_enabled")) !== "false");
      setAiWritingStyleEnabled((await getSetting("ai_writing_style_enabled")) !== "false");

      const autoArchive = await getSetting("auto_archive_categories");
      if (autoArchive) {
        setAutoArchiveCategories(new Set(autoArchive.split(",").map((s) => s.trim()).filter(Boolean)));
      }
    }
    load();
  }, []);

  const handleTestConnection = async () => {
    setAiTesting(true);
    setAiTestResult(null);
    try {
      const { testConnection } = await import("@/services/ai/aiService");
      const ok = await testConnection();
      setAiTestResult(ok ? "success" : "fail");
    } catch {
      setAiTestResult("fail");
    } finally {
      setAiTesting(false);
    }
  };

  const apiKey = aiProvider === "claude" ? claudeApiKey
    : aiProvider === "openai" ? openaiApiKey
    : aiProvider === "copilot" ? copilotApiKey
    : geminiApiKey;

  const testResult = (
    <>
      {aiTestResult === "success" && (
        <span className="text-xs text-success">Connected!</span>
      )}
      {aiTestResult === "fail" && (
        <span className="text-xs text-danger">Connection failed</span>
      )}
    </>
  );

  return (
    <>
      <Section title="Provider">
        <p className="text-xs text-text-tertiary mb-3">
          Choose which AI provider to use for summarization, compose assistance, and smart categorization.
        </p>
        <SettingRow label="AI Provider">
          <SelectField
            value={aiProvider}
            options={[
              { value: "claude", label: "Claude (Anthropic)" },
              { value: "openai", label: "OpenAI" },
              { value: "gemini", label: "Gemini (Google)" },
              { value: "ollama", label: "Local AI (Ollama / LMStudio)" },
              { value: "copilot", label: "GitHub Copilot" },
            ]}
            onChange={async (val) => {
              setAiProvider(val);
              setAiTestResult(null);
              await setSetting("ai_provider", val);
              const { clearProviderClients } = await import("@/services/ai/providerManager");
              clearProviderClients();
            }}
          />
        </SettingRow>
        <p className="text-xs text-text-tertiary">
          {aiProvider === "claude" && `Uses ${PROVIDER_MODELS.claude.find((m) => m.id === claudeModel)?.label ?? claudeModel}.`}
          {aiProvider === "openai" && `Uses ${PROVIDER_MODELS.openai.find((m) => m.id === openaiModel)?.label ?? openaiModel}.`}
          {aiProvider === "gemini" && `Uses ${PROVIDER_MODELS.gemini.find((m) => m.id === geminiModel)?.label ?? geminiModel}.`}
          {aiProvider === "ollama" && "Connect to a local Ollama or LMStudio server. No API key required."}
          {aiProvider === "copilot" && `Uses ${PROVIDER_MODELS.copilot.find((m) => m.id === copilotModel)?.label ?? copilotModel}. Requires a GitHub PAT with models:read permission.`}
        </p>
      </Section>

      {aiProvider === "ollama" ? (
        <Section title="Local Server">
          <div className="space-y-3">
            <TextField
              label="Server URL"
              size="md"
              value={ollamaServerUrl}
              onChange={(e) => setOllamaServerUrl(e.target.value)}
              placeholder="http://localhost:11434"
            />
            <TextField
              label="Model Name"
              size="md"
              value={ollamaModel}
              onChange={(e) => setOllamaModel(e.target.value)}
              placeholder="llama3.2"
            />
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                size="md"
                onClick={async () => {
                  await setSetting("ollama_server_url", ollamaServerUrl.trim());
                  await setSetting("ollama_model", ollamaModel.trim());
                  const { clearProviderClients } = await import("@/services/ai/providerManager");
                  clearProviderClients();
                  setAiKeySaved(true);
                  setTimeout(() => setAiKeySaved(false), 2000);
                }}
                disabled={!ollamaServerUrl.trim() || !ollamaModel.trim()}
              >
                {aiKeySaved ? "Saved!" : "Save"}
              </Button>
              <Button
                variant="secondary"
                size="md"
                onClick={handleTestConnection}
                disabled={!ollamaServerUrl.trim() || !ollamaModel.trim() || aiTesting}
                className="bg-bg-tertiary text-text-primary border border-border-primary"
              >
                {aiTesting ? "Testing..." : "Test Connection"}
              </Button>
              {testResult}
            </div>
          </div>
        </Section>
      ) : (
        <Section title="API Key">
          <div className="space-y-3">
            <TextField
              label={
                aiProvider === "claude" ? "Anthropic API Key"
                : aiProvider === "openai" ? "OpenAI API Key"
                : aiProvider === "copilot" ? "GitHub Personal Access Token"
                : "Google AI API Key"
              }
              size="md"
              type="password"
              value={apiKey}
              onChange={(e) => {
                if (aiProvider === "claude") setClaudeApiKey(e.target.value);
                else if (aiProvider === "openai") setOpenaiApiKey(e.target.value);
                else if (aiProvider === "copilot") setCopilotApiKey(e.target.value);
                else setGeminiApiKey(e.target.value);
              }}
              placeholder={
                aiProvider === "claude" ? "sk-ant-..."
                : aiProvider === "openai" ? "sk-..."
                : aiProvider === "copilot" ? "ghp_..."
                : "AI..."
              }
            />
            <SettingRow label="Model">
              <SelectField
                value={
                  aiProvider === "claude" ? claudeModel
                  : aiProvider === "openai" ? openaiModel
                  : aiProvider === "copilot" ? copilotModel
                  : geminiModel
                }
                options={PROVIDER_MODELS[aiProvider].map((m) => ({ value: m.id, label: m.label }))}
                onChange={async (val) => {
                  const modelSettingMap = {
                    claude: "claude_model",
                    openai: "openai_model",
                    gemini: "gemini_model",
                    copilot: "copilot_model",
                  } as const;
                  if (aiProvider === "claude") setClaudeModel(val);
                  else if (aiProvider === "openai") setOpenaiModel(val);
                  else if (aiProvider === "copilot") setCopilotModel(val);
                  else setGeminiModel(val);
                  await setSetting(modelSettingMap[aiProvider], val);
                  const { clearProviderClients } = await import("@/services/ai/providerManager");
                  clearProviderClients();
                }}
              />
            </SettingRow>
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                size="md"
                onClick={async () => {
                  const keySettingMap = {
                    claude: "claude_api_key",
                    openai: "openai_api_key",
                    gemini: "gemini_api_key",
                    copilot: "copilot_api_key",
                  } as const;
                  const keyValue = apiKey.trim();
                  if (keyValue) {
                    await setSecureSetting(keySettingMap[aiProvider], keyValue);
                    const { clearProviderClients } = await import("@/services/ai/providerManager");
                    clearProviderClients();
                  }
                  setAiKeySaved(true);
                  setTimeout(() => setAiKeySaved(false), 2000);
                }}
                disabled={!apiKey.trim()}
              >
                {aiKeySaved ? "Saved!" : "Save Key"}
              </Button>
              <Button
                variant="secondary"
                size="md"
                onClick={handleTestConnection}
                disabled={!apiKey.trim() || aiTesting}
                className="bg-bg-tertiary text-text-primary border border-border-primary"
              >
                {aiTesting ? "Testing..." : "Test Connection"}
              </Button>
              {testResult}
            </div>
          </div>
        </Section>
      )}

      <Section title="Features">
        <ToggleRow
          label="Enable AI features"
          description="Master toggle for all AI functionality"
          checked={aiEnabled}
          onToggle={async () => {
            const newVal = !aiEnabled;
            setAiEnabled(newVal);
            await setSetting("ai_enabled", newVal ? "true" : "false");
          }}
        />
        <ToggleRow
          label="Auto-categorize inbox"
          description="Use AI to refine rule-based categorization"
          checked={aiAutoCategorize}
          onToggle={async () => {
            const newVal = !aiAutoCategorize;
            setAiAutoCategorize(newVal);
            await setSetting("ai_auto_categorize", newVal ? "true" : "false");
          }}
        />
        <ToggleRow
          label="Auto-summarize threads"
          description="Show AI summaries on multi-message threads"
          checked={aiAutoSummarize}
          onToggle={async () => {
            const newVal = !aiAutoSummarize;
            setAiAutoSummarize(newVal);
            await setSetting("ai_auto_summarize", newVal ? "true" : "false");
          }}
        />
      </Section>

      <Section title="Auto-Draft Replies">
        <ToggleRow
          label="Auto-draft replies"
          description="Pre-populate the reply editor with an AI-generated draft"
          checked={aiAutoDraftEnabled}
          onToggle={async () => {
            const newVal = !aiAutoDraftEnabled;
            setAiAutoDraftEnabled(newVal);
            await setSetting("ai_auto_draft_enabled", newVal ? "true" : "false");
          }}
        />
        <ToggleRow
          label="Learn writing style"
          description="Analyze your sent emails to match your tone and voice"
          checked={aiWritingStyleEnabled}
          onToggle={async () => {
            const newVal = !aiWritingStyleEnabled;
            setAiWritingStyleEnabled(newVal);
            await setSetting("ai_writing_style_enabled", newVal ? "true" : "false");
          }}
        />
        {aiWritingStyleEnabled && (
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sm text-text-secondary">Writing style profile</span>
              <p className="text-xs text-text-tertiary mt-0.5">
                Reanalyze your writing style from recent sent emails
              </p>
            </div>
            <Button
              variant="secondary"
              size="md"
              onClick={async () => {
                setStyleAnalyzing(true);
                setStyleAnalyzeDone(false);
                try {
                  const activeId = accounts.find((a) => a.isActive)?.id;
                  if (activeId) {
                    const { refreshWritingStyle } = await import("@/services/ai/writingStyleService");
                    await refreshWritingStyle(activeId);
                    setStyleAnalyzeDone(true);
                    setTimeout(() => setStyleAnalyzeDone(false), 3000);
                  }
                } catch (err) {
                  console.error("Style analysis failed:", err);
                } finally {
                  setStyleAnalyzing(false);
                }
              }}
              disabled={styleAnalyzing}
              className="bg-bg-tertiary text-text-primary border border-border-primary"
            >
              {styleAnalyzing ? "Analyzing..." : styleAnalyzeDone ? "Done!" : "Reanalyze"}
            </Button>
          </div>
        )}
      </Section>

      <Section title="Categories">
        <p className="text-xs text-text-tertiary mb-1">
          Incoming emails are automatically sorted using rule-based heuristics (Gmail labels, sender domain, headers). When AI is enabled, it refines results for better accuracy.
        </p>
        <p className="text-xs text-text-tertiary mb-3">
          Enable auto-archive to skip the inbox for specific categories.
        </p>
        {AUTO_ARCHIVE_CATEGORIES.map((cat) => (
          <ToggleRow
            key={cat}
            label={`Auto-archive ${cat}`}
            description={`Skip inbox for ${cat.toLowerCase()} emails`}
            checked={autoArchiveCategories.has(cat)}
            onToggle={async () => {
              const next = new Set(autoArchiveCategories);
              if (next.has(cat)) next.delete(cat);
              else next.add(cat);
              setAutoArchiveCategories(next);
              await setSetting("auto_archive_categories", [...next].join(","));
            }}
          />
        ))}
      </Section>
    </>
  );
}
