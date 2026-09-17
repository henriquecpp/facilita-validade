import { StrictMode, type ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../../shared/api/types';
import { canPair, PairCollectorButton, PairCollectorDialog } from './PairCollector';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../shared/api/client', () => ({ api }));

const CODE = `estoque-pair:1:${'a'.repeat(43)}`;
const operator = {
  id: 'op-1',
  username: 'repositor',
  role: 'OPERATOR',
  storeId: 's',
  active: true,
  mustChangePassword: false,
} as User;

function withQuery(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function pairing(secondsAhead: number) {
  return {
    code: CODE,
    expiresAt: new Date(Date.now() + secondsAhead * 1000).toISOString(),
    user: { id: operator.id, username: operator.username },
  };
}

beforeEach(() => api.mockReset());

describe('quem aparece com o botão de QR', () => {
  it('segue a regra do backend', () => {
    expect(canPair(operator)).toBe(true);
    expect(canPair({ ...operator, role: 'OWNER' })).toBe(false);
    expect(canPair({ ...operator, role: 'MANAGER' })).toBe(false);
    expect(canPair({ ...operator, active: false })).toBe(false);
    expect(canPair({ ...operator, mustChangePassword: true })).toBe(false);
  });

  it('proprietário, gestor e desativados não ganham botão', () => {
    for (const user of [
      { ...operator, role: 'OWNER' as const },
      { ...operator, role: 'MANAGER' as const },
      { ...operator, active: false },
    ]) {
      const { container, unmount } = render(<PairCollectorButton user={user} onClick={() => {}} />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it('operador com senha provisória vê o botão desabilitado e o motivo', async () => {
    render(
      <PairCollectorButton user={{ ...operator, mustChangePassword: true }} onClick={() => {}} />,
    );
    const button = screen.getByRole('button', { name: 'QR do coletor' });
    expect(button).toBeDisabled();
    await userEvent.hover(button.parentElement!);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/trocar a senha provisória/);
  });
});

describe('diálogo do QR', () => {
  it('gera um único código por abertura, mesmo sob StrictMode', async () => {
    api.mockResolvedValue(pairing(120));
    render(
      <StrictMode>
        {withQuery(<PairCollectorDialog user={operator} close={() => {}} />)}
      </StrictMode>,
    );
    await screen.findByTitle('QR de acesso de repositor');
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith('/device-pairings', {
      method: 'POST',
      body: JSON.stringify({ userId: 'op-1' }),
    });
  });

  it('mostra o QR e a contagem regressiva', async () => {
    api.mockResolvedValue(pairing(120));
    render(withQuery(<PairCollectorDialog user={operator} close={() => {}} />));
    expect(await screen.findByTitle('QR de acesso de repositor')).toBeInTheDocument();
    expect(screen.getByText(/Válido por 2:00/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Gerar novo código' })).not.toBeInTheDocument();
  });

  it('a contagem começa em 2:00 mesmo quando a resposta demora', async () => {
    // O servidor calcula a validade ao responder, depois de o diálogo já ter aberto.
    api.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(pairing(120)), 400)),
    );
    render(withQuery(<PairCollectorDialog user={operator} close={() => {}} />));
    expect(await screen.findByText(/Válido por/)).toHaveTextContent('Válido por 2:00');
  });

  it('código expirado some da tela e oferece outro', async () => {
    api.mockResolvedValueOnce(pairing(-1)).mockResolvedValueOnce(pairing(120));
    const user = userEvent.setup();
    render(withQuery(<PairCollectorDialog user={operator} close={() => {}} />));
    expect(await screen.findByText(/Este código expirou/)).toBeInTheDocument();
    // O SVG continua no DOM, mas invisível: não fica legível valendo nada.
    const qr = screen.getByTitle('QR de acesso de repositor').closest('[aria-hidden]');
    expect(qr).toHaveAttribute('aria-hidden', 'true');

    await user.click(screen.getByRole('button', { name: 'Gerar novo código' }));
    await waitFor(() => expect(screen.getByText(/Válido por/)).toBeInTheDocument());
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('erro da API aparece e permite tentar de novo', async () => {
    api.mockRejectedValueOnce(new Error('Este operador ainda tem senha provisória.'));
    render(withQuery(<PairCollectorDialog user={operator} close={() => {}} />));
    expect(await screen.findByText(/senha provisória/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Gerar novo código' })).toBeEnabled();
  });
});
