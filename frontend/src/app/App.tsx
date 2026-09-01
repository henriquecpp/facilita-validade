import { lazy, Suspense, useEffect, useState } from 'react';
import {
  Link,
  NavLink,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useParams,
} from 'react-router-dom';
import { Alert, Button, Tooltip } from '@mui/material';
import { useAuth } from '../features/auth/AuthProvider';
import { LoginPage } from '../features/auth/LoginPage';
import { ResetPasswordPage } from '../features/auth/ResetPasswordPage';
import { PasswordPage } from '../features/auth/PasswordPage';
import { DashboardPage } from '../features/inventory/DashboardPage';
import { ExpiriesPage } from '../features/inventory/ExpiriesPage';
import { ProductsPage } from '../features/products/ProductsPage';
import { ProductPage } from '../features/products/ProductPage';
import { MovementsPage } from '../features/products/MovementsPage';
import { CountPage } from '../features/counts/CountPages';
import { AlertsPage } from '../features/alerts/AlertsPage';
import {
  ImportsPage,
  UsersPage,
  SettingsPage,
  IssuesPage,
  AuditPage,
} from '../features/administration/AdministrationPages';
import { Icon, Loading, Wordmark } from '../shared/ui/components';
import { MobileSidebar, useMobileSidebar } from '../shared/ui/MobileSidebar';
import { APP_NAME } from '../shared/lib/app';
import { logout } from '../shared/api/session';
import { forgetPush, resumePush } from '../shared/lib/push';
import { useDashboard } from '../shared/api/store';
import type { Dashboard, Role } from '../shared/api/types';
import { formatCnpj, formatDate, roleLabels } from '../shared/lib/format';

/** Painel da plataforma (super admin): à parte das lojas, baixado só quando aberto. */
const PlatformApp = lazy(() => import('../features/platform/PlatformApp'));

type MenuLink = {
  to: string;
  label: string;
  icon: string;
  badge?: number;
  tone?: 'danger' | 'warning';
};

/**
 * Menu por tarefa: o dia a dia primeiro; gestão e administração só para quem usa. Produtos
 * substitui Estoque e Contagens (AV14). Divergências sai do menu até segunda ordem (AV15).
 */
function menu(role: Role, data: Dashboard | undefined): { label?: string; links: MenuLink[] }[] {
  const attention = data ? data.expiredRecords + data.atRiskRecords : 0;
  return [
    {
      links: [
        { to: '/', label: 'Início', icon: 'home' },
        {
          to: '/expiries',
          label: 'Validades',
          icon: 'calendar',
          badge: attention,
          tone: data?.expiredRecords ? 'danger' : 'warning',
        },
        { to: '/products', label: 'Produtos', icon: 'stock' },
      ],
    },
    ...(role !== 'OPERATOR'
      ? [
          {
            label: 'Gestão',
            links: [
              { to: '/imports', label: 'Importações', icon: 'import' },
              { to: '/audit', label: 'Histórico de ações', icon: 'audit' },
            ],
          },
        ]
      : []),
    ...(role === 'OWNER'
      ? [
          {
            label: 'Administração',
            links: [
              { to: '/users', label: 'Equipe', icon: 'users' },
              { to: '/settings', label: 'Configurações', icon: 'settings' },
            ],
          },
        ]
      : []),
  ];
}

/** Até quando as vendas chegaram: os saldos só descontam o que já foi recebido. */
function Freshness({ data, link }: { data: Dashboard | undefined; link: boolean }) {
  if (!data || (!data.salesThroughAt && !data.lastImportAt)) return null;
  const content = data.salesThroughAt ? (
    <>
      <span className="freshness-dot" />
      <span>
        <strong>
          {data.salesDelayed ? 'Possível atraso nas vendas' : 'Últimas vendas recebidas'}
        </strong>
        <small>Recebidas até {formatDate(data.salesThroughAt)}</small>
      </span>
    </>
  ) : (
    <>
      <span className="freshness-dot" />
      <span>
        <strong>Última importação</strong>
        <small>{formatDate(data.lastImportAt)}</small>
      </span>
    </>
  );
  const className = `freshness ${data.salesDelayed ? 'delayed' : ''}`;
  return link ? (
    <Link className={className} to="/imports">
      {content}
    </Link>
  ) : (
    <div className={className}>{content}</div>
  );
}

