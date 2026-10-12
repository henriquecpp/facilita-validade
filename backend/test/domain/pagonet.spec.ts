import { describe, expect, it } from 'vitest';
import {
  decideVoids,
  hasConfirmedSalesDelay,
  localClock,
  localInstant,
  nationalHoliday,
  pagonetCatalog,
  planSalesRead,
  readSales,
  recordSalesObservation,
  recordSalesRead,
  saleEvent,
  salesBacklog,
  voidEvent,
  type PagonetProduct,
  type SalesState,
} from '../../src/modules/integration/domain/pagonet.js';

const iogurte = (codformavenda: string, extra: Partial<PagonetProduct> = {}): PagonetProduct => ({
  codprod: '1678',
  codformavenda,
  descricao: 'ACTIVIA IOGURTE 400G AMEIXA',
  descricao_venda: 'ACTIVIA IOGURTE 400G AMEIXA',
  ativo: '1',
  codgrupo: '529',
  codcategoria: '889',
  ...extra,
});

describe('catálogo do Facilita Validade', () => {
  it('importa o catálogo inteiro, com descrição de venda, ativo, códigos e todos os campos', () => {
    const osso = iogurte('9001', {
      codgrupo: '501',
      codcategoria: '838',
      descricao_venda: 'OSSO BUCO KG',
      preco_venda: 29.9,
      raw: { codformavenda: '9001', preco_venda: 29.9, preco_custo: 18.5, unidade: 'KG' },
    });
    const { products, issues } = pagonetCatalog(
      [
        iogurte('1678'),
        iogurte('1004775', { descricao_venda: 'OFERTA_ACTIVIA IOGURTE 400G AMEIXA', ativo: '0' }),
        osso,
      ],
      [
        { codformavenda: '1678', codigo_barras: '7891025103233' },
        { codformavenda: '1004775', codigo_barras: '5901234130202' },
        // Código com TAB no fim, como veio de verdade.
        { codformavenda: '1678', codigo_barras: '7891025103240	' },
        { codformavenda: '9001', codigo_barras: '0418' },
        // Código de forma de venda que não veio no catálogo: descartado.
        { codformavenda: '7777', codigo_barras: '0419' },
      ],
    );
    expect(issues).toEqual([]);
    const details = { group: '529', category: '889', salePrice: null, attributes: null };
    expect(products).toEqual([
      {
        externalProductId: '1004775',
        description: 'OFERTA_ACTIVIA IOGURTE 400G AMEIXA',
        barcodes: ['5901234130202'],
        active: false,
        details,
      },
      {
        externalProductId: '1678',
        description: 'ACTIVIA IOGURTE 400G AMEIXA',
        barcodes: ['7891025103233', '7891025103240'],
        active: true,
        details,
      },
      {
        externalProductId: '9001',
        description: 'OSSO BUCO KG',
        barcodes: ['0418'],
        active: true,
        details: {
          group: '501',
          category: '838',
          salePrice: 29.9,
          attributes: osso.raw,
        },
      },
    ]);
  });
});

describe('códigos de barras do catálogo', () => {
  it('guarda todos os códigos de uma forma de venda, sem o limite do contrato de importação', () => {
    // Incenso da loja-piloto: uma forma de venda, um código por aroma.
    const codigos = Array.from({ length: 233 }, (_, i) => ({
      codformavenda: '23111',
      codigo_barras: String(7890000000000 + i),
    }));
    const { products, issues } = pagonetCatalog(
      [iogurte('23111', { descricao_venda: 'INCENSO 8 VARETAS' })],
      codigos,
    );
    expect(issues).toEqual([]);
    expect(products[0]!.barcodes).toHaveLength(233);
  });
});

describe('hora da loja', () => {
  it('converte a hora local da venda para UTC no fuso da loja', () => {
    expect(localInstant('2026-10-12', '10:32', 'America/Sao_Paulo')).toBe(
      '2026-10-12T13:32:00.000Z',
    );
    expect(localInstant('2026-10-12', '10:32', 'America/Manaus')).toBe('2026-10-12T14:32:00.000Z');
    expect(localInstant('2026-10-12', '23:59', 'America/Sao_Paulo')).toBe(
      '2026-10-13T02:59:00.000Z',
    );
    // Fuso com horário de verão: julho em Nova York é UTC−4.
    expect(localInstant('2026-07-01', '10:00', 'America/New_York')).toBe(
      '2026-07-01T14:00:00.000Z',
    );
  });

  it('dá a data e o minuto do relógio da loja', () => {
    expect(localClock(new Date('2026-10-13T02:30:00Z'), 'America/Sao_Paulo')).toEqual({
      date: '2026-10-12',
      minutes: 23 * 60 + 30,
    });
  });
});

