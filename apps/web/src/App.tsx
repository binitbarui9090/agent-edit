import { Navigate, Outlet, Route, Routes } from 'react-router';
import { useMe } from './api/auth';
import { AppShell } from './components/AppShell';
import { AuthPage } from './pages/AuthPage';
import { AnalysisPage } from './pages/AnalysisPage';
import { DashboardPage } from './pages/DashboardPage';
import { EditorPage } from './pages/EditorPage';
import { NewProjectPage } from './pages/NewProjectPage';
import { MediaLibraryPage } from './pages/MediaLibraryPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { ProjectLayout, ProjectSettingsPage } from './pages/ProjectPage';

/** The editor takes the whole window, so it brings its own bar instead of the app's. */
function RequireAuth({ bare = false }: { bare?: boolean }) {
  const me = useMe();
  if (me.isPending) return null;
  if (me.isError) return <NotFoundPage title="Can't reach the server" detail={me.error.message} />;
  if (!me.data) return <Navigate to="/login" replace />;
  if (bare) return <Outlet />;
  return (
    <AppShell user={me.data}>
      <Outlet />
    </AppShell>
  );
}

function PublicOnly() {
  const me = useMe();
  if (me.isPending) return null;
  if (me.data) return <Navigate to="/" replace />;
  return <Outlet />;
}

export function App() {
  return (
    <Routes>
      <Route element={<PublicOnly />}>
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="/register" element={<AuthPage mode="register" />} />
      </Route>
      <Route element={<RequireAuth bare />}>
        <Route path="/projects/:id/edit" element={<EditorPage />} />
        <Route path="/projects/:id/edit/:timelineId" element={<EditorPage />} />
      </Route>
      <Route element={<RequireAuth />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/projects/new" element={<NewProjectPage />} />
        <Route path="/projects/:id" element={<ProjectLayout />}>
          <Route index element={<MediaLibraryPage />} />
          <Route path="analysis" element={<AnalysisPage />} />
          <Route path="settings" element={<ProjectSettingsPage />} />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
