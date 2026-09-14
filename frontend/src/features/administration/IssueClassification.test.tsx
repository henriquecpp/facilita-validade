import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IssueClassification } from './IssueClassification';
import type { Issue } from '../../shared/api/types';
const state = vi.hoisted(() => ({ uncertain: false, mutate: vi.fn() }));
vi.mock('../../shared/api/hooks', () => ({
  useApiQuery: () => ({
    isPending: false,
    isError: false,
    data: { records: [{ id: 'record-b', expiresOn: '2026-10-15', lotCode: 'B', quantity: 6 }] },
  }),
  useBusinessMutation: () => ({
    mutate: state.mutate,
    isPending: false,
    isUncertain: state.uncertain,
    error: null,
  }),
}));
const issue: Issue = {
  id: 'issue-a',
  movementType: 'SCRAP',
  type: 'PENDING_STOCK_IDENTIFICATION',
  productId: 'product-a',
  productName: 'Iogurte',
  status: 'OPEN',
  createdAt: '2026-09-28T12:00:00Z',
};
beforeEach(() => {
  state.uncertain = false;
  state.mutate.mockReset();
});
describe('classificação de movimento', () => {
  it('preserva o registro e motivo ao repetir uma classificação sem resposta confirmada', async () => {
    const user = userEvent.setup();
    const close = vi.fn();
    const view = render(<IssueClassification issue={issue} close={close} />);
    await user.click(screen.getByRole('combobox', { name: /Lote que foi descartado/ }));
    await user.click(screen.getByRole('option', { name: /Lote B/ }));
    await user.type(
      screen.getByLabelText(/Motivo e conferência realizada/),
      'Conferência física do lote B.',
    );
    await user.click(screen.getByRole('button', { name: 'Confirmar classificação' }));
    const firstBody = state.mutate.mock.calls[0]![0];
    state.uncertain = true;
    view.rerender(<IssueClassification issue={issue} close={close} />);
    expect(screen.getByRole('combobox', { name: /Lote que foi descartado/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByLabelText(/Motivo e conferência realizada/)).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Voltar' })).toBeDisabled();
    expect(screen.getByText(/A resposta não foi confirmada/)).toBeVisible();
    await user.keyboard('{Escape}');
    expect(close).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Confirmar classificação' }));
    expect(state.mutate.mock.calls[1]![0]).toEqual(firstBody);
  });
  it('exige uma data civil válida para classificar devolução', async () => {
    const user = userEvent.setup();
    render(
      <IssueClassification issue={{ ...issue, movementType: 'RETURN_RECEIPT' }} close={vi.fn()} />,
    );
    await user.type(
      screen.getByLabelText(/Motivo e conferência realizada/),
      'Devolução conferida.',
    );
    await user.type(screen.getByLabelText(/Validade da mercadoria devolvida/), '31/04/2027');
    expect(screen.getByRole('button', { name: 'Confirmar classificação' })).toBeDisabled();
    await user.clear(screen.getByLabelText(/Validade da mercadoria devolvida/));
    await user.type(screen.getByLabelText(/Validade da mercadoria devolvida/), '30/04/2027');
    await user.click(screen.getByRole('button', { name: 'Confirmar classificação' }));
    expect(state.mutate).toHaveBeenCalledWith(
      { action: 'CLASSIFY', expiresOn: '2027-04-30', reason: 'Devolução conferida.' },
      expect.any(Object),
    );
  });
});