describe('vendas do dia', () => {
  const rows = [
    { id: '21896', data: '2026-10-12T00:00:00', hora: '07:14', qtd: 0 },
    { id: '21905', data: '2026-10-12T00:00:00', hora: '10:32', codprod: '1005778', qtd: 1 },
    { id: '21906', data: '2026-10-12T00:00:00', hora: '10:32', codprod: '2294', qtd: 0.206 },
    { id: '21907', data: '2026-10-12T00:00:00', hora: '25:00', codprod: '26937', qtd: 1 },
    { id: '21908', data: '2026-10-11T00:00:00', hora: '10:33', codprod: '26937', qtd: 1 },
  ];

  it('ignora linhas sem produto e separa as de formato inesperado', () => {
    const { items, presentIds, ignored, invalid } = readSales(
      rows,
      '2026-10-12',
      'America/Sao_Paulo',
    );
    expect(ignored).toBe(1);
    expect(invalid).toEqual(['21907', '21908']);
    expect([...presentIds]).toEqual(['21905', '21906']);
    expect(items[0]).toEqual({
      id: '21905',
      productId: '1005778',
      quantity: 1,
      time: '10:32',
      occurredAt: '2026-10-12T13:32:00.000Z',
    });
  });

  it('vira evento de venda com o id da Pagonet, e o cancelamento aponta para ele', () => {
    const [item] = readSales(rows, '2026-10-12', 'America/Sao_Paulo').items;
    expect(saleEvent('2026-10-12', item!)).toEqual({
      externalEventId: 'venda:2026-10-12:21905',
      externalProductId: '1005778',
      type: 'SALE',
      quantity: 1,
      occurredAt: '2026-10-12T13:32:00.000Z',
    });
    expect(voidEvent('2026-10-12', '21905', '1005778', '2026-10-12T15:00:00.000Z')).toEqual({
      externalEventId: 'cancelamento:2026-10-12:21905',
      externalProductId: '1005778',
      type: 'VOID_MOVEMENT',
      occurredAt: '2026-10-12T15:00:00.000Z',
      originalExternalEventId: 'venda:2026-10-12:21905',
    });
  });
});

describe('vendas que somem da origem', () => {
  const imported = Array.from({ length: 40 }, (_, i) => String(1000 + i));
  const present = (...missing: string[]) => new Set(imported.filter((id) => !missing.includes(id)));

  it('cancela só depois de duas leituras seguidas sem o item', () => {
    const first = decideVoids(imported, present('1003'), {});
    expect(first).toEqual({ confirmed: [], missing: { '1003': 1 }, suspicious: false });
    const second = decideVoids(imported, present('1003'), first.missing);
    expect(second).toEqual({ confirmed: ['1003'], missing: {}, suspicious: false });
  });

  it('esquece o item que voltou e desconfia de muitos sumindo de uma vez', () => {
    expect(decideVoids(imported, present(), { '1003': 1 }).missing).toEqual({});
    const many = imported.slice(0, 6);
    expect(decideVoids(imported, present(...many), { '1003': 1 })).toEqual({
      confirmed: [],
      missing: { '1003': 1 },
      suspicious: true,
    });
  });
});

