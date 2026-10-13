import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectedCollectors } from './ConnectedCollectors';

const state = vi.hoisted(() => ({
  items: [] as {
    id: string;
    userId: string;
    username: string;
    startedAt: string;
    lastActiveAt: string;
  }[],
  mutate: vi.fn(),
  paths: [] as string[],
}));
vi.mock('../../shared/api/hooks', () => ({
  useApiQuery: () => ({
    isPending: false,
    isError: false,
    data: { items: state.items, nextCursor: null },
  }),
  useBusinessMutation: (path: string) => {
    state.paths.push(path);
    return { mutate: state.mutate, isPending: false, error: null };
  },
}));

beforeEach(() => {
  state.mutate.mockReset();
  state.paths = [];
  state.items = [
    {
      id: 'session-a',
      userId: 'op-1',
      username: 'repositor',
      startedAt: '2026-10-13T10:00:00.000Z',
      lastActiveAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    },
  ];
});

describe('coletores conectados', () => {
  it('lista o coletor e desconecta depois de confirmar', async () => {
    const user = userEvent.setup();
    render(<ConnectedCollectors />);
    expect(screen.getByText('repositor')).toBeInTheDocument();
    expect(screen.getByText('há 5 min')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Desconectar' }));
    const dialog = screen.getByRole('dialog', { name: 'Desconectar o coletor de repositor?' });
    expect(state.mutate).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Desconectar' }));
    expect(state.paths).toContain('/device-sessions/session-a/revoke');
    expect(state.mutate).toHaveBeenCalledWith({}, expect.any(Object));
  });

  it('sem coletor conectado, explica de onde eles vêm', () => {
    state.items = [];
    render(<ConnectedCollectors />);
    expect(screen.getByText('Nenhum coletor conectado')).toBeInTheDocument();
  });
});
