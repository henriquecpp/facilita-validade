import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { Status } from './components';

it('explica Controlado ao tocar sem acionar a navegação da linha do produto', async () => {
  const openProduct = vi.fn();
  render(
    <div onClick={openProduct}>
      <Status value="TRACKED" />
    </div>,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Controlado: entender esta situação' }));
  expect(await screen.findByRole('tooltip')).toHaveTextContent('contagem inicial confirmada');
  expect(screen.getByRole('tooltip')).toHaveTextContent('saldo chega a zero');
  expect(openProduct).not.toHaveBeenCalled();
});