describe('qual dia ler', () => {
  it('lê hoje e, depois de meia-noite e quinze, fecha o dia anterior com duas leituras', () => {
    let state = recordSalesRead({ days: {} }, '2026-10-12', '2026-10-12', {});
    expect(planSalesRead(state, '2026-10-13', 10).date).toBe('2026-10-13');
    let plan = planSalesRead(state, '2026-10-13', 20);
    expect(plan.date).toBe('2026-10-12');
    state = recordSalesRead(plan.state, plan.date, '2026-10-13', {});
    plan = planSalesRead(state, '2026-10-13', 25);
    expect(plan.date).toBe('2026-10-12');
    state = recordSalesRead(plan.state, plan.date, '2026-10-13', {});
    expect(planSalesRead(state, '2026-10-13', 30).date).toBe('2026-10-13');
    // No dia seguinte, o dia encerrado sai do estado.
    expect(Object.keys(planSalesRead(state, '2026-10-14', 30).state.days)).not.toContain(
      '2026-10-12',
    );
  });

  it('começa pelo dia anterior, numa leitura só, para aprender o horário da loja', () => {
    let plan = planSalesRead({ days: {} }, '2026-10-12', 600);
    expect(plan.date).toBe('2026-10-11');
    const state = recordSalesRead(plan.state, plan.date, '2026-10-12', {}, ['07:00', '13:00']);
    expect(state.hours?.['0']).toEqual([{ date: '2026-10-11', first: '07:00', last: '13:00' }]);
    expect(planSalesRead(state, '2026-10-12', 605).date).toBe('2026-10-12');
    // Configurada logo depois da meia-noite: o dia anterior espera os quinze minutos.
    plan = planSalesRead({ days: {} }, '2026-10-12', 5);
    expect(plan.date).toBe('2026-10-12');
    expect(planSalesRead(plan.state, '2026-10-12', 15).date).toBe('2026-10-11');
  });

  it('recupera os dias que ficaram sem leitura, até uma semana para trás', () => {
    const state = recordSalesRead({ days: {} }, '2026-09-20', '2026-09-20', {});
    const plan = planSalesRead(state, '2026-10-12', 600);
    expect(plan.date).toBe('2026-09-20');
    expect(Object.keys(plan.state.days).sort()).toEqual([
      '2026-09-20',
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
      '2026-10-10',
      '2026-10-11',
      '2026-10-12',
    ]);
  });
});

