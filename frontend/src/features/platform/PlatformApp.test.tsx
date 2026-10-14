import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PlatformApp from './PlatformApp';

type Reply = { status?: number; body: unknown };
let routes: Record<string, () => Reply>;
let calls: { method: string; path: string; body?: unknown; headers: Headers }[];

beforeEach(() => {
  routes = {};
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const path = String(url).replace('/api/v1/platform', '');
      calls.push({
        method,
        path,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        headers: new Headers(init?.headers),
      });
      const handler = routes[`${method} ${path}`];
      if (!handler)
        return Response.json({ code: 'NOT_MOCKED', message: `${method} ${path}` }, { status: 500 });
      const reply = handler();
      return Response.json(reply.body, { status: reply.status ?? 200 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}
function renderAt(path: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/platform/*"
            element={
              <>
                <PlatformApp />
                <Where />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const sent = (method: string, path: string) =>
  calls.find((call) => call.method === method && call.path === path);

const admin = { id: 'a1', username: 'operacao', mustChangePassword: false };
const signedOut = () => ({ status: 401, body: { code: 'UNAUTHORIZED', message: 'Entre.' } });
const store = {
  id: 's1',
  cnpj: '11222333000181',
  name: 'Mercado Centro',
  timezone: 'America/Sao_Paulo',
  active: true,
  createdAt: '2026-10-01T12:00:00.000Z',
  activeUsers: 3,
  owners: ['dona'],
  pagonet: { active: true, salesThrough: '2026-10-13 14:20', lastError: null },
  lastImportAt: '2026-10-13T17:21:00.000Z',
};
const suspended = {
  ...store,
  id: 's2',
  cnpj: '11444777000161',
  name: 'Loja Bairro',
  active: false,
  owners: ['dono'],
  pagonet: null,
  lastImportAt: null,
};
const detail = {
  ...store,
  users: [
    { id: 'u1', username: 'dona', role: 'OWNER', active: true, mustChangePassword: false },
    { id: 'u2', username: 'repositor', role: 'OPERATOR', active: true, mustChangePassword: true },
  ],
  pagonet: {
    active: true,
    catalogSyncedAt: '2026-10-13T10:00:00.000Z',
    catalogProducts: 861,
    salesSyncedAt: '2026-10-13T17:20:00.000Z',
    salesThrough: '2026-10-13 14:20',
    lastError: null,
    lastErrorAt: null,
  },
};

function mobileScreen() {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query === '(max-width: 900px)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

describe('painel da plataforma', () => {
  it('sem sessão vai ao login; a senha provisória leva direto à troca', async () => {
    routes['GET /me'] = signedOut;
    routes['POST /auth/login'] = () => ({ body: { ...admin, mustChangePassword: true } });
    const user = userEvent.setup();
    renderAt('/platform');
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/platform/login'));
    await user.type(screen.getByLabelText('Usuário'), 'operacao');
    await user.type(screen.getByLabelText('Senha'), 'SenhaProvisoria!26');
    await user.click(screen.getByRole('button', { name: 'Entrar na plataforma' }));
    expect(await screen.findByRole('heading', { name: 'Defina sua senha' })).toBeInTheDocument();
    const login = sent('POST', '/auth/login')!;
    expect(login.body).toEqual({ username: 'operacao', password: 'SenhaProvisoria!26' });
    expect(login.headers.get('X-CSRF-Protection')).toBe('1');
    // Até trocar a senha, o menu não aparece.
    expect(screen.queryByRole('link', { name: 'Lojas' })).not.toBeInTheDocument();
  });

  it('troca a senha provisória e libera o painel', async () => {
    routes['GET /me'] = () => ({ body: { ...admin, mustChangePassword: true } });
    routes['POST /auth/change-password'] = () => ({ body: admin });
    routes['GET /stores'] = () => ({ body: { items: [store], nextCursor: null } });
    routes['GET /pagonet'] = () => ({ body: { configured: true } });
    const user = userEvent.setup();
    renderAt('/platform/stores/s1');
    await user.type(await screen.findByLabelText('Senha provisória'), 'SenhaProvisoria!26');
    await user.type(screen.getByLabelText('Nova senha'), 'MinhaSenhaNova!2026');
    await user.type(screen.getByLabelText('Repita a nova senha'), 'MinhaSenhaNova!2026');
    await user.click(screen.getByRole('button', { name: 'Salvar senha' }));
    expect(await screen.findByRole('link', { name: 'Mercado Centro' })).toBeInTheDocument();
    expect(sent('POST', '/auth/change-password')!.body).toEqual({
      currentPassword: 'SenhaProvisoria!26',
      newPassword: 'MinhaSenhaNova!2026',
    });
  });

  it('lista as lojas com situação e dados; busca por nome ou CNPJ', async () => {
    routes['GET /me'] = () => ({ body: admin });
    routes['GET /stores'] = () => ({ body: { items: [store, suspended], nextCursor: null } });
    routes['GET /pagonet'] = () => ({ body: { configured: false } });
    const user = userEvent.setup();
    renderAt('/platform');
    expect(await screen.findByRole('link', { name: 'Mercado Centro' })).toHaveAttribute(
      'href',
      '/platform/stores/s1',
    );
    expect(screen.getByText('Suspensa')).toBeInTheDocument();
    expect(screen.getByText('Vendas até 13/10/2026 14:20')).toBeInTheDocument();
    expect(screen.getByText('Sem leitura da Pagonet')).toBeInTheDocument();
    expect(screen.getByText('2 lojas · 1 suspensa')).toBeInTheDocument();
    expect(screen.getByText(/sem o token da aplicação/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Buscar por nome ou CNPJ'), '11.444.777');
    expect(screen.queryByRole('link', { name: 'Mercado Centro' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Loja Bairro' })).toBeInTheDocument();
  });

  it('cadastra a loja e mostra a senha provisória uma vez', async () => {
    routes['GET /me'] = () => ({ body: admin });
    routes['GET /stores'] = () => ({ body: { items: [], nextCursor: null } });
    routes['GET /pagonet'] = () => ({ body: { configured: true } });
    routes['POST /stores'] = () => ({
      status: 201,
      body: {
        store: { ...detail, id: 's9', name: 'Mercado Novo' },
        owner: { id: 'o9', username: 'admin', temporaryPassword: 'h7Kq-2mPx-8RtW-cd3F' },
      },
    });
    const user = userEvent.setup();
    renderAt('/platform');
    await user.click(await screen.findByRole('button', { name: 'Nova loja' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Nome da loja/), 'Mercado Novo');
    await user.type(within(dialog).getByLabelText(/^CNPJ/), '11.222.333/0001-81');
    await user.click(within(dialog).getByRole('button', { name: 'Cadastrar loja' }));
    expect(await within(dialog).findByDisplayValue('h7Kq-2mPx-8RtW-cd3F')).toBeInTheDocument();
    expect(within(dialog).getByText('11.222.333/0001-81')).toBeInTheDocument();
    expect(sent('POST', '/stores')!.body).toEqual({
      name: 'Mercado Novo',
      cnpj: '11222333000181',
      ownerUsername: 'admin',
    });
    // A senha aparece uma vez só: Esc não fecha; só Concluir.
    await user.keyboard('{Escape}');
    expect(screen.getByDisplayValue('h7Kq-2mPx-8RtW-cd3F')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Concluir' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('suspende com motivo e gera acesso de uso único para o proprietário', async () => {
    routes['GET /me'] = () => ({ body: admin });
    routes['GET /stores/s1'] = () => ({ body: detail });
    routes['POST /stores/s1/suspend'] = () => ({ body: { ...detail, active: false } });
    routes['POST /stores/s1/owner-access'] = () => ({
      body: { username: 'dona', resetToken: 'tok_123', expiresAt: '2026-10-13T18:30:00.000Z' },
    });
    const user = userEvent.setup();
    renderAt('/platform/stores/s1');
    await user.click(await screen.findByRole('button', { name: 'Suspender loja' }));
    let dialog = screen.getByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Suspender' });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/Motivo/), 'Contrato encerrado');
    await user.click(confirm);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(sent('POST', '/stores/s1/suspend')!.body).toEqual({ reason: 'Contrato encerrado' });

    // Só o proprietário ativo tem o botão.
    expect(screen.getAllByRole('button', { name: 'Gerar acesso' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Gerar acesso' }));
    dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Motivo/), 'Perdeu a senha');
    await user.click(within(dialog).getByRole('button', { name: 'Gerar acesso' }));
    expect(
      await within(dialog).findByDisplayValue(`${window.location.origin}/reset-password#tok_123`),
    ).toBeInTheDocument();
    expect(sent('POST', '/stores/s1/owner-access')!.body).toEqual({
      userId: 'u1',
      reason: 'Perdeu a senha',
    });
    // O link também aparece uma vez só.
    await user.keyboard('{Escape}');
    expect(
      screen.getByDisplayValue(`${window.location.origin}/reset-password#tok_123`),
    ).toBeInTheDocument();
  });

  it('no celular, a troca de senha continua alcançável pelo menu', async () => {
    mobileScreen();
    routes['GET /me'] = () => ({ body: admin });
    routes['GET /stores'] = () => ({ body: { items: [], nextCursor: null } });
    routes['GET /pagonet'] = () => ({ body: { configured: true } });
    const user = userEvent.setup();
    renderAt('/platform');
    const trigger = await screen.findByRole('button', { name: 'Abrir menu' });
    expect(screen.queryByRole('navigation', { name: 'Plataforma' })).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Menu da plataforma' });
    const password = within(dialog).getByRole('link', { name: 'Trocar senha' });
    expect(password).toHaveAttribute('href', '/platform/password');
    await user.click(password);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByTestId('where')).toHaveTextContent('/platform/password');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('menu mobile contém o foco e fecha com Escape ou link para a rota atual', async () => {
    mobileScreen();
    routes['GET /me'] = () => ({ body: admin });
    routes['GET /stores'] = () => ({ body: { items: [], nextCursor: null } });
    routes['GET /pagonet'] = () => ({ body: { configured: true } });
    const user = userEvent.setup();
    renderAt('/platform');
    const trigger = await screen.findByRole('button', { name: 'Abrir menu' });
    await user.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Menu da plataforma' });
    expect(within(dialog).getByRole('button', { name: 'Fechar menu' })).toHaveFocus();
    expect(document.body.style.overflow).toBe('hidden');
    await user.tab({ shift: true });
    expect(within(dialog).getByRole('link', { name: 'Trocar senha' })).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    expect(document.body.style.overflow).not.toBe('hidden');
    await user.click(trigger);
    await user.click(screen.getByRole('link', { name: 'Lojas' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByTestId('where')).toHaveTextContent('/platform');
    expect(trigger).toHaveFocus();
  });

  it('sessão que acaba no meio do uso volta ao login', async () => {
    routes['GET /me'] = () => ({ body: admin });
    routes['GET /stores'] = signedOut;
    routes['GET /pagonet'] = () => ({ body: { configured: true } });
    renderAt('/platform');
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/platform/login'));
  });
});
