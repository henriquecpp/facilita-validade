import { describe, expect, it } from 'vitest';
import {
  describeRange,
  levelFor,
  validateLevels,
} from '../../src/modules/tenancy/domain/expiry-levels.js';

const defaults = [
  { name: 'Atenção', minDays: 6, maxDays: 15, color: '#F9A825', notify: true },
  { name: 'Vencido', maxDays: -1, color: '#c62828', notify: true },
  { name: ' Urgente ', minDays: 0, maxDays: 5, color: '#ef6c00', notify: true },
  { name: 'Em dia', minDays: 16, color: '#2e7d32', notify: false },
];

function codeOf(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

describe('Níveis de urgência da loja', () => {
  it('ordena do mais urgente ao mais tranquilo e normaliza nome e cor', () => {
    const levels = validateLevels(defaults);
    expect(levels.map((level) => level.name)).toEqual(['Vencido', 'Urgente', 'Atenção', 'Em dia']);
    expect(levels[2]).toMatchObject({ color: '#f9a825', minDays: 6, maxDays: 15 });
    expect(levels[0]).toMatchObject({ minDays: null, maxDays: -1 });
  });

  it('recusa limites repetidos, inclusive dois níveis abertos', () => {
    expect(
      codeOf(() =>
        validateLevels([
          ...defaults,
          { name: 'Crítico', maxDays: 5, color: '#000000', notify: true },
        ]),
      ),
    ).toBe('DUPLICATE_LEVEL_LIMIT');
    expect(
      codeOf(() =>
        validateLevels([
          { name: 'Em dia', maxDays: null, color: '#c62828', notify: true },
          { name: 'Tudo', color: '#000000', notify: false },
        ]),
      ),
    ).toBe('DUPLICATE_LEVEL_LIMIT');
  });

  it('preenche as lacunas antigas sem perder níveis, ids nem preferências', () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      name: `Nível ${index}`,
      id: `id-${index}`,
      minDays: index * 2,
      maxDays: index * 2,
      color: '#123456',
      notify: index % 2 === 0,
    }));
    const levels = validateLevels(many);
    expect(levels).toHaveLength(30);
    expect(levels[0]).toMatchObject({ id: 'id-0', minDays: null, maxDays: 0, notify: true });
    expect(levels[1]).toMatchObject({ id: 'id-1', minDays: 1, maxDays: 2, notify: false });
    expect(levelFor(levels, 1)?.id).toBe('id-1');
    expect(levelFor(levels, 57)?.id).toBe('id-29');
  });

  it('recusa nome repetido, limite não inteiro e cor inválida', () => {
    expect(
      codeOf(() =>
        validateLevels([
          { name: 'Urgente', minDays: 0, maxDays: 5, color: '#000000', notify: true },
          { name: 'URGENTE', minDays: 6, maxDays: 9, color: '#000000', notify: true },
        ]),
      ),
    ).toBe('DUPLICATE_LEVEL_NAME');
    expect(
      codeOf(() => validateLevels([{ name: 'X', maxDays: 2.5, color: '#000000', notify: true }])),
    ).toBe('INVALID_LEVEL_RANGE');
    expect(
      codeOf(() => validateLevels([{ name: 'X', minDays: 0, color: 'red', notify: true }])),
    ).toBe('INVALID_LEVEL_COLOR');
    expect(codeOf(() => validateLevels([{ name: '  ', color: '#000000', notify: true }]))).toBe(
      'INVALID_LEVEL_NAME',
    );
  });

  it('deriva a hierarquia mesmo quando um cliente antigo reenvia inícios conflitantes', () => {
    const levels = validateLevels([
      { name: 'Atenção', minDays: 50, maxDays: 15, color: '#f9a825', notify: true },
      { name: 'Vencido', minDays: -20, maxDays: -1, color: '#c62828', notify: true },
      { name: 'Urgente', minDays: -10, maxDays: 5, color: '#ef6c00', notify: true },
      { name: 'Em dia', maxDays: 30, color: '#2e7d32', notify: false },
    ]);
    expect([-21, -1, 0, 5, 6, 15, 16, 30].map((days) => levelFor(levels, days)?.name)).toEqual([
      'Vencido',
      'Vencido',
      'Urgente',
      'Urgente',
      'Atenção',
      'Atenção',
      'Em dia',
      'Em dia',
    ]);
    expect(levelFor(levels, 31)).toBeNull();
  });

  it('permite lista vazia e nível aberto cadastrado sem gerar níveis implícitos', () => {
    expect(validateLevels([])).toEqual([]);
    const levels = validateLevels([{ name: 'Meu nível', color: '#123456', notify: false }]);
    expect(levels).toHaveLength(1);
    expect(levelFor(levels, -100)?.name).toBe('Meu nível');
    expect(levelFor(levels, 100)?.name).toBe('Meu nível');
  });

  it('mantém o último nível aberto após o maior limite permitido', () => {
    const levels = validateLevels([
      { name: 'Limite', maxDays: 36500, color: '#123456', notify: true },
      { name: 'Depois', color: '#234567', notify: false },
    ]);
    expect(levels[1]?.minDays).toBe(36501);
    expect(levelFor(levels, 36501)?.name).toBe('Depois');
    // A própria resposta pode ser reenviada por um cliente legado.
    expect(validateLevels(levels)).toEqual(levels);
  });

  it('acha o nível de cada prazo, e nenhum fora das faixas', () => {
    const levels = validateLevels(defaults.filter((level) => level.name !== 'Em dia'));
    expect(levelFor(levels, -30)?.name).toBe('Vencido');
    expect(levelFor(levels, 0)?.name).toBe('Urgente');
    expect(levelFor(levels, 15)?.name).toBe('Atenção');
    expect(levelFor(levels, 16)).toBeNull();
  });

  it('descreve a faixa para as mensagens', () => {
    expect(describeRange({ minDays: null, maxDays: -1 })).toBe('até -1 dia');
    expect(describeRange({ minDays: 0, maxDays: 5 })).toBe('de 0 a 5 dias');
    expect(describeRange({ minDays: 16, maxDays: null })).toBe('a partir de 16 dias');
  });
});
