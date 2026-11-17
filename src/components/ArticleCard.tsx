import type { ArticleSummary } from '../lib/api';
import { routeHref } from '../lib/routes';
import { formatTranslation } from '../translations';
import { useI18n } from './I18n';
import { BadgeCheckIcon, CalendarClockIcon, LockKeyholeIcon, PinIcon } from './Icons';
import { Link } from './Navigation';
import { TagChip } from './TagChip';
import { VisibilityChip } from './VisibilityChip';

export function ArticleCard({ article }: { article: ArticleSummary }) {
  const { t, date } = useI18n();
  return (
    <article className="article-card">
      <div className="article-card-heading">
        <div>
          <p className="eyebrow">{t.card.eyebrow}</p>
          <h2><Link to={routeHref({ page: 'article', id: article.id })}>{article.title}</Link></h2>
        </div>
      </div>
      <div className="article-card-status">
        <VisibilityChip visibility={article.visibility} />
        {article.isVerified && <span className="status-chip verified"><BadgeCheckIcon /> {t.status.verified}</span>}
        {article.isPinned && <span className="status-chip pinned"><PinIcon /> {t.status.pinned}</span>}
        {article.isProtected && <span className="status-chip protected"><LockKeyholeIcon /> {t.status.protected}</span>}
      </div>
      <p className="excerpt">{article.excerpt || t.card.noExcerpt}</p>
      <div className="tag-list" role="group" aria-label={t.card.tags}>
        {article.tags.map((tag) => <TagChip key={tag.id} tag={tag} />)}
      </div>
      <footer className="article-card-meta">
        <span><CalendarClockIcon /> {formatTranslation(t.card.updated, { date: date(article.modifiedAt) })}</span>
        <span>{formatTranslation(t.card.by, { name: article.modifiedByName })}</span>
      </footer>
    </article>
  );
}
