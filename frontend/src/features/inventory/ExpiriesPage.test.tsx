import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExpiriesPage, ExpiryRow } from './ExpiriesPage';

const state = vi.hoisted(() => ({ paths: [] as string[] }));

/** Níveis da loja, como o servidor devolve no resumo: do mais urgente ao mais tranquilo. */
const levels = [
  {
    levelId: 'vencido',
    name: 'Vencido',
    color: '#c62828',
    minDays: null,
    maxDays: -1,
    notify: true,
    lots: 0,
    units: 0,
    value: 0,
  },
  {
    levelId: 'urgente',
    name: 'Urgente',
    color: '#ef6c00',
    minDays: 0,
    maxDays: 5,
    notify: true,
    lots: 30,
    units: 60,
    value: 120,
  },
  {
    levelId: 'atencao',
    name: 'Atenção',
    color: '#f9a825',
    minDays: 6,
    maxDays: 15,
    notify: true,
    lots: 1,
    units: 4,
    value: 0,
  },
  {
    levelId: 'em-dia',
    name: 'Em dia',
    color: '#2e7d32',
    minDays: 16,
    maxDays: null,
    notify: false,
    lots: 2,
    units: 9,
    value: 0,
  },
];

/** Lote de teste: o id carrega o nível e a posição, para a página mostrar o que veio. */
const lot = (level: string, index: number) => ({
  id: `${level}-${index}`,
  productId: `product-${level}-${index}`,
  productName: `Iogurte ${level} ${index}`,
  barcode: null,
  expiresOn: '2026-10-20',
  lotCode: null,
  quantity: 2,
  daysToExpiry: 7,
  levelId: level,
  levelName: level,
  levelColor: '#ef6c00',
});

vi.mock('../../shared/api/hooks', () => ({
  useApiQuery: (path: string) => {
    state.paths.push(path);
    if (path === '/inventory/expiries/summary')
      return { isPending: false, isError: false, data: { items: levels } };
    if (path.startsWith('/inventory/expiries')) {
      const query = new URLSearchParams(path.split('?')[1]);
      const level = query.get('levelId') ?? 'ALL';
      // Urgentes em duas páginas de 25; os outros níveis cabem numa.
      const second = query.get('cursor') === 'urgente-24';
      const items =
        level === 'urgente'
          ? Array.from({ length: second ? 5 : 25 }, (_, i) => lot('urgente', second ? 25 + i : i))
          : level === 'vencido'
            ? []
            : [lot(level === 'ALL' ? 'em-dia' : level, 0)];
      return {
        isPending: false,
        isError: false,
        data: { items, nextCursor: level === 'urgente' && !second ? 'urgente-24' : null },
      };
    }
    return { isPending: false, isError: false, data: undefined };
  },
}));

function renderPage(url = '/expiries') {
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/expiries" element={<ExpiriesPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  state.paths = [];
  window.scrollTo = vi.fn();
});

describe('validades pelos níveis da loja', () => {
  it('abre no nível mais urgente com lotes e mostra a contagem de cada aba', () => {
    renderPage();
    // Sem vencidos, a primeira aba com lotes é a dos urgentes.
    expect(screen.getByRole('tab', { name: /Urgente/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Vencido/ })).toHaveTextContent('0');
    expect(screen.getByRole('tab', { name: /Todos/ })).toHaveTextContent('33');
    expect(screen.getByText(/30 lotes · 60 unidades/)).toHaveTextContent('R$');
    expect(screen.getByText('Urgente: de 0 a 5 dias')).toBeInTheDocument();
    expect(state.paths).toContain('/inventory/expiries?levelId=urgente&limit=25');
  });

  it('pagina dentro do nível e volta para a página anterior', async () => {
    const user = userEvent.setup();
    renderPage();
    const nav = screen.getByRole('navigation', { name: 'Paginação' });
    expect(within(nav).getByText('1–25 de 30')).toBeInTheDocument();
    expect(within(nav).getByText('Página 1 de 2')).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: 'Anterior' })).toBeDisabled();

    await user.click(within(nav).getByRole('button', { name: 'Próxima' }));
    expect(state.paths).toContain('/inventory/expiries?levelId=urgente&limit=25&cursor=urgente-24');
    expect(screen.getByText('Iogurte urgente 29')).toBeInTheDocument();
    const second = screen.getByRole('navigation', { name: 'Paginação' });
    expect(within(second).getByText('26–30 de 30')).toBeInTheDocument();
    expect(within(second).getByRole('button', { name: 'Próxima' })).toBeDisabled();

    await user.click(within(second).getByRole('button', { name: 'Anterior' }));
    expect(screen.getByText('Iogurte urgente 0')).toBeInTheDocument();
    expect(screen.queryByText('Iogurte urgente 29')).not.toBeInTheDocument();
  });

  it('troca de aba e esconde a paginação quando o nível cabe numa página', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('tab', { name: /Atenção/ }));
    expect(screen.getByRole('tab', { name: /Atenção/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Iogurte atencao 0')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Paginação' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /Vencido/ }));
    expect(screen.getByText('Nenhum lote em Vencido.')).toBeInTheDocument();
  });

  it('abre direto na aba pedida pelo endereço', () => {
    renderPage('/expiries?nivel=em-dia');
    expect(screen.getByRole('tab', { name: /Em dia/ })).toHaveAttribute('aria-selected', 'true');
    expect(state.paths).toContain('/inventory/expiries?levelId=em-dia&limit=25');
  });
});

describe('previsão de venda na lista', () => {
  it('mostra se o lote deve vender antes de vencer ou quanto deve sobrar', () => {
    render(
      <MemoryRouter>
        <ExpiryRow item={{ ...lot('atencao', 0), forecastLeftover: 0 }} />
        <ExpiryRow item={{ ...lot('atencao', 1), quantity: 10, forecastLeftover: 3 }} />
        <ExpiryRow item={{ ...lot('atencao', 2), forecastLeftover: null }} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Deve vender antes de vencer')).toHaveClass('forecast', 'ok');
    expect(screen.getByText('Deve sobrar 3 unidades')).toHaveClass('forecast', 'risk');
    // Sem previsão (histórico curto), nada a mais na linha.
    expect(screen.getAllByText(/Deve /)).toHaveLength(2);
  });
});
