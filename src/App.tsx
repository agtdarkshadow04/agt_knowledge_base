import { ArticleHistoryPage } from './components/ArticleHistoryPage';
import { ArticlePage } from './components/ArticlePage';
import { EditorPage } from './components/EditorPage';
import { HomePage } from './components/HomePage';
import { Layout } from './components/Layout';
import { LoginPage } from './components/LoginPage';
import { useNavigation } from './components/Navigation';
import { NotFoundPage } from './components/NotFoundPage';
import { RequireAuth } from './components/RequireAuth';
import { RequireModerator } from './components/RequireModerator';
import { TagsPage } from './components/TagsPage';

/**
 * The member UI picks its page from the query string (FE-4, `src/lib/routes.ts`).
 * The admin panel is a separate entry (admin.html) at /admin, never part of this bundle (FE-1).
 */
function Page() {
  const { route } = useNavigation();
  switch (route.page) {
    case 'home': return <HomePage />;
    case 'login': return <LoginPage />;
    case 'tags': return <RequireModerator><TagsPage /></RequireModerator>;
    case 'new': return <RequireAuth><EditorPage key="new" /></RequireAuth>;
    case 'article': return <ArticlePage key={route.id} id={route.id} />;
    case 'history': return <RequireAuth><ArticleHistoryPage key={route.id} id={route.id} /></RequireAuth>;
    case 'edit': return <RequireAuth><EditorPage key={route.id} id={route.id} /></RequireAuth>;
    case 'notFound': return <NotFoundPage />;
  }
}

export function App() {
  return <Layout><Page /></Layout>;
}
