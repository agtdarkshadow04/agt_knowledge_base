import { useI18n } from './I18n';
import { Link } from './Navigation';

export function NotFoundPage() {
  const { t } = useI18n();
  return (
    <div className="page state-panel">
      <p className="eyebrow">{t.notFound.eyebrow}</p>
      <h1>{t.notFound.title}</h1>
      <p>{t.notFound.text}</p>
      <Link className="button button-primary" to="/">{t.notFound.home}</Link>
    </div>
  );
}
