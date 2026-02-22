import { useCallback, useEffect, useMemo, useState } from "react";

import {
  activateGaslightingPromptVersion,
  createGaslightingPromptVersion,
  getGaslightingPrompts,
  testGaslightingPromptStep,
} from "../api";
import { localeCode, t } from "../i18n";
import type { ChatSummary, Locale, PromptStep, PromptTestResponse, PromptThemeState } from "../types";
import { DateRangePicker } from "./DateRangePicker";

interface PromptsPanelProps {
  locale: Locale;
  sessionId: string | null;
  selectedChat: ChatSummary | null;
  range: DateRangeValue;
  onRangeChange: (value: DateRangeValue) => void;
  onTestOutput?: (value: PromptTestResponse | null) => void;
  onTestLoadingChange?: (value: boolean) => void;
}

const STEP_ORDER: PromptStep[] = ["step1", "step2", "step3"];

interface DateRangeValue {
  from?: Date;
  to?: Date;
}

function toStartOfDayTimestamp(date: Date): number {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);
  return value.getTime();
}

function toEndOfDayTimestamp(date: Date): number {
  const value = new Date(date);
  value.setHours(23, 59, 59, 999);
  return value.getTime();
}

export function PromptsPanel({
  locale,
  sessionId,
  selectedChat,
  range,
  onRangeChange,
  onTestOutput,
  onTestLoadingChange,
}: PromptsPanelProps): JSX.Element {
  const [data, setData] = useState<PromptThemeState | null>(null);
  const [selectedStep, setSelectedStep] = useState<PromptStep>("step1");
  const [drafts, setDrafts] = useState<Record<PromptStep, string>>({
    step1: "",
    step2: "",
    step3: "",
  });
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await getGaslightingPrompts();
      setData(next);
      setDrafts((current) => {
        const updated = { ...current };
        for (const step of STEP_ORDER) {
          const state = next.steps.find((item) => item.step === step);
          const active = state?.versions.find((item) => item.isActive) ?? state?.versions[0];
          if (active) {
            updated[step] = active.content;
          }
        }
        return updated;
      });
      setStatus("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t(locale, "prompts.status.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [locale]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedState = useMemo(
    () => data?.steps.find((item) => item.step === selectedStep),
    [data, selectedStep],
  );
  const selectedVersions = selectedState?.versions ?? [];
  const selectedDraft = drafts[selectedStep] ?? "";
  const hasRange = Boolean(range.from && range.to);

  const handleSaveVersion = async (): Promise<void> => {
    if (!selectedDraft.trim()) {
      setStatus(t(locale, "prompts.status.emptyDraft"));
      return;
    }
    setBusy(true);
    try {
      await createGaslightingPromptVersion(selectedStep, selectedDraft);
      await load();
      setStatus(t(locale, "prompts.status.saved"));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t(locale, "prompts.status.saveFailed"));
    } finally {
      setBusy(false);
    }
  };

  const handleActivate = async (versionId: string): Promise<void> => {
    setBusy(true);
    try {
      await activateGaslightingPromptVersion(selectedStep, versionId);
      await load();
      setStatus(t(locale, "prompts.status.activated"));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t(locale, "prompts.status.activateFailed"));
    } finally {
      setBusy(false);
    }
  };

  const handleTest = async (): Promise<void> => {
    if (!sessionId) {
      setStatus(t(locale, "status.failedCreateSession"));
      return;
    }
    if (!selectedChat) {
      setStatus(t(locale, "status.selectChatFirst"));
      return;
    }
    if (!range.from || !range.to) {
      setStatus(t(locale, "status.invalidRange"));
      return;
    }
    if (!selectedDraft.trim()) {
      setStatus(t(locale, "prompts.status.emptyDraft"));
      return;
    }

    setBusy(true);
    setStatus(t(locale, "prompts.status.testing"));
    onTestOutput?.(null);
    onTestLoadingChange?.(true);
    try {
      const result = await testGaslightingPromptStep({
        sessionId,
        chatId: selectedChat.id,
        step: selectedStep,
        prompt: selectedDraft,
        locale,
        startTs: toStartOfDayTimestamp(range.from),
        endTs: toEndOfDayTimestamp(range.to),
      });
      onTestOutput?.(result);
      setStatus(t(locale, "prompts.status.testDone"));
    } catch (error) {
      onTestOutput?.(null);
      setStatus(error instanceof Error ? error.message : t(locale, "prompts.status.testFailed"));
    } finally {
      onTestLoadingChange?.(false);
      setBusy(false);
    }
  };

  return (
    <section className="panel prompts-panel">
      <div className="panel-header">
        <h2>{t(locale, "prompts.title")}</h2>
      </div>

      <div className="prompts-theme-tabs">
        <button type="button" className="secondary prompts-theme-tab active">
          {t(locale, "prompts.theme.gaslighting")}
        </button>
      </div>

      <div className="prompts-step-tabs">
        {STEP_ORDER.map((step) => (
          <button
            key={step}
            type="button"
            className={step === selectedStep ? "prompts-step-tab active" : "secondary prompts-step-tab"}
            onClick={() => setSelectedStep(step)}
            disabled={loading || busy}
          >
            {t(locale, `prompts.${step}`)}
          </button>
        ))}
      </div>

      <div className="prompts-context-block">
        <label>
          {t(locale, "prompts.chat")}
          <input
            value={selectedChat?.title ?? t(locale, "prompts.chatNotSelected")}
            disabled
          />
        </label>
        <label>
          {t(locale, "prompts.dateRange")}
          <DateRangePicker locale={locale} value={range} onChange={onRangeChange} />
        </label>
      </div>

      <label>
        {t(locale, "prompts.editorLabel")}
        <textarea
          className="prompts-editor"
          value={selectedDraft}
          onChange={(event) =>
            setDrafts((current) => ({
              ...current,
              [selectedStep]: event.target.value,
            }))
          }
          disabled={loading || busy}
        />
      </label>

      <div className="prompts-actions">
        <button type="button" onClick={() => void handleSaveVersion()} disabled={loading || busy || !selectedDraft.trim()}>
          {t(locale, "prompts.saveVersion")}
        </button>
        <button
          type="button"
          onClick={() => void handleTest()}
          disabled={loading || busy || !selectedDraft.trim() || !selectedChat || !hasRange}
        >
          {t(locale, "prompts.testStep")}
        </button>
        <button type="button" className="secondary" onClick={() => void load()} disabled={loading || busy}>
          {t(locale, "prompts.reload")}
        </button>
      </div>

      <div className="prompts-versions">
        <h3>{t(locale, "prompts.versions")}</h3>
        {loading ? <p className="muted">{t(locale, "prompts.loading")}</p> : null}
        {!loading && selectedVersions.length === 0 ? <p className="muted">{t(locale, "prompts.empty")}</p> : null}
        {!loading ? (
          <ul className="prompts-version-list">
            {selectedVersions.map((item) => (
              <li key={item.id} className="prompts-version-item">
                <div className="prompts-version-meta">
                  <strong>
                    {t(locale, "prompts.version")} #{item.version}
                  </strong>
                  <span>{new Date(item.createdAt).toLocaleString(localeCode(locale))}</span>
                  {item.isActive ? <span className="prompts-active-badge">{t(locale, "prompts.active")}</span> : null}
                </div>
                <div className="prompts-version-actions">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      setDrafts((current) => ({
                        ...current,
                        [selectedStep]: item.content,
                      }))
                    }
                    disabled={busy}
                  >
                    {t(locale, "prompts.loadToEditor")}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleActivate(item.id)}
                    disabled={busy || item.isActive}
                  >
                    {t(locale, "prompts.setActive")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {status ? <p className="muted">{status}</p> : null}
    </section>
  );
}
