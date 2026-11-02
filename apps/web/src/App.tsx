import { Navigate, Outlet, Route, Routes } from 'react-router';
import { useMe } from './api/auth';
import { AppShell } from './components/AppShell';
import { AuthPage } from './pages/AuthPage';
import { DashboardPage } from './pages/DashboardPage';
import { NewProjectPage } from './pages/NewProjectPage';
import { MediaLibraryPage } from './pages/MediaLibraryPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { ProjectLayout, ProjectSettingsPage } from './pages/ProjectPage';

function RequireAuth() {
  const me = useMe();
  if (me.isPending) return null;
  if (me.isError) return <NotFoundPage title="Can't reach the server" detail={me.error.message} />;
  if (!me.data) return <Navigate to="/login" replace />;
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
      <Route element={<RequireAuth />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/projects/new" element={<NewProjectPage />} />
        <Route path="/projects/:id" element={<ProjectLayout />}>
          <Route index element={<MediaLibraryPage />} />
          <Route path="settings" element={<ProjectSettingsPage />} />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