describe('vendas paradas na origem', () => {
  // 2026-10-19 é uma segunda-feira; 2026-10-12, feriado nacional.
  const closing = (state: SalesState, date: string, times: string[]) =>
    recordSalesRead(state, date, '2026-12-31', {}, times);

  it('aprende o horário de cada dia da semana nas leituras finais', () => {
    let state = recordSalesRead({ days: {} }, '2026-10-19', '2026-10-19', {}, ['09:00']);
    expect(state.hours).toBeUndefined();
    state = closing(state, '2026-10-19', ['14:09', '06:57', '10:00']);
    state = closing(state, '2026-10-19', ['22:11', '06:57', '14:09']);
    expect(state.hours?.['1']).toEqual([{ date: '2026-10-19', first: '06:57', last: '22:11' }]);
    for (const date of ['2026-10-26', '2026-11-09', '2026-11-16', '2026-11-23'])
      state = closing(state, date, ['07:00', '21:00']);
    expect(state.hours?.['1']?.map((item) => item.date)).toEqual([
      '2026-11-23',
      '2026-11-16',
      '2026-11-09',
      '2026-10-26',
    ]);
    // Domingo sem venda: loja fechada.
    expect(closing(state, '2026-10-18', []).hours?.['0']).toEqual([
      { date: '2026-10-18', first: null, last: null },
    ]);
    // Feriado conta como domingo e não encolhe o horário da segunda em que caiu.
    const holiday = closing(state, '2026-11-02', ['07:00', '14:00']);
    expect(holiday.hours?.['0']).toEqual([{ date: '2026-11-02', first: '07:00', last: '14:00' }]);
    expect(holiday.hours?.['1']).toEqual(state.hours?.['1']);
    // O horário sobrevive ao planejamento da leitura seguinte.
    expect(planSalesRead(state, '2026-11-24', 600).state.hours).toEqual(state.hours);
  });

  it('conta só o tempo em que a loja costuma vender sem chegar venda', () => {
    const state = closing({ days: {} }, '2026-10-05', ['06:57', '22:11']);
    // Segunda, 17:33, vendas até 14:09: três horas e vinte e quatro minutos de atraso.
    expect(salesBacklog(state, '2026-10-19 14:09', '2026-10-19', 17 * 60 + 33)).toBe(204);
    // Atraso normal da origem, de poucos minutos.
    expect(salesBacklog(state, '2026-10-19 17:31', '2026-10-19', 17 * 60 + 33)).toBe(2);
    // De madrugada a loja está fechada: a última venda da noite não é atraso.
    expect(salesBacklog(state, '2026-10-19 22:11', '2026-10-20', 5 * 60)).toBe(0);
    // Abriu às 06:57 e não chegou nada ainda.
    expect(salesBacklog(state, '2026-10-19 22:11', '2026-10-20', 7 * 60 + 27)).toBe(30);
    // Parada desde a tarde de ontem: o resto de ontem conta, a madrugada não.
    expect(salesBacklog(state, '2026-10-19 14:09', '2026-10-20', 6 * 60)).toBe(482);
  });

  it('no feriado espera o horário de domingo', () => {
    // A loja-piloto no feriado de 12 de outubro: vendeu até 14:09, como no domingo.
    let state = closing({ days: {} }, '2026-10-05', ['06:57', '22:11']);
    expect(salesBacklog(state, '2026-10-12 14:09', '2026-10-12', 17 * 60 + 33)).toBe(0);
    state = closing(state, '2026-10-11', ['07:03', '14:07']);
    expect(salesBacklog(state, '2026-10-12 14:09', '2026-10-12', 17 * 60 + 33)).toBe(0);
    expect(salesBacklog(state, '2026-10-12 11:00', '2026-10-12', 17 * 60 + 33)).toBe(187);
    // Fixos, e os que dependem da Páscoa: carnaval, Sexta-feira Santa e Corpus Christi.
    for (const date of [
      '2026-10-12',
      '2026-11-20',
      '2026-02-16',
      '2026-02-17',
      '2026-04-03',
      '2026-06-04',
      '2027-03-26',
    ])
      expect(nationalHoliday(date), date).toBe(true);
    for (const date of ['2026-10-13', '2026-04-05', '2026-02-18'])
      expect(nationalHoliday(date), date).toBe(false);
  });

  it('não acusa atraso sem saber o horário da loja', () => {
    expect(salesBacklog({ days: {} }, '2026-10-19 08:00', '2026-10-19', 20 * 60)).toBe(0);
    expect(salesBacklog(undefined, null, '2026-10-19', 20 * 60)).toBe(0);
    // Domingo nunca visto não herda o horário da semana.
    const weekdays = closing({ days: {} }, '2026-10-10', ['07:00', '22:00']);
    expect(salesBacklog(weekdays, '2026-10-11 07:30', '2026-10-11', 15 * 60)).toBe(0);
    // Domingo visto fechado também não.
    const sunday = closing(weekdays, '2026-10-04', []);
    expect(salesBacklog(sunday, '2026-10-10 22:00', '2026-10-11', 15 * 60)).toBe(0);
    // Segunda ainda não vista usa o horário de sábado.
    expect(salesBacklog(weekdays, '2026-10-19 10:00', '2026-10-19', 11 * 60)).toBe(60);
    // Só o domingo visto, que fecha às 13h: a segunda usa esse horário, mais curto.
    const short = closing({ days: {} }, '2026-10-11', ['07:00', '13:00']);
    expect(salesBacklog(short, '2026-10-19 12:00', '2026-10-19', 17 * 60)).toBe(60);
  });

  it('usa o horário mais largo das últimas semanas e no máximo uma semana para trás', () => {
    // Uma segunda com vendas faltando não encolhe o horário das outras.
    let state = closing({ days: {} }, '2026-10-05', ['07:00', '22:00']);
    state = closing(state, '2026-10-19', ['07:00', '14:09']);
    expect(salesBacklog(state, '2026-10-26 15:00', '2026-10-26', 21 * 60)).toBe(360);
    // Sem nenhuma venda recebida, conta a última semana de horário, não o histórico inteiro.
    const all = closing({ days: {} }, '2026-10-19', ['00:00', '23:59']);
    const day = 23 * 60 + 59;
    expect(salesBacklog(all, null, '2026-10-26', day)).toBe(
      salesBacklog(all, '2026-10-19 00:00', '2026-10-26', day),
    );
    expect(salesBacklog(all, '2026-09-01 10:00', '2026-10-26', day)).toBe(
      salesBacklog(all, null, '2026-10-26', day),
    );
  });
});

