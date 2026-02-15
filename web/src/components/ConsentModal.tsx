import { useState } from "react";

import { t } from "../i18n";
import type { Locale } from "../types";

interface ConsentModalProps {
  locale: Locale;
  open: boolean;
  onAccept: (allowStorage: boolean) => void;
  onCancel: () => void;
}

export function ConsentModal({ locale, open, onAccept, onCancel }: ConsentModalProps): JSX.Element | null {
  const [allowStorage, setAllowStorage] = useState(false);

  if (!open) {
    return null;
  }

  return (
    <div className="modal-backdrop">
      <div className="modal-card">
        <h2>{t(locale, "consent.title")}</h2>
        <p>{t(locale, "consent.body")}</p>

        <label className="checkbox-line">
          <input
            type="checkbox"
            checked={allowStorage}
            onChange={(event) => setAllowStorage(event.target.checked)}
          />
          {t(locale, "consent.allowStorage")}
        </label>

        <p className="muted">{t(locale, "consent.mvp")}</p>

        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onCancel}>
            {t(locale, "consent.cancel")}
          </button>
          <button type="button" onClick={() => onAccept(allowStorage)}>
            {t(locale, "consent.continue")}
          </button>
        </div>
      </div>
    </div>
  );
}
