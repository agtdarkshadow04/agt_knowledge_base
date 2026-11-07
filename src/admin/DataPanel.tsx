import { useCallback, useEffect, useState } from 'react';
import { LoadingState } from '../components/States';
import type { ArticleListResponse, ArticleVisibilityFilter } from '../types';
import { agtVisibilityOptions, legacyVisibilityOptions, visibilityFilterValue, visibilityLabel } from '../visibility';
import { getStats, listArticles } from './api';
import type { AdminStats } from './types';

/** Archive statistics and the inventory of every article, at every visibility level. */
export function DataPanel() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [articles, setArticles] = useState<ArticleListResponse | null>(null);
  const [search, setSearch] = useState('');
  const [visibility, setVisibility] = useState<ArticleVisibilityFilter>('all');
  const [protection, setProtection] = useState<'all' | 'protected' | 'unprotected'>('all');
  const [verification, setVerification] = useState<'all' | 'verified' | 'unverified'>('all');
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');

  const load = useCallback(async (signal?: AbortSignal) => {
    const [nextStats, nextArticles] = await Promise.all([
      getStats(signal),
      listArticles({ search, visibility, protection, verification, page, pageSize: 50 }, signal),
    ]);
    setStats(nextStats);
    setArticles(nextArticles);
  }, [page, protection, search, verification, visibility]);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch((cause) => {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setError(cause instanceof Error ? cause.message : 'Archive data could not be loaded.');
    });
    return () => controller.abort();
  }, [load]);

  if (error) return <div className="inline-alert" role="alert">{error}</div>;
  if (!stats || !articles) return <LoadingState message="Loading archive data…" />;

  return (
    <div className="admin-data-sections">
      <section className="admin-panel" aria-labelledby="stats-title">
        <h2 id="stats-title">Archive statistics</h2>
        <dl className="stats-grid">
          {Object.entries(stats).map(([key, value]) => (
            <div key={key}><dt>{key.replace(/([A-Z])/g, ' $1')}</dt><dd>{value.toLocaleString()}</dd></div>
          ))}
        </dl>
      </section>
      <section className="admin-panel" aria-labelledby="inventory-title">
        <div className="admin-panel-heading"><h2 id="inventory-title">Article inventory</h2><input aria-label="Search article inventory" placeholder="Search articles" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} /></div>
        <div className="admin-filters">
          <label className="field"><span>Visibility</span><select value={visibility} onChange={(event) => { setVisibility(event.target.value as ArticleVisibilityFilter); setPage(1); }}><option value="all">All</option><optgroup label="AGT standard">{agtVisibilityOptions.map((option) => <option key={option.value} value={visibilityFilterValue(option.value)}>{option.label}</option>)}</optgroup><optgroup label="Legacy">{legacyVisibilityOptions.map((option) => <option key={option.value} value={visibilityFilterValue(option.value)}>{option.label}</option>)}</optgroup></select></label>
          <label className="field"><span>Protection</span><select value={protection} onChange={(event) => { setProtection(event.target.value as typeof protection); setPage(1); }}><option value="all">All</option><option value="protected">Protected</option><option value="unprotected">Unprotected</option></select></label>
          <label className="field"><span>Verification</span><select value={verification} onChange={(event) => { setVerification(event.target.value as typeof verification); setPage(1); }}><option value="all">All</option><option value="verified">Verified</option><option value="unverified">Unverified</option></select></label>
        </div>
        <div className="table-scroll"><table className="admin-table"><thead><tr><th>Title</th><th>Visibility</th><th>Version</th><th>Last modified by</th></tr></thead><tbody>
          {articles.items.map((article) => <tr key={article.id}><td>{article.title}</td><td>{visibilityLabel(article.visibility)}</td><td>{article.version}</td><td>{article.modifiedByName}</td></tr>)}
        </tbody></table></div>
        <p className="field-help">Editing articles needs a member account: the Admin account cannot sign in to the knowledge base itself.</p>
        {articles.totalPages > 1 && <nav className="pagination" aria-label="Article inventory pages"><button className="button button-secondary" disabled={articles.page <= 1} onClick={() => setPage((current) => current - 1)}>Previous</button><span>Page {articles.page} of {articles.totalPages}</span><button className="button button-secondary" disabled={articles.page >= articles.totalPages} onClick={() => setPage((current) => current + 1)}>Next</button></nav>}
      </section>
    </div>
  );
}
