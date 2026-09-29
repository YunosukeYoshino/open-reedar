import { createContext, useContext, useMemo } from "react";
import { t } from "../shared/i18n";
import type { MessageKey } from "../shared/i18n";
import type { Language } from "../shared/schema";

const LangContext = createContext<Language>("en");
export const LangProvider = LangContext.Provider;

export function useLang() { return useContext(LangContext); }

export function useT() {
  const lang = useContext(LangContext);
  return (key: MessageKey, params?: Record<string, string | number>) => t(lang, key, params);
}

export function useFormatters() {
  const lang = useContext(LangContext);
  return useMemo(() => {
    const locale = lang === "ja" ? "ja-JP" : "en-US";
    return {
      shortDate: new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }),
      fullDate: new Intl.DateTimeFormat(locale, { year: "numeric", month: "long", day: "numeric" }),
      time: new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }),
    };
  }, [lang]);
}
