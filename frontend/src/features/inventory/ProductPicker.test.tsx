import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Product } from '../../shared/api/types';
import { ProductPicker } from './ProductPicker';

const state = vi.hoisted(() => ({ api: vi.fn(), products: [] as Product[] }));
vi.mock('../../shared/api/client', () => ({
  api: state.api,
  queryString: (params: Record<string, string>) => `?${new URLSearchParams(params)}`,
}));
vi.mock('../../shared/api/hooks', () => ({
  useApiQuery: () => ({ data: { items: state.products }, isFetching: false, isError: false }),
}));
vi.mock('../../shared/api/store', () => ({ useDebounced: (value: string) => value }));
vi.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({ session: { store: { id: 'loja' } } }),
}));

const coca: Product = {
  id: 'coca',
  description: 'COCA COLA 600ML',
  active: true,
  photoUrl: null,
  barcodes: ['7894900011609'],
};

function renderPicker(onChange = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ProductPicker value={null} onChange={onChange} />
    </QueryClientProvider>,
  );
  return onChange;
}

beforeEach(() => {
  state.api.mockReset();
  state.products = [];
});

describe('escolha do produto pelo código', () => {
  it('mostra a lista pela descrição e preenche o produto selecionado', async () => {
    state.products = [coca, { ...coca, id: 'outra', description: 'COCA COLA 2L' }];
    const onChange = renderPicker();
    await userEvent.type(screen.getByLabelText('Produto'), 'coca');
    await userEvent.click(screen.getByRole('button', { name: /COCA COLA 600ML/ }));
    expect(onChange).toHaveBeenCalledWith(coca);
    expect(state.api).not.toHaveBeenCalled();
  });
  it('não consulta o EAN-13 com o último dígito errado', async () => {
    renderPicker();
    await userEvent.type(screen.getByLabelText('Produto'), '7894900011608{Enter}');
    expect(await screen.findByText(/não é um EAN-13 válido/)).toBeTruthy();
    expect(state.api).not.toHaveBeenCalled();
  });

  it('consulta o EAN-13 que confere e escolhe o produto', async () => {
    state.api.mockResolvedValue(coca);
    const onChange = renderPicker();
    await userEvent.type(screen.getByLabelText('Produto'), '7894900011609{Enter}');
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(coca));
    expect(state.api).toHaveBeenCalledWith('/products/by-barcode/7894900011609');
  });
});
