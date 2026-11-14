import { ArrowDown, ArrowUp, Search, SlidersHorizontal } from 'lucide-react';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ArticleCard } from '../components/ArticleCard';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { listArticles, listTags } from '../services/api';
import { useAppSettings } from '../settings/AppSettingsContext';
import type { ArticleListResponse, ArticleSort, ArticleVisibilityFilter, CanonicalTag, SortDirection } from '../types';
import { agtVisibilityOptions, legacyVisibilityOptions, visibilityFilterValue } from '../visibility';

export function HomePage() {
  const { user, getToken } = useAuth();
  const { settings } = useAppSettings();
  const viewerSub = user?.sub;
  const [searchParams, setSearchParams] = useSearchParams();
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
        const token = viewerSub ? await getToken() : undefined;
        setResult(await listArticles(params, controller.signal, token));
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setError(cause instanceof Error ? cause.message : 'The archive could not be loaded.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [getToken, params, reloadKey, settings.access.allowPublicBrowsing, viewerSub]);

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
        const token = viewerSub ? await getToken() : undefined;
        setTags(await listTags('', controller.signal, token));
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setTagsError(cause instanceof Error ? cause.message : 'Tags could not be loaded.');
      } finally {
        if (!controller.signal.aborted) setTagsLoading(false);
      }
    }
    void loadTagCatalog();
    return () => controller.abort();
  }, [getToken, settings.access.allowPublicBrowsing, tagsReloadKey, viewerSub]);

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
      const token = viewerSub ? await getToken() : undefined;
      const next = await listArticles({ ...params, cursor: result.nextCursor }, undefined, token);
      setResult((current) => current && { ...next, items: [...current.items, ...next.items] });
    } catch (cause) {
      setMoreError(cause instanceof Error ? cause.message : 'More articles could not be loaded.');
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
        <p className="eyebrow">Galactic archive // public terminal</p>
        <div className="hero-heading">
          <div>
            <h1 id="home-title">{settings.site.title}</h1>
            <p>{settings.site.subtitle}</p>
          </div>
          {user && <Link className="button button-primary" to="/articles/new">Create article</Link>}
        </div>
      </section>

      {!user && !settings.access.allowPublicBrowsing ? (
        <section className="admin-panel public-browsing-disabled" aria-labelledby="public-access-title">
          <h2 id="public-access-title">Sign in to browse the archive</h2>
          <p>Public browsing is disabled for this installation.</p>
          <Link className="button button-primary" to="/login">Sign in</Link>
        </section>
      ) : <><section className="filter-panel" aria-labelledby="filter-title">
        <div className="section-label"><SlidersHorizontal aria-hidden="true" /><h2 id="filter-title">Search archive</h2></div>
        <form className="filter-form" onSubmit={handleSearch}>
          <label className="field search-field">
            <span>Search title and content</span>
            <span className="input-with-icon"><Search aria-hidden="true" /><input name="search" defaultValue={params.search} placeholder="e.g. portal navigation" /></span>
          </label>
          <label className="field">
            <span>Tag</span>
            <select
              name="tagId"
              value={params.tagId}
              disabled={tagsLoading || Boolean(tagsError)}
              onChange={(event) => updateParam('tagId', event.target.value)}
            >
              <option value="">All tags</option>
              {selectedTagMissing && <option value={params.tagId}>Unavailable tag</option>}
              {tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
            </select>
            {tagsError && (
              <span className="filter-tag-error">
                Tag filter unavailable.
                <button type="button" onClick={() => setTagsReloadKey((value) => value + 1)}>Retry</button>
              </span>
            )}
          </label>
          <button className="button button-primary" type="submit">Search</button>
        </form>
        <div className="sort-row">
          <label>Visibility
            <select value={params.visibility} onChange={(event) => updateParam('visibility', event.target.value)}>
              <option value="all">All visible</option>
              <optgroup label="AGT standard">
                {agtVisibilityOptions.map((option) => <option key={option.value} value={visibilityFilterValue(option.value)}>{option.label}</option>)}
              </optgroup>
              <optgroup label="Legacy">
                {legacyVisibilityOptions.map((option) => <option key={option.value} value={visibilityFilterValue(option.value)}>{option.label}</option>)}
              </optgroup>
            </select>
          </label>
          <label>Pin status
            <select value={params.pinned} onChange={(event) => updateParam('pinned', event.target.value)}>
              <option value="all">All articles</option>
              <option value="pinned">Pinned only</option>
            </select>
          </label>
          <label>Protection
            <select value={params.protection} onChange={(event) => updateParam('protection', event.target.value)}>
              <option value="all">All articles</option>
              <option value="unprotected">Open to editors</option>
              <option value="protected">Protected</option>
            </select>
          </label>
          <label>Verified
            <select value={params.verification} onChange={(event) => updateParam('verification', event.target.value)}>
              <option value="all">All</option>
              <option value="verified">Verified</option>
              <option value="unverified">Unverified</option>
            </select>
          </label>
          <label>Sort by
            <select value={params.sort} onChange={(event) => updateParam('sort', event.target.value)}>
              <option value="modifiedAt">Last modified</option>
              <option value="createdAt">Creation date</option>
              <option value="title">Title</option>
            </select>
          </label>
          <button
            className="button button-ghost compact"
            type="button"
            onClick={() => updateParam('direction', params.direction === 'asc' ? 'desc' : 'asc')}
            aria-label={`Sort ${params.direction === 'asc' ? 'descending' : 'ascending'}`}
          >
            {params.direction === 'asc' ? <ArrowUp aria-hidden="true" /> : <ArrowDown aria-hidden="true" />}
            {params.direction === 'asc' ? 'Ascending' : 'Descending'}
          </button>
        </div>
      </section>

      <section className="results-section" aria-labelledby="results-title">
        <div className="results-heading">
          <div><p className="eyebrow">Transmissions</p><h2 id="results-title">Published articles</h2></div>
          {result && <p aria-live="polite">{result.total.toLocaleString()} results • {result.items.length.toLocaleString()} shown</p>}
        </div>

        {loading && <LoadingState />}
        {!loading && error && <ErrorState message={error} onRetry={() => setReloadKey((value) => value + 1)} />}
        {!loading && !error && result?.items.length === 0 && <EmptyState filtered={hasFilters} />}
        {!loading && !error && result && result.items.length > 0 && (
          <>
            <div className="article-grid">{result.items.map((article) => <ArticleCard key={article.id} article={article} />)}</div>
            {result.nextCursor && (
              <nav className="pagination" aria-label="More articles">
                <button className="button button-secondary" disabled={loadingMore} onClick={() => void loadMore()}>
                  {loadingMore ? 'Loading…' : 'Load more'}
                </button>
              </nav>
            )}
            {moreError && <div className="inline-alert" role="alert">{moreError}</div>}
          </>
        )}
      </section>
      </>}
    </div>
  );
}
