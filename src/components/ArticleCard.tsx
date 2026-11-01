import { BadgeCheck, CalendarClock, LockKeyhole, Pin } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { ArticleSummary } from '../types';
import { TagChip } from './TagChip';
import { VisibilityChip } from './VisibilityChip';

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(value));
}

export function ArticleCard({ article }: { article: ArticleSummary }) {
  return (
    <article className="article-card">
      <div className="article-card-heading">
        <div>
          <p className="eyebrow">Archive entry</p>
          <h2><Link to={`/articles/${article.id}`}>{article.title}</Link></h2>
        </div>
      </div>
      <div className="article-card-status">
        <VisibilityChip visibility={article.visibility} />
        {article.isVerified && (
          <span className="status-chip verified"><BadgeCheck aria-hidden="true" /> Verified</span>
        )}
        {article.isPinned && (
          <span className="status-chip pinned"><Pin aria-hidden="true" /> Pinned</span>
        )}
        {article.isProtected && (
          <span className="status-chip protected"><LockKeyhole aria-hidden="true" /> Protected</span>
        )}
      </div>
      <p className="excerpt">{article.excerpt || 'Open this transmission to read the full article.'}</p>
      <div className="tag-list" aria-label="Article tags">
        {article.tags.map((tag) => <TagChip key={tag.id} tag={tag} />)}
      </div>
      <footer className="article-card-meta">
        <span><CalendarClock aria-hidden="true" /> Updated {formatDate(article.modifiedAt)}</span>
        <span>by {article.modifiedByName}</span>
      </footer>
    </article>
  );
}
