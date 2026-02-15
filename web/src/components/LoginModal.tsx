import { FormEvent, useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";

import { t } from "../i18n";
import type { AuthState, Locale } from "../types";

interface LoginModalProps {
  locale: Locale;
  open: boolean;
  authState: AuthState;
  qrLink?: string;
  statusMessage: string | null;
  loading: boolean;
  onSubmitPhone: (phone: string) => Promise<void>;
  onStartQr: () => Promise<void>;
  onSubmitCode: (code: string) => Promise<void>;
  onSubmitPassword: (password: string) => Promise<void>;
}

export function LoginModal({
  locale,
  open,
  authState,
  qrLink,
  statusMessage,
  loading,
  onSubmitPhone,
  onStartQr,
  onSubmitCode,
  onSubmitPassword,
}: LoginModalProps): JSX.Element | null {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [authMethod, setAuthMethod] = useState<"phone" | "qr">("phone");
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    if (authState === "wait_other_device_confirmation") {
      setAuthMethod("qr");
    }
  }, [authState]);

  useEffect(() => {
    if (authMethod !== "qr") {
      setQrDataUrl(null);
      return;
    }

    if (!qrLink) {
      setQrDataUrl(null);
      return;
    }

    let cancelled = false;
    void QRCode.toDataURL(qrLink, {
      margin: 1,
      width: 220,
    }).then((dataUrl) => {
      if (!cancelled) {
        setQrDataUrl(dataUrl);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [authMethod, qrLink]);

  const stepLabel = useMemo(() => {
    switch (authState) {
      case "wait_phone_number":
        return authMethod === "phone" ? t(locale, "login.step.phone") : t(locale, "login.step.qrGenerate");
      case "wait_other_device_confirmation":
        return t(locale, "login.step.qrScan");
      case "wait_code":
        return t(locale, "login.step.code");
      case "wait_password":
        return t(locale, "login.step.password");
      case "ready":
        return t(locale, "login.step.connected");
      default:
        return t(locale, "login.step.auth");
    }
  }, [authMethod, authState, locale]);

  if (!open) {
    return null;
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();

    if (authState === "wait_phone_number" && authMethod === "phone") {
      await onSubmitPhone(phone);
      return;
    }

    if (authState === "wait_code") {
      await onSubmitCode(code);
      return;
    }

    if (authState === "wait_password") {
      await onSubmitPassword(password);
    }
  }

  const canSwitchMethod = authState === "wait_phone_number";

  const showSubmitButton =
    !(authMethod === "qr" && (authState === "wait_phone_number" || authState === "wait_other_device_confirmation"));

  const submitLabel = t(locale, "login.continue");

  const handleSelectPhone = (): void => {
    setAuthMethod("phone");
  };

  const handleSelectQr = (): void => {
    setAuthMethod("qr");
    if (authState === "wait_phone_number" || authState === "wait_other_device_confirmation") {
      void onStartQr();
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal-card">
        <h2>{t(locale, "login.title")}</h2>
        <p className="muted">{stepLabel}</p>

        {canSwitchMethod ? (
          <div className="auth-mode-switch">
            <button
              type="button"
              className={authMethod === "phone" ? "secondary auth-mode active" : "secondary auth-mode"}
              onClick={handleSelectPhone}
            >
              {t(locale, "login.byPhone")}
            </button>
            <button
              type="button"
              className={authMethod === "qr" ? "secondary auth-mode active" : "secondary auth-mode"}
              onClick={handleSelectQr}
            >
              {t(locale, "login.byQr")}
            </button>
          </div>
        ) : null}

        <form onSubmit={handleSubmit}>
          {authMethod === "phone" && authState === "wait_phone_number" ? (
            <label>
              {t(locale, "login.phone")}
              <input
                type="tel"
                placeholder={t(locale, "login.phonePlaceholder")}
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                required
              />
            </label>
          ) : null}

          {authMethod === "qr" && (authState === "wait_phone_number" || authState === "wait_other_device_confirmation") ? (
            <div className="qr-auth-box">
              <p className="muted">{t(locale, "login.openTelegramInstruction")}</p>
              {loading ? <p className="muted">{t(locale, "login.generatingQr")}</p> : null}
              {qrDataUrl ? <img src={qrDataUrl} alt={t(locale, "login.qrAlt")} className="qr-image" /> : null}
            </div>
          ) : null}

          {authState === "wait_code" && (
            <label>
              {t(locale, "login.code")}
              <input
                type="text"
                placeholder={t(locale, "login.codePlaceholder")}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                required
              />
            </label>
          )}

          {authState === "wait_password" && (
            <label>
              {t(locale, "login.password")}
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>
          )}

          {showSubmitButton ? (
            <button type="submit" disabled={loading || authState === "ready"}>
              {loading ? t(locale, "login.submitting") : submitLabel}
            </button>
          ) : null}
        </form>

        {statusMessage && <p className="status-line">{statusMessage}</p>}
      </div>
    </div>
  );
}
