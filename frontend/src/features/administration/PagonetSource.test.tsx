import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PagonetSource } from '../../shared/api/types';
import { PagonetSourceSection } from './PagonetSource';

const state = vi.hoisted(() => ({
  source: null as unknown as PagonetSource,
  save: vi.fn(),
  sync: vi.fn(),
  synced: false,
}));
vi.mock('../../shared/api/hooks', () => ({
  useApiQuery: () => ({
    isPending: false,
    isError: false,
    data: state.source,
  }),
  useBusinessMutation: (path: string) => ({
    mutate: path.endsWith('/sync') ? state.sync : state.save,
    isPending: false,
    isSuccess: path.endsWith('/sync') && state.synced,
    error: null,
  }),
}));

const unconfigured: PagonetSource = {
  configured: false,
  active: false,
  cnpj: '37466214000168',
  available: true,
  catalogSyncedAt: null,
  catalogProducts: null,
  salesSyncedAt: null,
  salesThrough: null,
  salesDelayed: false,
  lastError: null,
  lastErrorAt: null,
  syncRequestedAt: null,
  syncRunning: false,
  syncStartsAt: null,
};
const configured: PagonetSource = {
  ...unconfigured,
  configured: true,
  active: true,
  catalogSyncedAt: '2026-10-12T15:00:00.000Z',
  catalogProducts: 24715,
  salesSyncedAt: '2026-10-12T15:10:00.000Z',
  salesThrough: '2026-10-12 12:07',
};

beforeEach(() => {
  state.source = unconfigured;
  state.synced = false;
  state.save.mockReset();
  state.sync.mockReset();
});

describe('origem Pagonet no painel', () => {
  it('liga a leitura do catálogo inteiro; CNPJ é o da loja e token e categorias não se digitam', async () => {
    const user = userEvent.setup();
    render(<PagonetSourceSection />);
    expect(screen.getByText(/usa o CNPJ da loja, 37\.466\.214\/0001-68/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Token/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/CNPJ/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Categorias/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(state.save).toHaveBeenCalledWith({ active: true }, expect.any(Object));
  });

  it('sem o token da aplicação no servidor, avisa e não deixa ligar a leitura', () => {
    state.source = { ...unconfigured, available: false };
    render(<PagonetSourceSection />);
    expect(screen.getByRole('alert')).toHaveTextContent('não está disponível neste servidor');
    const toggle = screen.getByRole('checkbox', { name: /Ler catálogo e vendas/ });
    expect(toggle).not.toBeChecked();
    expect(toggle).toBeDisabled();
  });

  it('sem o token no servidor, salvar não pausa a leitura que já estava ligada', async () => {
    state.source = { ...configured, available: false };
    const user = userEvent.setup();
    render(<PagonetSourceSection />);
    // Sem token, forçar a leitura não leria nada.
    expect(screen.getByRole('button', { name: 'Forçar leitura agora' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Alterar' }));
    const toggle = screen.getByRole('checkbox', { name: /Ler catálogo e vendas/ });
    expect(toggle).toBeChecked();
    expect(toggle).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(state.save).toHaveBeenCalledWith({ active: true }, expect.any(Object));
  });

  it('mostra o que foi lido e o aviso da última leitura, e força uma leitura', async () => {
    state.source = {
      ...configured,
      lastError: 'A Pagonet não respondeu (tempo esgotado).',
      lastErrorAt: '2026-10-12T15:05:00.000Z',
    };
    const user = userEvent.setup();
    render(<PagonetSourceSection />);
    expect(screen.getByText('CNPJ da loja: 37.466.214/0001-68')).toBeInTheDocument();
    expect(screen.getByText(/24\.715 produtos/)).toBeInTheDocument();
    expect(screen.getByText(/até 12\/10\/2026 12:07/)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('tempo esgotado');
    await user.click(screen.getByRole('button', { name: 'Forçar leitura agora' }));
    expect(state.sync).toHaveBeenCalledWith({}, expect.any(Object));
  });

  it('diz que a leitura pedida está na fila, em andamento ou concluída', () => {
    state.source = {
      ...configured,
      syncRequestedAt: '2026-10-12T15:20:00.000Z',
      syncStartsAt: '2026-10-12T15:24:00.000Z',
    };
    const { rerender } = render(<PagonetSourceSection />);
    expect(screen.getByText(/Leitura na fila/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Forçar leitura agora' })).toBeDisabled();
    state.source = { ...state.source, syncRunning: true, syncStartsAt: null };
    rerender(<PagonetSourceSection />);
    expect(screen.getByText(/Lendo a Pagonet agora/)).toBeInTheDocument();
    state.source = { ...configured, salesSyncedAt: '2026-10-12T15:26:00.000Z' };
    state.synced = true;
    rerender(<PagonetSourceSection />);
    expect(screen.getByText(/Leitura concluída/)).toHaveTextContent('24.715 produtos');
  });

  it('informa possível atraso sem presumir vendas faltantes ou culpar a origem', () => {
    state.source = {
      ...configured,
      salesSyncedAt: '2026-10-12T20:31:00.000Z',
      salesThrough: '2026-10-12 14:09',
      salesDelayed: true,
    };
    render(<PagonetSourceSection />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Possível atraso nas vendas: as últimas consultas não trouxeram vendas posteriores a 12/10/2026 14:09. ' +
        'Se a loja vendeu depois desse horário, confira o envio dos dados pela integração.',
    );
  });

  it.each([
    { phase: 'na fila', syncRequestedAt: '2026-10-12T20:30:00.000Z', syncRunning: false },
    { phase: 'em execução', syncRequestedAt: null, syncRunning: true },
  ])(
    'suprime aviso anterior enquanto a leitura está $phase',
    ({ syncRequestedAt, syncRunning }) => {
      state.source = {
        ...configured,
        salesDelayed: true,
        syncRequestedAt,
        syncRunning,
      };
      render(<PagonetSourceSection />);
      expect(screen.queryByText(/Possível atraso nas vendas/)).not.toBeInTheDocument();
      expect(screen.getByText(/última leitura em/)).toBeInTheDocument();
    },
  );

  it('sem data observada, informa consultas vazias sem presumir vendas faltantes', () => {
    state.source = { ...configured, salesDelayed: true, salesThrough: null };
    render(<PagonetSourceSection />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Possível atraso nas vendas: as últimas consultas não trouxeram vendas. ' +
        'Se a loja já vendeu hoje, confira o envio dos dados pela integração.',
    );
  });
});
