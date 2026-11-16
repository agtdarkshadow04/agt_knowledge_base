import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from './AuthContext';
import { ArticleCard } from './ArticleCard';
import { EmptyState, ErrorState, LoadingState } from './States';
import { listArticles, listTags } from '../lib/memberApi';
import { useAppSettings } from './AppSettingsContext';
import type { ArticleListResponse, ArticleSort, ArticleVisibilityFilter, CanonicalTag, SortDirection } from '../lib/api';
import { agtVisibilityOptions, legacyVisibilityOptions, visibilityFilterValue } from '../lib/visibility';
import { ArrowDownIcon, ArrowUpIcon, SearchIcon, SlidersHorizontalIcon } from './Icons';
import { Link, useNavigation } from './Navigation';
import { loginHref } from './RequireAuth';
import { routeHref } from '../lib/routes';
import { formatTranslation } from '../translations';
import { useI18n } from './I18n';

export function HomePage() {
  const { user } = useAuth();
  const { settings } = useAppSettings();
  const { t, number, error: describe } = useI18n();
  const viewerSub = user?.sub;
  const { params: searchParams, navigate } = useNavigation();
  const setSearchParams = useCallback((next: URLSearchParams) => {
    navigate(routeHref({ page: 'home' }, next));
  }, [navigate]);
  const [result, setResult] = useState<ArticleListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState('');
  const [tags, setTags] = useState<CanonicalTag[]>([]);
  const [tagsLoading, setTagsLoading] = useState(true);
  const [tagsError, setTagsError] = useState('');
  const [tagsReloadKey, setTagsReloadKey] = useState(0);
  const queryString = searchParams.toString();

  const params = useMemo(() => {
    const current = new URLSearchParams(queryString);
    return {
      search: current.get('search') ?? '',
      tagId: current.get('tagId') ?? '',
      visibility: (current.get('visibility') ?? 'all') as ArticleVisibilityFilter,
      pinned: (current.get('pinned') ?? 'all') as 'all' | 'pinned',
      protection: (current.get('protection') ?? 'all') as 'all' | 'protected' | 'unprotected',
      verification: (current.get('verification') ?? 'all') as 'all' | 'verified' | 'unverified',
      sort: (current.get('sort') ?? 'modifiedAt') as ArticleSort,
      direction: (current.get('direction') ?? 'desc') as SortDirection,
      limit: 12,
    };
  }, [queryString]);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      if (!viewerSub && !settings.access.allowPublicBrowsing) {
        setResult(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      setError('');
      setMoreError('');
      try {
        setResult(await listArticles(params, controller.signal, Boolean(viewerSub)));
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setError(describe(cause));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [params, reloadKey, settings.access.allowPublicBrowsing, viewerSub]);

  useEffect(() => {
    const controller = new AbortController();
    async function loadTagCatalog() {
      if (!viewerSub && !settings.access.allowPublicBrowsing) {
        setTags([]);
        setTagsLoading(false);
        return;
      }
      setTagsLoading(true);
      setTagsError('');
      try {
        setTags(await listTags('', controller.signal, Boolean(viewerSub)));
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setTagsError(describe(cause));
      } finally {
        if (!controller.signal.aborted) setTagsLoading(false);
      }
    }
    void loadTagCatalog();
    return () => controller.abort();
  }, [settings.access.allowPublicBrowsing, tagsReloadKey, viewerSub]);

  const updateParam = useCallback((key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value && value !== 'all') next.set(key, value); else next.delete(key);
    next.delete('page');
    setSearchParams(next);
  }, [searchParams, setSearchParams]);

  /** Appends the next page; the cursor keeps pages from overlapping while articles change (API-8). */
  async function loadMore() {
    if (!result?.nextCursor) return;
    setLoadingMore(true);
    setMoreError('');
    try {
      const next = await listArticles({ ...params, cursor: result.nextCursor }, undefined, Boolean(viewerSub));
      setResult((current) => current && { ...next, items: [...current.items, ...next.items] });
    } catch (cause) {
      setMoreError(describe(cause));
    } finally {
      setLoadingMore(false);
    }
  }

  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const next = new URLSearchParams(searchParams);
    for (const key of ['search']) {
      const value = String(data.get(key) ?? '').trim();
      if (value) next.set(key, value); else next.delete(key);
    }
    next.delete('page');
    setSearchParams(next);
  }

  const hasFilters = Boolean(params.search || params.tagId || params.visibility !== 'all' || params.pinned !== 'all' || params.protection !== 'all' || params.verification !== 'all');
  const selectedTagMissing = Boolean(params.tagId && !tags.some((tag) => tag.id === params.tagId));

  return (
    <div className="page home-page">
      <section className="hero" aria-labelledby="home-title">
        <p className="eyebrow">{t.home.eyebrow}</p>
        <div className="hero-heading">
          <div>
            <h1 id="home-title">{settings.site.title}</h1>
            <p>{settings.site.subtitle}</p>
          </div>
          {user && <Link className="button button-primary" to={routeHref({ page: 'new' })}>{t.home.createArticle}</Link>}
        </div>
      </section>

      {!user && !settings.access.allowPublicBrowsing ? (
        <section className="admin-panel public-browsing-disabled" aria-labelledby="public-access-title">
          <h2 id="public-access-title">{t.home.closedTitle}</h2>
          <p>{t.home.closedText}</p>
          <Link className="button button-primary" to={loginHref()}>{t.home.signIn}</Link>
        </section>
      ) : <><section className="filter-panel" aria-labelledby="filter-title">
        <div className="section-label"><SlidersHorizontalIcon aria-hidden="true" /><h2 id="filter-title">{t.home.filterTitle}</h2></div>
        <form className="filter-form" onSubmit={handleSearch}>
          <label className="field search-field">
            <span>{t.home.search}</span>
            <span className="input-with-icon"><SearchIcon aria-hidden="true" /><input name="search" defaultValue={params.search} placeholder={t.home.searchPlaceholder} /></span>
          </label>
          <label className="field">
            <span>{t.home.tag}</span>
            <select
              name="tagId"
              value={params.tagId}
              disabled={tagsLoading || Boolean(tagsError)}
              onChange={(event) => updateParam('tagId', event.target.value)}
            >
              <option value="">{t.home.allTags}</option>
              {selectedTagMissing && <option value={params.tagId}>{t.home.unavailableTag}</option>}
              {tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
            </select>
            {tagsError && (
              <span className="filter-tag-error">
                {t.home.tagFilterUnavailable}
                <button type="button" onClick={() => setTagsReloadKey((value) => value + 1)}>{t.home.retry}</button>
              </span>
            )}
          </label>
          <button className="button button-primary" type="submit">{t.home.submit}</button>
        </form>
        <div className="sort-row">
          <label>{t.home.visibility}
            <select value={params.visibility} onChange={(event) => updateParam('visibility', event.target.value)}>
              <option value="all">{t.home.allVisible}</option>
              <optgroup label={t.visibility.agtGroup}>
                {agtVisibilityOptions.map((option) => <option key={option.value} value={visibilityFilterValue(option.value)}>{t.visibility[option.className]}</option>)}
              </optgroup>
              <optgroup label={t.visibility.legacyGroup}>
                {legacyVisibilityOptions.map((option) => <option key={option.value} value={visibilityFilterValue(option.value)}>{t.visibility[option.className]}</option>)}
              </optgroup>
            </select>
          </label>
          <label>{t.home.pinStatus}
            <select value={params.pinned} onChange={(event) => updateParam('pinned', event.target.value)}>
              <option value="all">{t.home.allArticles}</option>
              <option value="pinned">{t.home.pinnedOnly}</option>
            </select>
          </label>
          <label>{t.home.protection}
            <select value={params.protection} onChange={(event) => updateParam('protection', event.target.value)}>
              <option value="all">{t.home.allArticles}</option>
              <option value="unprotected">{t.home.unprotected}</option>
              <option value="protected">{t.home.protected}</option>
            </select>
          </label>
          <label>{t.home.verified}
            <select value={params.verification} onChange={(event) => updateParam('verification', event.target.value)}>
              <option value="all">{t.home.all}</option>
              <option value="verified">{t.home.verifiedOnly}</option>
              <option value="unverified">{t.home.unverifiedOnly}</option>
            </select>
          </label>
          <label>{t.home.sortBy}
            <select value={params.sort} onChange={(event) => updateParam('sort', event.target.value)}>
              <option value="modifiedAt">{t.home.sortModified}</option>
              <option value="createdAt">{t.home.sortCreated}</option>
              <option value="title">{t.home.sortTitle}</option>
            </select>
          </label>
          <button
            className="button button-ghost compact"
            type="button"
            onClick={() => updateParam('direction', params.direction === 'asc' ? 'desc' : 'asc')}
            aria-label={params.direction === 'asc' ? t.home.sortDescending : t.home.sortAscending}
          >
            {params.direction === 'asc' ? <ArrowUpIcon aria-hidden="true" /> : <ArrowDownIcon aria-hidden="true" />}
            {params.direction === 'asc' ? t.home.ascending : t.home.descending}
          </button>
        </div>
      </section>

      <section className="results-section" aria-labelledby="results-title">
        <div className="results-heading">
          <div><p className="eyebrow">{t.home.resultsEyebrow}</p><h2 id="results-title">{t.home.resultsTitle}</h2></div>
          {result && <p aria-live="polite">{formatTranslation(t.home.resultCount, { total: number(result.total), shown: number(result.items.length) })}</p>}
        </div>

        {loading && <LoadingState />}
        {!loading && error && <ErrorState message={error} onRetry={() => setReloadKey((value) => value + 1)} />}
        {!loading && !error && result?.items.length === 0 && <EmptyState filtered={hasFilters} />}
        {!loading && !error && result && result.items.length > 0 && (
          <>
            <div className="article-grid">{result.items.map((article) => <ArticleCard key={article.id} article={article} />)}</div>
            {result.nextCursor && (
              <nav className="pagination" aria-label={t.home.moreArticles}>
                <button className="button button-secondary" disabled={loadingMore} onClick={() => void loadMore()}>
                  {loadingMore ? t.common.loading : t.home.loadMore}
                </button>
              </nav>
            )}
            {moreError && <p className="error-note" role="alert">{moreError}</p>}
          </>
        )}
      </section>
      </>}
    </div>
  );
}
