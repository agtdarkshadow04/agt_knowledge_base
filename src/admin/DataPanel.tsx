import { useCallback, useEffect, useMemo, useState } from 'react';
import { LoadingState } from '../components/States';
import type { ArticleListResponse, ArticleVisibilityFilter } from '../lib/api';
import { agtVisibilityOptions, legacyVisibilityOptions, visibilityClassName, visibilityFilterValue } from '../lib/visibility';
import { formatTranslation } from '../translations';
import { useAdminI18n } from './context';
import { getStats, listArticles } from './api';
import type { AdminStats } from './types';

/** Archive statistics and the inventory of every article, at every visibility level. */
export function DataPanel() {
  const { t, a, number, error: describe } = useAdminI18n();
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [articles, setArticles] = useState<ArticleListResponse | null>(null);
  const [search, setSearch] = useState('');
  const [visibility, setVisibility] = useState<ArticleVisibilityFilter>('all');
  const [protection, setProtection] = useState<'all' | 'protected' | 'unprotected'>('all');
  const [verification, setVerification] = useState<'all' | 'verified' | 'unverified'>('all');
  const [error, setError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);

  const filters = useMemo(() => ({ search, visibility, protection, verification, limit: 50 }), [protection, search, verification, visibility]);

  const load = useCallback(async (signal?: AbortSignal) => {
    const [nextStats, nextArticles] = await Promise.all([getStats(signal), listArticles(filters, signal)]);
    setStats(nextStats);
    setArticles(nextArticles);
  }, [filters]);

  async function loadMore() {
    if (!articles?.nextCursor) return;
    setLoadingMore(true);
    try {
      const next = await listArticles({ ...filters, cursor: articles.nextCursor });
      setArticles((current) => current && { ...next, items: [...current.items, ...next.items] });
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch((cause) => {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setError(describe(cause));
    });
    return () => controller.abort();
  }, [describe, load]);

  if (error) return <p className="error-note" role="alert">{error}</p>;
  if (!stats || !articles) return <LoadingState message={a.data.loading} />;

  return (
    <div className="admin-data-sections">
      <section className="admin-panel" aria-labelledby="stats-title">
        <h2 id="stats-title">{a.data.statsTitle}</h2>
        <dl className="stats-grid">
          {Object.entries(stats).map(([key, value]) => (
            <div key={key}><dt>{a.data.stats[key as keyof AdminStats] ?? key}</dt><dd>{number(value)}</dd></div>
          ))}
        </dl>
      </section>
      <section className="admin-panel" aria-labelledby="inventory-title">
        <div className="admin-panel-heading"><h2 id="inventory-title">{a.data.inventoryTitle}</h2><input aria-label={a.data.search} placeholder={a.data.searchPlaceholder} value={search} onChange={(event) => { setSearch(event.target.value); }} /></div>
        <div className="admin-filters">
          <label className="field"><span>{a.data.visibility}</span><select value={visibility} onChange={(event) => { setVisibility(event.target.value as ArticleVisibilityFilter); }}><option value="all">{a.data.all}</option><optgroup label={t.visibility.agtGroup}>{agtVisibilityOptions.map((option) => <option key={option.value} value={visibilityFilterValue(option.value)}>{t.visibility[option.className]}</option>)}</optgroup><optgroup label={t.visibility.legacyGroup}>{legacyVisibilityOptions.map((option) => <option key={option.value} value={visibilityFilterValue(option.value)}>{t.visibility[option.className]}</option>)}</optgroup></select></label>
          <label className="field"><span>{a.data.protection}</span><select value={protection} onChange={(event) => { setProtection(event.target.value as typeof protection); }}><option value="all">{a.data.all}</option><option value="protected">{a.data.protected}</option><option value="unprotected">{a.data.unprotected}</option></select></label>
          <label className="field"><span>{a.data.verification}</span><select value={verification} onChange={(event) => { setVerification(event.target.value as typeof verification); }}><option value="all">{a.data.all}</option><option value="verified">{a.data.verified}</option><option value="unverified">{a.data.unverified}</option></select></label>
        </div>
        <div className="table-scroll"><table className="admin-table"><thead><tr><th scope="col">{a.data.colTitle}</th><th scope="col">{a.data.colVisibility}</th><th scope="col">{a.data.colVersion}</th><th scope="col">{a.data.colModifiedBy}</th></tr></thead><tbody>
          {articles.items.map((article) => <tr key={article.id}><td>{article.title}</td><td>{t.visibility[visibilityClassName(article.visibility)]}</td><td>{number(article.version)}</td><td>{article.modifiedByName}</td></tr>)}
        </tbody></table></div>
        <p className="field-help">{a.data.memberNeeded}</p>
        <p className="field-help">{formatTranslation(a.data.shown, { shown: number(articles.items.length), total: number(articles.total) })}</p>
        {articles.nextCursor && <nav className="pagination" aria-label={a.data.more}><button className="button button-secondary" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? t.common.loading : a.data.loadMore}</button></nav>}
      </section>
    </div>
  );
}