describe('confirmação do atraso por leituras reais', () => {
  const today = '2026-10-19'; // Segunda-feira, fora de feriados.
  const zone = 'America/Sao_Paulo';
  const through = `${today} 07:00`;
  const initial: SalesState = {
    days: {},
    hours: { '1': [{ date: '2026-10-05', first: '07:00', last: '22:00' }] },
  };
  const minutes = (time: string) => {
    const [hour, minute] = time.split(':').map(Number);
    return hour! * 60 + minute!;
  };
  const instant = (time: string, date = today) => new Date(localInstant(date, time, zone));
  const observe = (
    state: SalesState,
    time: string,
    extra: Partial<Parameters<typeof recordSalesObservation>[1]> = {},
  ) =>
    recordSalesObservation(state, {
      date: today,
      today,
      minutes: minutes(time),
      through,
      observedAt: instant(time),
      valid: true,
      ...extra,
    });
  const delayed = (state: SalesState, time: string, latest: string | null = through) =>
    hasConfirmedSalesDelay(state, latest, today, minutes(time), instant(time));
  const confirmed = () => observe(observe(initial, '09:30'), '10:30');

  it('registra o dia realmente consultado, inclusive nas leituras de encerramento', () => {
    const current = recordSalesRead(initial, today, today, {}, ['08:00']);
    expect(current.lastReadDate).toBe(today);
    const closing = recordSalesRead(current, '2026-10-18', today, {}, ['08:00']);
    expect(closing.lastReadDate).toBe('2026-10-18');
    expect(closing.days['2026-10-18']?.closingReads).toBe(1);
  });

  it('não confirma atraso só pelo relógio da tela ou uma única leitura', () => {
    const state = observe(initial, '09:30');
    expect(state.freshness?.backlogMinutes).toBe(150);
    expect(delayed(state, '09:30')).toBe(false);
    expect(delayed(state, '10:30')).toBe(false);
    expect(delayed(observe(state, '10:30'), '10:30')).toBe(true);
  });

  it('exige uma hora de observação e 150 minutos verificados na última leitura', () => {
    const state = observe(initial, '08:00');
    const almost = observe(state, '09:29');
    expect(almost.freshness?.backlogMinutes).toBe(149);
    expect(delayed(almost, '09:29')).toBe(false);
    // O relógio passou do limite, mas a consulta confirmadora ainda não aconteceu.
    expect(delayed(almost, '09:30')).toBe(false);
    expect(delayed(observe(almost, '09:30'), '09:30')).toBe(true);

    const late = observe(initial, '10:00');
    expect(delayed(observe(late, '10:59'), '10:59')).toBe(false);
    expect(delayed(observe(late, '11:00'), '11:00')).toBe(true);
  });

  it('leituras forçadas a cada cinco minutos conservam a primeira observação válida', () => {
    let state = observe(initial, '08:30');
    for (let offset = 5; offset <= 60; offset += 5) {
      const total = 8 * 60 + 30 + offset;
      const time = `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
      state = observe(state, time);
    }
    expect(state.freshness?.firstSeenAt).toBe(instant('08:30').toISOString());
    expect(delayed(state, '09:30')).toBe(true);
  });

  it('um novo último horário reinicia a confirmação, inclusive se a resposta retroceder', () => {
    const state = confirmed();
    for (const latest of [`${today} 10:55`, `${today} 06:59`]) {
      expect(delayed(state, '11:00', latest)).toBe(false);
      const changed = observe(state, '11:00', { through: latest });
      expect(changed.freshness?.firstSeenAt).toBe(instant('11:00').toISOString());
      expect(delayed(changed, '11:00', latest)).toBe(false);
    }
  });

  it('erro ou leitura inválida interrompe a sequência sem apagar o histórico aprendido', () => {
    const state = observe(confirmed(), '11:00', { valid: false });
    expect(state.freshness).toBeNull();
    expect(state.days).toEqual(initial.days);
    expect(state.hours).toEqual(initial.hours);
    expect(delayed(state, '11:00')).toBe(false);
    const recovered = observe(state, '11:05');
    expect(recovered.freshness?.firstSeenAt).toBe(instant('11:05').toISOString());
    expect(delayed(recovered, '11:05')).toBe(false);
  });

  it('respostas válidas vazias também podem confirmar ausência de venda nova', () => {
    const first = observe(initial, '09:30', { through: null });
    const second = observe(first, '10:30', { through: null });
    expect(delayed(first, '10:30', null)).toBe(false);
    expect(delayed(second, '10:30', null)).toBe(true);
    // Sem horário aprendido, a ausência de vendas não comprova anormalidade.
    expect(observe({ days: {} }, '10:30', { through: null }).freshness).toBeNull();
  });

  it('recuperação de dias antigos e virada do dia não confirmam a consulta de hoje', () => {
    const state = confirmed();
    const closing = observe(state, '11:00', { date: '2026-10-18' });
    expect(closing.freshness).toBeNull();
    expect(closing.lastReadDate).toBe('2026-10-18');
    expect(delayed(closing, '11:00')).toBe(false);
    // Mesmo antes de outra observação, a data da última leitura precisa corresponder.
    expect(delayed(recordSalesRead(state, '2026-10-18', today, {}), '11:00')).toBe(false);
    const tomorrow = '2026-10-20';
    const nextDay = observe(state, '10:30', {
      date: tomorrow,
      today: tomorrow,
      observedAt: instant('10:30', tomorrow),
    });
    expect(nextDay.freshness?.firstSeenAt).toBe(instant('10:30', tomorrow).toISOString());
    expect(
      hasConfirmedSalesDelay(
        state,
        through,
        tomorrow,
        minutes('10:30'),
        instant('10:30', tomorrow),
      ),
    ).toBe(false);
    expect(
      hasConfirmedSalesDelay(
        nextDay,
        through,
        tomorrow,
        minutes('10:30'),
        instant('10:30', tomorrow),
      ),
    ).toBe(false);
  });

  it('tolera no máximo 90 minutos sem consulta e reinicia após intervalo maior', () => {
    const state = confirmed();
    expect(delayed(state, '12:00')).toBe(true);
    expect(delayed(state, '12:01')).toBe(false);
    expect(delayed(observe(state, '12:00'), '12:00')).toBe(true);
    const restarted = observe(state, '12:01');
    expect(restarted.freshness?.firstSeenAt).toBe(instant('12:01').toISOString());
    expect(delayed(restarted, '12:01')).toBe(false);
  });

  it('fecha o aviso fora do expediente mesmo com atraso confirmado', () => {
    const state = observe(observe(initial, '21:00'), '22:00');
    expect(delayed(state, '22:00')).toBe(true);
    expect(delayed(state, '22:01')).toBe(false);
    expect(observe(state, '22:01').freshness).toBeNull();
    expect(observe(initial, '06:59').freshness).toBeNull();
  });

  it('domingo sem histórico ou visto fechado não herda o horário da semana', () => {
    const sunday = '2026-10-18';
    const input = {
      date: sunday,
      today: sunday,
      minutes: minutes('10:30'),
      through: '2026-10-17 21:58',
      observedAt: instant('10:30', sunday),
      valid: true,
    };
    expect(recordSalesObservation(initial, input).freshness).toBeNull();
    const closed = {
      ...initial,
      hours: { ...initial.hours, '0': [{ date: '2026-10-11', first: null, last: null }] },
    };
    expect(recordSalesObservation(closed, input).freshness).toBeNull();
    const open = {
      ...initial,
      hours: { ...initial.hours, '0': [{ date: '2026-10-11', first: '07:00', last: '13:00' }] },
    };
    const first = recordSalesObservation(open, {
      ...input,
      minutes: minutes('09:30'),
      observedAt: instant('09:30', sunday),
    });
    const second = recordSalesObservation(first, input);
    expect(
      hasConfirmedSalesDelay(second, input.through, sunday, minutes('10:30'), input.observedAt),
    ).toBe(true);
  });

  it('recusa observações futuras, cronologia invertida e datas de observação inválidas', () => {
    const state = confirmed();
    expect(delayed(state, '10:29')).toBe(false); // Confirmação de 10:30 ainda está no futuro.
    const reversed = {
      ...state,
      freshness: { ...state.freshness!, firstSeenAt: instant('11:00').toISOString() },
    };
    expect(delayed(reversed, '11:30')).toBe(false);
    const restored = observe(reversed, '11:30');
    expect(restored.freshness?.firstSeenAt).toBe(instant('11:30').toISOString());
    expect(delayed(restored, '11:30')).toBe(false);
    const invalid = { ...state, freshness: { ...state.freshness!, lastSeenAt: 'invalid' } };
    expect(delayed(invalid, '11:30')).toBe(false);
    expect(observe(state, '11:00', { observedAt: new Date('invalid') }).freshness).toBeNull();
    expect(
      hasConfirmedSalesDelay(undefined, through, today, minutes('11:00'), instant('11:00')),
    ).toBe(false);
  });
});