function Layout() {
  const { session, ready } = useAuth();
  const location = useLocation();
  const [error, setError] = useState('');
  const sidebar = useMobileSidebar();
  const summary = useDashboard(!!session && !session.mustChangePassword);
  const owner = session?.user.role === 'OWNER' && !session.mustChangePassword;
  // Navegador já inscrito no push: a inscrição passa a valer para a sessão de agora.
  useEffect(() => {
    if (owner) void resumePush();
  }, [owner, session?.user.id]);
  if (!ready) return <Loading />;
  if (!session) return <Navigate to="/login" replace />;
  if (session.mustChangePassword && location.pathname !== '/password')
    return <Navigate to="/password" replace />;
  const restricted = !!session.mustChangePassword;
  const role = session.user.role;
  const data = summary.data;
  const unread = data?.unreadNotifications ?? 0;
  const sidebarContent = (
    <>
      <NavLink className="wordmark" to="/" aria-label={APP_NAME}>
        <Wordmark />
      </NavLink>
      {!restricted && (
        <nav aria-label="Navegação principal">
          {menu(role, data).map((group, index) => (
            <div className="nav-group" key={group.label ?? index}>
              {group.label && <div className="nav-group-label">{group.label}</div>}
              {group.links.map((link) => (
                <NavLink
                  key={link.to}
                  to={link.to}
                  end={link.to === '/'}
                  className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                  aria-description={link.badge ? `${link.badge} pendentes` : undefined}
                >
                  <Icon name={link.icon} />
                  <span className="nav-label">{link.label}</span>
                  {!!link.badge && (
                    <span className={`nav-badge ${link.tone ?? ''}`} aria-hidden="true">
                      {link.badge > 99 ? '99+' : link.badge}
                    </span>
                  )}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
      )}
      <div className="sidebar-footer">
        <Freshness data={data} link={role !== 'OPERATOR'} />
        <div className="sidebar-user">
          <strong>{session.user.username}</strong>
          <small>{roleLabels[role]}</small>
          <Link to="/password">Trocar senha</Link>
        </div>
      </div>
    </>
  );
  return (
    <div className="app-layout">
      {sidebar.mobile ? (
        <MobileSidebar
          id="store-mobile-menu"
          label="Menu principal"
          open={sidebar.open}
          close={sidebar.close}
        >
          {sidebarContent}
        </MobileSidebar>
      ) : (
        <aside className="sidebar">{sidebarContent}</aside>
      )}
      <div className="workspace">
        <header className="topbar">
          {sidebar.mobile && (
            <button
              type="button"
              className="icon-button mobile-menu"
              aria-label="Abrir menu"
              aria-expanded={sidebar.open}
              aria-controls="store-mobile-menu"
              aria-haspopup="dialog"
              onClick={sidebar.show}
            >
              <Icon name="menu" />
            </button>
          )}
          <div className="store-identification">
            <span className="store-avatar" aria-hidden="true">
              {session.store.name.slice(0, 1).toUpperCase()}
            </span>
            <div>
              <strong>{session.store.name}</strong>
              <small>CNPJ {formatCnpj(session.store.cnpj)}</small>
            </div>
          </div>
          <div className="session-actions">
            {!restricted && (
              <Tooltip title={unread ? `${unread} alertas não lidos` : 'Alertas'}>
                <Link
                  to="/alerts"
                  className={`icon-button bell ${location.pathname === '/alerts' ? 'active' : ''}`}
                  aria-label={unread ? `Alertas, ${unread} não lidos` : 'Alertas'}
                >
                  <Icon name="bell" />
                  {unread > 0 && (
                    <span className="bell-count" aria-hidden="true">
                      {unread > 99 ? '99+' : unread}
                    </span>
                  )}
                </Link>
              </Tooltip>
            )}
            <div className="user-identification">
              <strong>{session.user.username}</strong>
              <small>{roleLabels[role]}</small>
            </div>
            <Button component={NavLink} to="/password" size="small" className="hide-mobile">
              Trocar senha
            </Button>
            <Button
              size="small"
              color="inherit"
              onClick={() => {
                setError('');
                // O push deste navegador é da sessão que sai: sem a inscrição, nada mais chega.
                void forgetPush()
                  .then(logout)
                  .catch((cause) => setError(cause.message));
              }}
            >
              Sair
            </Button>
          </div>
        </header>
        <main className="page-content">
          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}
          {restricted && (
            <Alert severity="info" sx={{ mb: 2 }}>
              Defina uma senha pessoal para continuar.
            </Alert>
          )}
          <Outlet />
        </main>
        <footer className="workspace-footer">
          {APP_NAME} · Quantidades estimadas a partir das contagens, entradas e vendas recebidas.
        </footer>
      </div>
    </div>
  );
}
function Management({ children, owner = false }: { children: React.ReactNode; owner?: boolean }) {
  const { session } = useAuth();
  return session?.user.role === 'OWNER' || (!owner && session?.user.role === 'MANAGER') ? (
    children
  ) : (
    <Alert severity="warning">Seu usuário não tem permissão para acessar esta área.</Alert>
  );
}
function LegacyProduct() {
  const { productId } = useParams();
  return <Navigate to={`/products/${productId}`} replace />;
}
export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route
        path="/platform/*"
        element={
          <Suspense fallback={<Loading />}>
            <PlatformApp />
          </Suspense>
        }
      />
      <Route element={<Layout />}>
        <Route index element={<DashboardPage />} />
        <Route path="expiries" element={<ExpiriesPage />} />
        <Route path="products" element={<ProductsPage />} />
        <Route path="products/:productId" element={<ProductPage />} />
        <Route path="products/:productId/movements" element={<MovementsPage />} />
        <Route path="counts/:countId" element={<CountPage />} />
        {/* Endereços de antes do módulo Produtos, para favoritos e links antigos. */}
        <Route path="inventory" element={<Navigate to="/products" replace />} />
        <Route path="inventory/:productId" element={<LegacyProduct />} />
        <Route path="counts" element={<Navigate to="/products" replace />} />
        <Route path="receipts/new" element={<Navigate to="/products" replace />} />
        <Route path="alerts" element={<AlertsPage />} />
        <Route
          path="issues"
          element={
            <Management>
              <IssuesPage />
            </Management>
          }
        />
        <Route
          path="imports"
          element={
            <Management>
              <ImportsPage />
            </Management>
          }
        />
        <Route
          path="audit"
          element={
            <Management>
              <AuditPage />
            </Management>
          }
        />
        <Route
          path="users"
          element={
            <Management owner>
              <UsersPage />
            </Management>
          }
        />
        <Route
          path="settings"
          element={
            <Management owner>
              <SettingsPage />
            </Management>
          }
        />
        <Route path="password" element={<PasswordPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
