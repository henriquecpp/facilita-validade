import { describe, expect, it } from 'vitest';
import { dueScheduleKeys } from '../../src/modules/notifications/domain/schedules.js';
import { buildPushAlert, buildPushLevel } from '../../src/modules/notifications/domain/push.js';
import { lastAllocations } from '../../src/modules/notifications/domain/depletion.js';
import { rebuildInventory, type SaleMovement } from '../../src/modules/inventory/domain/index.js';

describe('Escolhas e mensagens de avisos por lote', () => {
  it('respeita o horário civil, inclusive minutos, e permite combinar as agendas', () => {
    expect(
      dueScheduleKeys({ intervalHours: null, dailyTime: '08:30' }, '2026-10-18', '08:29'),
    ).toEqual([]);
    expect(
      dueScheduleKeys({ intervalHours: null, dailyTime: '08:30' }, '2026-10-18', '08:30'),
    ).toEqual(['daily:2026-10-18']);
    expect(
      dueScheduleKeys({ intervalHours: 3, dailyTime: '08:30' }, '2026-10-18', '09:00'),
    ).toEqual(['hours:3:2026-10-18:3', 'daily:2026-10-18']);
    expect(
      dueScheduleKeys({ intervalHours: null, dailyTime: null }, '2026-10-18', '23:59'),
    ).toEqual([]);
  });

  it('a contagem é de lotes e o toque abre o nível correspondente', () => {
    expect(buildPushLevel('id-nivel', 'Atenção', 2)).toEqual({
      title: 'Atenção: 2 lotes',
      body: 'Toque para consultar os lotes deste nível.',
      url: '/expiries?nivel=id-nivel',
      tag: 'nivel-id-nivel',
    });
    expect(buildPushLevel('id', 'Urgente', 1).title).toBe('Urgente: 1 lote');
  });

  it('a última parcela segue FEFO e a chave da origem, independente da chegada e do UUID', () => {
    const base = {
      storeId: 'loja',
      productId: 'produto',
      occurredAt: '2026-10-18T12:00:00.000001Z',
      type: 'SALE' as const,
    };
    // No empate, origem 1 vem antes de 2; UUIDs e ordem de chegada estão invertidos.
    const first: SaleMovement = {
      ...base,
      id: 'zzz',
      quantity: 8,
      source: { kind: 'ERP', connectionId: 'erp', externalEventId: '1' },
    };
    const second: SaleMovement = {
      ...base,
      id: 'aaa',
      quantity: 5,
      source: { kind: 'ERP', connectionId: 'erp', externalEventId: '2' },
    };
    const movements = [second, first];
    const input = {
      storeId: 'loja',
      productId: 'produto',
      trackingStatus: 'TRACKED' as const,
      baseline: {
        id: 'epoch',
        storeId: 'loja',
        productId: 'produto',
        cutoffAt: '2026-10-18T10:00:00Z',
        countStartedAt: '2026-10-18T09:00:00Z',
        records: [
          {
            id: 'lote-a',
            storeId: 'loja',
            productId: 'produto',
            expiresOn: '2026-10-19',
            quantity: 10,
            allocationPriorityAt: '2026-10-18T09:01:00Z',
          },
          {
            id: 'lote-b',
            storeId: 'loja',
            productId: 'produto',
            expiresOn: '2026-10-20',
            quantity: 10,
            allocationPriorityAt: '2026-10-18T09:01:00Z',
          },
        ],
      },
      movements,
      projectionAsOf: '2026-10-18T13:00:00Z',
    };
    const projection = rebuildInventory(input);
    const replay = rebuildInventory({ ...input, movements: [...movements].reverse() });
    expect(replay).toEqual(projection);
    const allocations = projection.allocations.map((allocation) => ({
      recordId: allocation.stockRecordId,
      quantity: allocation.quantity,
      movement: movements.find((movement) => movement.id === allocation.movementId)!,
    }));
    const latest = lastAllocations([...allocations].reverse());
    expect(latest.get('lote-a')).toMatchObject({ quantity: 2, movement: { id: 'aaa' } });
    expect(latest.get('lote-b')).toMatchObject({ quantity: 3, movement: { id: 'aaa' } });
    const message = buildPushAlert([
      {
        type: 'DEPLETED',
        productId: 'produto',
        productName: 'Iogurte',
        recordId: 'lote-a',
        lotCode: 'A',
        levelName: null,
        quantity: 0,
        depletedQuantity: latest.get('lote-a')!.quantity,
        expiresOn: '2026-10-19',
        days: 1,
      },
    ]);
    expect(message?.body).toContain('Última baixa: 2 un. do lote A');
    expect(message?.url).toBe('/products/produto');
  });

  it('preserva microssegundos antes do desempate e reconhece a última baixa manual', () => {
    const base = { storeId: 's', productId: 'p', quantity: 2 };
    const sale: SaleMovement = {
      ...base,
      id: 'z',
      type: 'SALE',
      occurredAt: '2026-10-18T12:00:00.000001Z',
      source: { kind: 'ERP', connectionId: 'c', externalEventId: 'z' },
    };
    const latest = lastAllocations([
      {
        recordId: 'r',
        quantity: 1,
        movement: {
          ...base,
          id: 'a',
          type: 'MANUAL_WRITE_OFF',
          stockRecordId: 'r',
          occurredAt: '2026-10-18T12:00:00.000002Z',
          source: { kind: 'APP', commandId: 'a' },
        },
      },
      { recordId: 'r', quantity: 2, movement: sale },
    ]);
    expect(latest.get('r')?.movement.type).toBe('MANUAL_WRITE_OFF');
  });
});
