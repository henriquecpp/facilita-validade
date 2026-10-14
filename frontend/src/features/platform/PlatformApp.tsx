import { useState, type FormEvent } from 'react';
import {
  Link,
  NavLink,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import { Alert, Button, CircularProgress, Snackbar, TextField, Typography } from '@mui/material';
import { useQueryClient } from '@tanstack/react-query';
import type { PlatformAdmin } from '../../shared/api/types';
import { APP_NAME } from '../../shared/lib/app';
import { ErrorState, Icon, Loading, PageTitle, Wordmark } from '../../shared/ui/components';
import { MobileSidebar, useMobileSidebar } from '../../shared/ui/MobileSidebar';
import { ME, platformApi, usePlatformMutation, usePlatformSession } from './api';
import { HistoryPage } from './HistoryPage';
import { StorePage, StoresPage } from './StoresPages';

/**
 * Painel da plataforma (super admin), em /platform: quem opera o serviço para todas as
 * lojas. Sessão própria, por cookie, à parte da sessão de loja; carregado só quando aberto.
 */
export default function PlatformApp() {
  return (
    <Routes>
      <Route path="login" element={<PlatformLogin />} />
      <Route element={<PlatformLayout />}>
        <Route index element={<StoresPage />} />
        <Route path="stores/:storeId" element={<StorePage />} />
        <Route path="history" element={<HistoryPage />} />
        <Route path="password" element={<PlatformPassword />} />
        <Route path="*" element={<Navigate to="/platform" replace />} />
      </Route>
    </Routes>
  );
}

function PlatformLayout() {
  const session = usePlatformSession();
  const location = useLocation();
  const sidebar = useMobileSidebar();
  if (session.isPending) return <Loading />;
  if (session.isError)
    return (
      <main className="platform-content">
        <ErrorState error={session.error} retry={() => void session.refetch()} />
      </main>
    );
  const admin = session.data;
  if (!admin) return <Navigate to="/platform/login" replace />;
  if (admin.mustChangePassword && location.pathname !== '/platform/password')
    return <Navigate to="/platform/password" replace />;
  return (
    <div className="platform-layout">
      {sidebar.mobile && !admin.mustChangePassword && (
        <MobileSidebar
          id="platform-mobile-menu"
          label="Menu da plataforma"
          open={sidebar.open}
          close={sidebar.close}
        >
          <Link className="wordmark" to="/platform" aria-label={`${APP_NAME}, plataforma`}>
            <Wordmark />
          </Link>
          <nav className="platform-mobile-nav" aria-label="Plataforma">
            <NavLink to="/platform" end>
              Lojas
            </NavLink>
            <NavLink to="/platform/history">Histórico</NavLink>
            <NavLink to="/platform/password">Trocar senha</NavLink>
          </nav>
        </MobileSidebar>
      )}
      <header className="platform-header">
        {sidebar.mobile && !admin.mustChangePassword && (
          <button
            type="button"
            className="icon-button mobile-menu"
            aria-label="Abrir menu"
            aria-expanded={sidebar.open}
            aria-controls="platform-mobile-menu"
            aria-haspopup="dialog"
            onClick={sidebar.show}
          >
            <Icon name="menu" />
          </button>
        )}
        <Link className="wordmark" to="/platform" aria-label={`${APP_NAME}, plataforma`}>
          <Wordmark />
        </Link>
        <span className="platform-badge">Plataforma</span>
        {!admin.mustChangePassword && !sidebar.mobile && (
          <nav className="platform-nav" aria-label="Plataforma">
            <NavLink to="/platform" end>
              Lojas
            </NavLink>
            <NavLink to="/platform/history">Histórico</NavLink>
          </nav>
        )}
        <div className="session-actions">
          <span className="user-identification">
            <strong>{admin.username}</strong>
            <small>Administrador da plataforma</small>
          </span>
          {!admin.mustChangePassword && (
            <Button component={Link} to="/platform/password" size="small" className="hide-mobile">
              Trocar senha
            </Button>
          )}
          <LogoutButton />
        </div>
      </header>
      <main className="platform-content">
        <Outlet />
      </main>
    </div>
  );
}

/** Só sai depois de o servidor encerrar a sessão: sem confirmação, o cookie ainda valeria. */
function LogoutButton() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const logout = async () => {
    setBusy(true);
    setError('');
    try {
      await platformApi('/auth/logout', { method: 'POST', body: '{}' });
      client.removeQueries({ queryKey: ['platform'] });
      client.setQueryData(ME, null);
      navigate('/platform/login', { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível sair. Tente de novo.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button size="small" disabled={busy} onClick={() => void logout()}>
        Sair
      </Button>
      <Snackbar
        open={!!error}
        message={error}
        autoHideDuration={6000}
        onClose={() => setError('')}
      />
    </>
  );
}

function PlatformLogin() {
  const session = usePlatformSession();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (session.data)
    return (
      <Navigate to={session.data.mustChangePassword ? '/platform/password' : '/platform'} replace />
    );
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!username.trim() || !password) {
      setError('Informe usuário e senha.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const admin = await platformApi<PlatformAdmin>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: username.trim(), password }),
      });
      client.removeQueries({ queryKey: ['platform'] });
      client.setQueryData(ME, admin);
      navigate(admin.mustChangePassword ? '/platform/password' : '/platform', { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível entrar.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="login-layout">
      <section className="login-story platform-story">
        <div className="wordmark" aria-label={APP_NAME}>
          <Wordmark />
        </div>
        <div>
          <span className="eyebrow light">PLATAFORMA</span>
          <h1>
            Todas as lojas,
            <br />
            num lugar só.
          </h1>
          <p>Cada loja enxerga só os próprios dados. Daqui, a operação cuida de todas.</p>
          <ul className="story-points">
            <li>Cadastre lojas e proprietários</li>
            <li>Suspenda e reative, com o motivo registrado</li>
            <li>Devolva o acesso a quem o perdeu</li>
          </ul>
        </div>
        <small>ACESSO RESTRITO À EQUIPE DA PLATAFORMA</small>
      </section>
      <section className="login-form-area">
        <div className="login-card">
          <span className="eyebrow">PAINEL DA PLATAFORMA</span>
          <Typography variant="h4" sx={{ fontWeight: 700, mt: 1, mb: 1 }}>
            Administração
          </Typography>
          <Typography color="text.secondary" sx={{ mb: 4 }}>
            Para a equipe que administra as lojas. Quem trabalha numa loja entra pelo{' '}
            <Link className="text-link" to="/login">
              painel da loja
            </Link>
            .
          </Typography>
          <form onSubmit={(event) => void submit(event)} noValidate className="form-stack">
            {error && <Alert severity="error">{error}</Alert>}
            <TextField
              label="Usuário"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
            <TextField
              label="Senha"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <Button type="submit" variant="contained" size="large" disabled={busy} sx={{ py: 1.6 }}>
              {busy ? (
                <>
                  <CircularProgress size={18} color="inherit" sx={{ mr: 1 }} />
                  Entrando…
                </>
              ) : (
                'Entrar na plataforma'
              )}
            </Button>
          </form>
        </div>
      </section>
    </main>
  );
}

function PlatformPassword() {
  const session = usePlatformSession();
  const client = useQueryClient();
  const navigate = useNavigate();
  const change = usePlatformMutation<
    { currentPassword: string; newPassword: string },
    PlatformAdmin
  >('/auth/change-password');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const required = !!session.data?.mustChangePassword;
  const short = !!next && next.length < 12;
  const mismatch = !!confirm && confirm !== next;
  const ready = !!current && next.length >= 12 && next.length <= 128 && confirm === next;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    change.mutate(
      { currentPassword: current, newPassword: next },
      {
        onSuccess: (admin) => {
          client.setQueryData(ME, admin);
          navigate('/platform', { replace: true });
        },
      },
    );
  };
  return (
    <>
      <PageTitle
        title={required ? 'Defina sua senha' : 'Trocar senha'}
        description={
          required
            ? 'Antes de começar, troque a senha provisória por uma só sua.'
            : 'Outras sessões abertas com o seu usuário serão encerradas.'
        }
        back={required ? undefined : { to: '/platform', label: 'Lojas' }}
      />
      <section className="surface narrow">
        <form className="form-stack" onSubmit={submit} noValidate>
          <TextField
            label={required ? 'Senha provisória' : 'Senha atual'}
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
          />
          <TextField
            label="Nova senha"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
            error={short}
            helperText={short ? 'Pelo menos 12 caracteres.' : 'De 12 a 128 caracteres.'}
            slotProps={{ htmlInput: { maxLength: 128 } }}
          />
          <TextField
            label="Repita a nova senha"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            error={mismatch}
            helperText={mismatch ? 'As duas senhas não são iguais.' : undefined}
          />
          {change.error && <ErrorState error={change.error} />}
          <div className="inline-actions">
            <Button type="submit" variant="contained" disabled={!ready || change.isPending}>
              {change.isPending ? 'Salvando…' : 'Salvar senha'}
            </Button>
          </div>
        </form>
      </section>
    </>
  );
}
