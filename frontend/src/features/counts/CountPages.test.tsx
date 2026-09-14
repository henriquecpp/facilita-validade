import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CountPage } from './CountPages';
const state = vi.hoisted(() => ({ status: 'COUNTING', mutate: vi.fn() }));
vi.mock('../../shared/api/hooks', () => ({
  useApiQuery: (path: string) => ({
    isPending: false,
    isError: false,
    data: path.startsWith('/products')
      ? { id: 'product-a', description: 'Iogurte natural' }
      : { id: 'count-a', productId: 'product-a', status: state.status, version: 2, lines: [] },
  }),
  useBusinessMutation: () => ({ mutate: state.mutate, isPending: false, error: null }),
}));
function renderCount() {
  render(
    <MemoryRouter initialEntries={['/counts/count-a']}>
      <Routes>
        <Route path="/counts/:countId" element={<CountPage />} />
      </Routes>
    </MemoryRouter>,
  );
}
beforeEach(() => {
  state.status = 'COUNTING';
  state.mutate.mockReset();
});
describe('confirmação da contagem', () => {
  it('exige declaração de completude e saldo zero antes de confirmar um estoque vazio', async () => {
    const user = userEvent.setup();
    renderCount();
    const button = screen.getByRole('button', { name: 'Confirmar contagem completa' });
    expect(button).toBeDisabled();
    await user.click(screen.getByLabelText(/Conferi todos os lotes/));
    expect(button).toBeDisabled();
    await user.click(screen.getByLabelText(/não possui nenhuma unidade física/));
    expect(button).toBeEnabled();
    await user.click(button);
    expect(state.mutate).toHaveBeenCalledWith(
      { expectedVersion: 2, completeConfirmed: true, emptyConfirmed: true },
      expect.any(Object),
    );
  });
  it('qualquer papel confirma: não há pedido de aprovação nem declaração de pausa', () => {
    renderCount();
    expect(screen.getByRole('button', { name: 'Confirmar contagem completa' })).toBeInTheDocument();
    expect(screen.queryByText(/gestor ou proprietário/)).not.toBeInTheDocument();
    expect(screen.queryByText(/pausa/i)).not.toBeInTheDocument();
  });
  it('aceita a validade digitada só com números e salva a data ISO', async () => {
    const user = userEvent.setup();
    renderCount();
    await user.click(screen.getByRole('button', { name: '+ Adicionar validade' }));
    const date = screen.getByLabelText('Validade 1');
    await user.type(date, '12042026');
    expect(date).toHaveValue('12/04/2026');
    await user.type(screen.getByLabelText('Quantidade'), '7');
    await user.click(screen.getByRole('button', { name: 'Salvar quantidades' }));
    expect(state.mutate).toHaveBeenCalledWith({
      expectedVersion: 2,
      lines: [expect.objectContaining({ expiresOn: '2026-04-12', quantity: 7 })],
    });
    expect(screen.queryByText(/Confira as datas/)).not.toBeInTheDocument();
  });
});
