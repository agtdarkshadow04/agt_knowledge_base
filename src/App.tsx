import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { RequireAuth } from './auth/RequireAuth';
import { RequireAdmin } from './auth/RequireAdmin';
import { SetupGate } from './auth/SetupGate';
import { Layout } from './components/Layout';
import { ArticlePage } from './pages/ArticlePage';
import { ArticleHistoryPage } from './pages/ArticleHistoryPage';
import { EditorPage } from './pages/EditorPage';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';
import { AdminPage } from './pages/AdminPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { SetupPage } from './pages/SetupPage';

const router = createBrowserRouter([
  {
    element: <SetupGate><Layout /></SetupGate>,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'login', element: <LoginPage /> },
      { path: 'setup', element: <SetupPage /> },
      { path: 'admin', element: <RequireAdmin><AdminPage /></RequireAdmin> },
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
