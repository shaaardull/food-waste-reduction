/**
 * i18n setup for the diner PWA.
 *
 * Phase 2 multi-language support (CLAUDE.md §9): English (default),
 * Hindi, Marathi. The locale JSON files under src/locales/ are the only
 * place user-facing copy may live (CLAUDE.md §0).
 *
 * Detection order: localStorage → navigator → fallback. The user's
 * explicit pick from the Profile screen is persisted via the same
 * localStorage key.
 */
import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';

import en from '../locales/en.json';
import hi from '../locales/hi.json';
import mr from '../locales/mr.json';

export const SUPPORTED_LANGUAGES = ['en', 'hi', 'mr'] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

export const LANGUAGE_LABELS: Record<Language, string> = {
  en: 'English',
  hi: 'हिन्दी',
  mr: 'मराठी',
};

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      hi: { translation: hi },
      mr: { translation: mr },
    },
    fallbackLng: 'en',
    supportedLngs: SUPPORTED_LANGUAGES,
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage', 'navigator', 'htmlTag'],
      caches: ['localStorage'],
      lookupLocalStorage: 'plate_clean_locale',
    },
    returnNull: false,
  });

export default i18n;
