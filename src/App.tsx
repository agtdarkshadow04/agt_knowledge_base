import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { RequireAuth } from './auth/RequireAuth';
import { RequireModerator } from './auth/RequireModerator';
import { Layout } from './components/Layout';
import { ArticlePage } from './pages/ArticlePage';
import { ArticleHistoryPage } from './pages/ArticleHistoryPage';
import { EditorPage } from './pages/EditorPage';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { TagsPage } from './pages/TagsPage';

// The admin panel is a separate entry (admin.html) served at /admin; it is
// deliberately not part of this router or bundle.
const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'login', element: <LoginPage /> },
      // Loaded on demand so the bundled API description stays out of the main chunk.
      { path: 'api-docs', lazy: async () => ({ Component: (await import('./pages/ApiDocsPage')).ApiDocsPage }) },
      { path: 'tags', element: <RequireModerator><TagsPage /></RequireModerator> },
      { path: 'articles/:id', element: <ArticlePage /> },
      { path: 'articles/:id/history', element: <RequireAuth><ArticleHistoryPage /></RequireAuth> },
      { path: 'articles/new', element: <RequireAuth><EditorPage /></RequireAuth> },
      { path: 'articles/:id/edit', element: <RequireAuth><EditorPage /></RequireAuth> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
