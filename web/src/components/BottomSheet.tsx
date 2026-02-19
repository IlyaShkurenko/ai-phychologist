import { useMemo, useState } from "react";

import {
  behaviorPatternIds,
  behaviorPatternLabel,
  focusIds,
  focusLabel,
  goalPresetIds,
  goalPresetText,
  helpMeLabel,
  helpMeOptionIds,
  modeLabel,
  t,
} from "../i18n";
import type { AnalysisConfig, AnalysisMode, Locale } from "../types";

interface BottomSheetProps {
  locale: Locale;
  config: AnalysisConfig;
  mode: AnalysisMode;
  loading: boolean;
  onChangeConfig: (next: AnalysisConfig) => void;
  onChangeMode: (mode: AnalysisMode) => void;
  onSend: () => void;
}

export function BottomSheet({
  locale,
  config,
  mode,
  loading,
  onChangeConfig,
  onChangeMode,
  onSend,
}: BottomSheetProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [customFocusInput, setCustomFocusInput] = useState("");

  const mergedFocus = useMemo(() => {
    const set = new Set([...focusIds, ...config.focus]);
    return [...set];
  }, [config.focus]);

  function toggleArrayValue(values: string[], value: string): string[] {
    if (values.includes(value)) {
      return values.filter((item) => item !== value);
    }
    return [...values, value];
  }

  function addCustomFocus(): void {
    const value = customFocusInput.trim();
    if (!value) {
      return;
    }
    if (!config.focus.includes(value)) {
      onChangeConfig({
        ...config,
        focus: [...config.focus, value],
      });
    }
    setCustomFocusInput("");
  }

  function clearAllExceptGoal(): void {
    onChangeConfig({
      theme: "",
      behaviorPatterns: [],
      focus: [],
      goal: config.goal,
      helpMeToggles: [],
      helpMeText: "",
    });
  }

  if (hidden) {
    return (
      <button
        type="button"
        className="sheet-reopen-button"
        onClick={() => {
          setHidden(false);
          setExpanded(true);
        }}
      >
        {t(locale, "sheet.reopen")}
      </button>
    );
  }

  return (
    <section className={expanded ? "bottom-sheet expanded" : "bottom-sheet"}>
      <div className="sheet-header">
        <button type="button" className="sheet-toggle" onClick={() => setExpanded((prev) => !prev)}>
          {expanded ? t(locale, "sheet.hide") : t(locale, "sheet.show")}
        </button>
        <button type="button" className="sheet-close-button" onClick={() => setHidden(true)}>
          {t(locale, "sheet.close")}
        </button>
      </div>

      <div className="sheet-content">
        <div className="sheet-row">
          <label>
            {t(locale, "sheet.theme")}
            <select
              value={config.theme ?? ""}
              onChange={(event) =>
                onChangeConfig({
                  ...config,
                  theme: event.target.value as AnalysisConfig["theme"],
                })
              }
            >
              <option value="">{t(locale, "sheet.theme.none")}</option>
              <option value="Love">{t(locale, "sheet.theme.love")}</option>
              <option value="Work">{t(locale, "sheet.theme.work")}</option>
              <option value="Friendship">{t(locale, "sheet.theme.friendship")}</option>
              <option value="Gaslighting">{t(locale, "sheet.theme.gaslighting")}</option>
            </select>
          </label>

          <label>
            {t(locale, "sheet.inputMode")}
            <select value={mode} onChange={(event) => onChangeMode(event.target.value as AnalysisMode)}>
              <option value="last300">{modeLabel(locale, "last300")}</option>
              <option value="range">{modeLabel(locale, "range")}</option>
              <option value="selected">{modeLabel(locale, "selected")}</option>
            </select>
          </label>
        </div>

        <div className="sheet-section">
          <p>{t(locale, "sheet.behaviorPatterns")}</p>
          <div className="chips-wrap">
            {behaviorPatternIds.map((pattern) => (
              <button
                key={pattern}
                type="button"
                className={config.behaviorPatterns.includes(pattern) ? "chip selected" : "chip"}
                onClick={() =>
                  onChangeConfig({
                    ...config,
                    behaviorPatterns: toggleArrayValue(config.behaviorPatterns, pattern),
                  })
                }
              >
                {behaviorPatternLabel(locale, pattern)}
              </button>
            ))}
          </div>
        </div>

        <div className="sheet-section">
          <p>{t(locale, "sheet.focus")}</p>
          <div className="chips-wrap">
            {mergedFocus.map((item) => (
              <button
                key={item}
                type="button"
                className={config.focus.includes(item) ? "chip selected" : "chip"}
                onClick={() =>
                  onChangeConfig({
                    ...config,
                    focus: toggleArrayValue(config.focus, item),
                  })
                }
              >
                {focusLabel(locale, item)}
              </button>
            ))}
          </div>

          <div className="inline-input-row">
            <input
              type="text"
              placeholder={t(locale, "sheet.addCustomFocus")}
              value={customFocusInput}
              onChange={(event) => setCustomFocusInput(event.target.value)}
            />
            <button type="button" onClick={addCustomFocus}>
              {t(locale, "sheet.add")}
            </button>
          </div>
        </div>

        <div className="sheet-row">
          <label>
            {t(locale, "sheet.goalPreset")}
            <select
              value={
                goalPresetIds.map((item) => goalPresetText(locale, item)).includes(config.goal)
                  ? config.goal
                  : ""
              }
              onChange={(event) =>
                onChangeConfig({
                  ...config,
                  goal: event.target.value,
                })
              }
            >
              <option value="">{t(locale, "sheet.goalPreset.custom")}</option>
              {goalPresetIds.map((presetId) => {
                const presetText = goalPresetText(locale, presetId);
                return (
                  <option key={presetId} value={presetText}>
                    {presetText}
                  </option>
                );
              })}
            </select>
          </label>

          <label>
            {t(locale, "sheet.goalText")}
            <input
              type="text"
              value={config.goal}
              onChange={(event) =>
                onChangeConfig({
                  ...config,
                  goal: event.target.value,
                })
              }
              placeholder={t(locale, "sheet.goalPlaceholder")}
            />
          </label>
        </div>

        <div className="sheet-section">
          <p>{t(locale, "sheet.helpMe")}</p>
          <div className="chips-wrap">
            {helpMeOptionIds.map((option) => (
              <button
                key={option}
                type="button"
                className={config.helpMeToggles.includes(option) ? "chip selected" : "chip"}
                onClick={() =>
                  onChangeConfig({
                    ...config,
                    helpMeToggles: toggleArrayValue(config.helpMeToggles, option),
                  })
                }
              >
                {helpMeLabel(locale, option)}
              </button>
            ))}
          </div>
          <textarea
            value={config.helpMeText ?? ""}
            onChange={(event) =>
              onChangeConfig({
                ...config,
                helpMeText: event.target.value,
              })
            }
            placeholder={t(locale, "sheet.helpMeNote")}
            rows={2}
          />
        </div>

        <div className="sheet-actions">
          <button type="button" className="secondary" onClick={clearAllExceptGoal}>
            {t(locale, "sheet.clearExceptGoal")}
          </button>
          <button type="button" onClick={onSend} disabled={loading}>
            {loading ? t(locale, "sheet.sending") : t(locale, "sheet.send")}
          </button>
        </div>
      </div>
    </section>
  );
}
