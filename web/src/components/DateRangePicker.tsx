import { useEffect, useMemo, useRef, useState } from "react";
import { enUS, ru } from "date-fns/locale";
import { DayPicker, type DateRange } from "react-day-picker";

import { localeCode, t } from "../i18n";
import type { Locale } from "../types";

interface DateRangeValue {
  from?: Date;
  to?: Date;
}

interface DateRangePickerProps {
  locale: Locale;
  value: DateRangeValue;
  onChange: (value: DateRangeValue) => void;
}

function formatDate(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(localeCode(locale), {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

export function DateRangePicker({ locale, value, onChange }: DateRangePickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onDocumentClick(event: MouseEvent): void {
      if (!rootRef.current) {
        return;
      }
      const target = event.target as Node;
      if (!rootRef.current.contains(target)) {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", onDocumentClick);
    return () => {
      document.removeEventListener("mousedown", onDocumentClick);
    };
  }, []);

  const label = useMemo(() => {
    if (value.from && value.to) {
      return `${formatDate(value.from, locale)} - ${formatDate(value.to, locale)}`;
    }
    if (value.from) {
      return `${formatDate(value.from, locale)} - ...`;
    }
    return t(locale, "dateRange.select");
  }, [locale, value.from, value.to]);

  const selected: DateRange | undefined =
    value.from || value.to
      ? {
          from: value.from,
          to: value.to,
        }
      : undefined;

  return (
    <div className="range-picker" ref={rootRef}>
      <button type="button" className="range-picker-trigger secondary" onClick={() => setOpen((prev) => !prev)}>
        {label}
      </button>

      {open ? (
        <div className="range-picker-popover">
          <DayPicker
            locale={locale === "ru" ? ru : enUS}
            mode="range"
            selected={selected}
            defaultMonth={value.from ?? new Date()}
            onSelect={(next) => {
              const updated: DateRangeValue = {
                from: next?.from,
                to: next?.to,
              };
              onChange(updated);

              if (updated.from && updated.to) {
                setOpen(false);
              }
            }}
            showOutsideDays
            numberOfMonths={1}
          />

          <div className="range-picker-actions">
            <button
              type="button"
              className="secondary"
              onClick={() => {
                onChange({});
              }}
            >
              {t(locale, "dateRange.clear")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
