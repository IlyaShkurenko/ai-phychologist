import { modeLabel, t } from "../i18n";
import type { Locale } from "../types";
import type { AnalysisResult } from "../types";

interface ResultPanelProps {
  locale: Locale;
  result: AnalysisResult | null;
}

export function ResultPanel({ locale, result }: ResultPanelProps): JSX.Element {
  if (!result) {
    return (
      <section className="panel result-panel empty">
        <h3>{t(locale, "result.title")}</h3>
        <p>{t(locale, "result.empty")}</p>
      </section>
    );
  }

  return (
    <section className="panel result-panel">
      <h3>{t(locale, "result.title")}</h3>
      <p className="muted">
        {t(locale, "result.mode")}: <strong>{modeLabel(locale, result.mode)}</strong> | {t(locale, "result.messages")}:{" "}
        <strong>{result.messageCount}</strong>
      </p>

      <h4>{t(locale, "result.summary")}</h4>
      <p>{result.summary}</p>

      <h4>{t(locale, "result.redFlags")}</h4>
      <ul>
        {result.keySignals.redFlags.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>

      <h4>{t(locale, "result.greenFlags")}</h4>
      <ul>
        {result.keySignals.greenFlags.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>

      <h4>{t(locale, "result.patterns")}</h4>
      <ul>
        {result.keySignals.patterns.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>

      <h4>{t(locale, "result.suggestedReplies")}</h4>
      <ol>
        {result.suggestedReplies.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ol>

      <h4>{t(locale, "result.outcomes")}</h4>
      <p>
        <strong>{t(locale, "result.ifReply")}:</strong> {result.outcomes.ifReply}
      </p>
      <p>
        <strong>{t(locale, "result.ifNoReply")}:</strong> {result.outcomes.ifNoReply}
      </p>
    </section>
  );
}
