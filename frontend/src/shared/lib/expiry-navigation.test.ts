import { describe, expect, it } from 'vitest';
import { expiringLevel } from './expiry-navigation';

describe('destino do card A vencer', () => {
  it('segue os limites cadastrados, mesmo renomeados, fora de ordem e sem itens', () => {
    const levels = [
      { id: 'tranquilo', name: 'Planejar', minDays: 8, maxDays: null },
      { id: 'passado', name: 'Retirar', minDays: null, maxDays: -1 },
      { id: 'primeiro', name: 'Hoje e próximos dias', minDays: 0, maxDays: 7 },
    ];
    expect(expiringLevel(levels)?.id).toBe('primeiro');
    expect(levels[0]?.id).toBe('tranquilo');
  });

  it('inclui o dia zero e uma faixa que atravessa o vencimento', () => {
    expect(expiringLevel([{ maxDays: -1 }, { maxDays: 0 }])?.maxDays).toBe(0);
    expect(expiringLevel([{ minDays: null, maxDays: 3 }])?.maxDays).toBe(3);
  });

  it('permite voltar à lista geral quando nenhum nível inclui datas futuras', () => {
    expect(expiringLevel([])).toBeNull();
    expect(expiringLevel([{ maxDays: -1 }, { maxDays: -10 }])).toBeNull();
  });
});
