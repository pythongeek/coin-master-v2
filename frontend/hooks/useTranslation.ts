import { useGameStore } from '@/lib/store';
import { TRANSLATIONS, Locale } from '@/utils/translations';

export function useTranslation() {
  const locale = useGameStore((state) => state.locale) as Locale || 'en';

  const t = (key: string): string => {
    // ভাষা ডিকশনারি অনুযায়ী কী বের করো
    const dict = TRANSLATIONS[locale] || TRANSLATIONS['en'];
    if (dict && dict[key]) {
      return dict[key];
    }
    // ফলব্যাক হিসেবে ইংরেজি
    const fallbackDict = TRANSLATIONS['en'];
    return (fallbackDict && fallbackDict[key]) || key;
  };

  return { t, locale };
}
export default useTranslation;
