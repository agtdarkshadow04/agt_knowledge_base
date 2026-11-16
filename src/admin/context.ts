import { useI18n } from '../components/I18n';
import { getAdminTranslations } from './i18n';

/** The shared i18n value (language, formatters, public strings as `t`) plus the admin strings as `a`. */
export function useAdminI18n() {
  const i18n = useI18n();
  return { ...i18n, a: getAdminTranslations(i18n.locale) };
}
