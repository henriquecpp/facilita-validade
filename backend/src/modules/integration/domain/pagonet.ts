/**
 * Tradução das rotas do Facilita Validade (Bridge da Pagonet) para o contrato canônico
 * de importação. Funções puras: não acessam banco, rede nem relógio — o instante atual
 * chega como argumento.
 *
 * O que as rotas mostraram nos testes de outubro de 2026:
 * - `produtos`: uma linha por forma de venda (`codformavenda`), com `codprod`, grupo e
 *   categoria em código, `ativo` como "0"/"1", o preço de venda em `preco_venda` (numérico,
 *   99.99) e outros campos do cadastro, guardados como vieram;
 * - `codigos-barras`: os códigos de cada forma de venda;
 * - `vendas`: os itens não cancelados de um dia, cada um com `id` estável, hora `HH:MM`
 *   no horário da loja e, no campo chamado `codprod`, o codformavenda — o nome engana,
 *   mas todos os itens conferidos batem com a forma de venda do catálogo. Linhas sem
 *   produto (fechamento de cupom, abertura de caixa) não são itens.
 */
import { buildCatalog, type CatalogProduct, type ReportIssue } from './erp-report.js';

export interface PagonetProduct {
  readonly codprod: string;
  readonly codformavenda: string;
  readonly descricao: string;
  readonly descricao_venda?: string;
  readonly ativo: string;
  readonly codgrupo?: string;
  readonly codcategoria?: string;
  /** Preço de venda; ausente quando a origem não manda um número. */
  readonly preco_venda?: number;
  /** A linha inteira, como veio da origem: o cadastro guarda tudo (AV30). */
  readonly raw?: Readonly<Record<string, unknown>>;
}

export interface PagonetBarcode {
  readonly codformavenda: string;
  readonly codigo_barras: string;
}

export interface PagonetSale {
  readonly id: string;
  readonly data: string;
  readonly hora: string;
  /** O codformavenda, apesar do nome. Ausente nas linhas que não são itens. */
  readonly codprod?: string;
  readonly qtd: number;
}

/** Item vendido, já com o instante em UTC. */
export interface SaleItem {
  readonly id: string;
  readonly productId: string;
  readonly quantity: number;
  readonly time: string;
  readonly occurredAt: string;
}

export interface SaleEvent {
  externalEventId: string;
  externalProductId: string;
  type: 'SALE';
  quantity: number;
  occurredAt: string;
}

export interface VoidEvent {
  externalEventId: string;
  externalProductId: string;
  type: 'VOID_MOVEMENT';
  occurredAt: string;
  originalExternalEventId: string;
}

/** Leituras de vendas por dia, guardadas entre uma execução e outra. */
export interface SalesState {
  days: Record<string, DayState>;
  /** Horário em que a loja vendeu, por dia da semana (`0` = domingo): as últimas semanas. */
  hours?: Record<string, SalesHours[]>;
  /** Dia consultado na última leitura, distinto do instante da venda mais recente. */
  lastReadDate?: string;
  /** Instante de conclusão da última consulta do dia corrente; não reabre pedidos já atendidos. */
  lastCurrentDayReadAt?: string;
  /** Evidência de leituras válidas do dia atual, durante o horário habitual de venda. */
  freshness?: SalesObservation | null;
}

export interface SalesObservation {
  readonly date: string;
  readonly through: string | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  /** Atraso observado na consulta; o relógio da tela não aumenta esta evidência. */
  readonly backlogMinutes: number;
}

export interface DayState {
  /** Leituras feitas depois que o dia acabou; duas encerram o dia. */
  closingReads: number;
  /** Itens importados que sumiram da origem: quantas leituras seguidas sem eles. */
  missing: Record<string, number>;
}

/** Primeiro e último item vendido num dia encerrado (`HH:MM`); sem nenhum, a loja não abriu. */
export interface SalesHours {
  readonly date: string;
  readonly first: string | null;
  readonly last: string | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const ID = /^\d{1,20}$/;
/** Leituras finais de um dia encerrado, para itens atrasados e cancelamentos tardios. */
const CLOSING_READS = 2;
/** Depois da meia-noite, o caixa ainda leva alguns minutos para mandar as últimas vendas. */
const CLOSING_AFTER_MINUTES = 15;
/** Dias sem leitura (servidor fora do ar) recuperados de uma vez, no máximo. */
const MAX_GAP_DAYS = 7;
/**
 * Só considera atraso relevante após 2h30 de horário de venda sem item mais recente.
 * Além deste limite, o aviso exige leituras válidas do dia com o mesmo último horário,
 * observadas por ao menos uma hora. O mero passar do tempo não confirma atraso na origem.
 */
export const SALES_DELAY_MINUTES = 150;
/** Semanas de histórico do horário de cada dia da semana. */
const HOURS_WEEKS = 4;
const SALES_OBSERVATION_CONFIRM_MS = 60 * 60_000;
/** Tolera o ciclo de uma hora e sua margem de execução, sem confiar em leitura antiga. */
const SALES_OBSERVATION_MAX_AGE_MS = 90 * 60_000;

export const saleEventId = (date: string, id: string) => `venda:${date}:${id}`;
export const voidEventId = (date: string, id: string) => `cancelamento:${date}:${id}`;

/**
 * Catálogo inteiro da loja. A descrição é a de venda — a que o caixa imprime e distingue
 * formas como "OFERTA_" e "GELADO" —, com a do produto como reserva. Grupo, categoria, preço
 * de venda e a linha inteira da origem acompanham cada produto.
 *
 * Todos os códigos de barras ficam, sem o limite de 50 por produto do contrato de importação,
 * que este catálogo não usa: é por eles que o coletor acha o produto lido. Na loja-piloto, um
 * incenso vendido numa forma só tem 233 códigos, um por aroma.
 */
export function pagonetCatalog(
  produtos: readonly PagonetProduct[],
  codigos: readonly PagonetBarcode[],
): { products: CatalogProduct[]; issues: ReportIssue[] } {
  const forms = new Set(produtos.map((product) => product.codformavenda.trim()));
  return buildCatalog(
    produtos.map((product) => ({
      codprod: product.codprod,
      codformavenda: product.codformavenda,
      descricao: product.descricao_venda?.trim() || product.descricao,
      ativo: product.ativo.trim() === '1',
      details: {
        group: product.codgrupo?.trim() || null,
        category: product.codcategoria?.trim() || null,
        salePrice: product.preco_venda ?? null,
        attributes: product.raw ?? null,
      },
    })),
    codigos
      .filter((code) => forms.has(code.codformavenda.trim()))
      .map((code) => ({ codformavenda: code.codformavenda, ean: code.codigo_barras })),
    Number.POSITIVE_INFINITY,
  );
}

function zoneParts(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** Deslocamento do fuso naquele instante, em milissegundos (−3 h → −10.800.000). */
function zoneOffset(instant: number, timeZone: string): number {
  const p = zoneParts(new Date(instant), timeZone);
  const local = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return local - Math.floor(instant / 1000) * 1000;
}

/**
 * Data e hora do relógio da loja viram instante UTC: `2026-10-12` + `10:32` em
 * America/Sao_Paulo → `2026-10-12T13:32:00.000Z`. Duas passadas acertam o deslocamento
 * também nos fusos com horário de verão.
 */
export function localInstant(date: string, time: string, timeZone: string): string {
  if (!DATE.test(date) || !TIME.test(time))
    throw new Error(`Data ou hora inválida: ${date} ${time}`);
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let instant = wall - zoneOffset(wall, timeZone);
  instant = wall - zoneOffset(instant, timeZone);
  return new Date(instant).toISOString();
}

/** Data civil (`AAAA-MM-DD`) e minutos desde a meia-noite no fuso da loja. */
export function localClock(instant: Date, timeZone: string): { date: string; minutes: number } {
  const p = zoneParts(instant, timeZone);
  const pad = (value: number) => String(value).padStart(2, '0');
  return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, minutes: p.hour * 60 + p.minute };
}

function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher), `AAAA-MM-DD`. */
function easter(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const h =
    (19 * a + b - Math.floor(b / 4) - Math.floor((b - Math.floor((b + 8) / 25) + 1) / 3) + 15) % 30;
  const l = (32 + 2 * (b % 4) + 2 * Math.floor(c / 4) - h - (c % 4)) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Feriados nacionais fixos, mais carnaval, Sexta-feira Santa e Corpus Christi. */
const HOLIDAYS = ['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25'];

export function nationalHoliday(date: string): boolean {
  if (HOLIDAYS.includes(date.slice(5))) return true;
  const sunday = easter(Number(date.slice(0, 4)));
  return [-48, -47, -2, 60].some((days) => shiftDate(sunday, days) === date);
}

/**
 * Dia da semana da data civil para o horário da loja: `0` = domingo. Feriado nacional conta
 * como domingo — o comércio costuma abrir em horário de domingo, e o dia não deve encolher o
 * horário aprendido do dia da semana em que caiu.
 */
function weekday(date: string): string {
  return nationalHoliday(date) ? '0' : String(new Date(`${date}T00:00:00Z`).getUTCDay());
}

/** `HH:MM` → minutos desde a meia-noite. */
function clockMinutes(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

/**
 * Itens vendidos de um dia. Linhas sem produto são ignoradas (não são itens); linhas
 * com formato inesperado vão para `invalid` em vez de virarem venda com dado inventado.
 * O minuto vira o instante de início dele: a venda no mesmo minuto de uma contagem
 * conta como anterior — quando passou no caixa, o produto já tinha saído da gôndola.
 */
export function readSales(
  rows: readonly PagonetSale[],
  date: string,
  timeZone: string,
): { items: SaleItem[]; presentIds: Set<string>; ignored: number; invalid: string[] } {
  const items: SaleItem[] = [];
  const presentIds = new Set<string>();
  const invalid: string[] = [];
  let ignored = 0;
  for (const row of rows) {
    const id = String(row.id).trim();
    const productId = row.codprod?.trim();
    if (!productId) {
      ignored++;
      continue;
    }
    if (
      !ID.test(id) ||
      row.data?.slice(0, 10) !== date ||
      !TIME.test(row.hora ?? '') ||
      typeof row.qtd !== 'number' ||
      !Number.isFinite(row.qtd) ||
      row.qtd <= 0
    ) {
      invalid.push(id || '(sem id)');
      continue;
    }
    presentIds.add(id);
    items.push({
      id,
      productId,
      quantity: row.qtd,
      time: row.hora,
      occurredAt: localInstant(date, row.hora, timeZone),
    });
  }
  return { items, presentIds, ignored, invalid };
}

export function saleEvent(date: string, item: SaleItem): SaleEvent {
  return {
    externalEventId: saleEventId(date, item.id),
    externalProductId: item.productId,
    type: 'SALE',
    quantity: item.quantity,
    occurredAt: item.occurredAt,
  };
}

export function voidEvent(
  date: string,
  id: string,
  productId: string,
  detectedAt: string,
): VoidEvent {
  return {
    externalEventId: voidEventId(date, id),
    externalProductId: productId,
    type: 'VOID_MOVEMENT',
    occurredAt: detectedAt,
    originalExternalEventId: saleEventId(date, id),
  };
}

/**
 * Vendas importadas que sumiram da origem. A rota só lista itens não cancelados: o item
 * cancelado depois de importado desaparece da leitura seguinte. Duas leituras seguidas
 * sem ele confirmam o cancelamento; uma só pode ser resposta incompleta. Muitos sumindo de
 * uma vez também parece falha da origem, não cancelamento: aí nada é cancelado.
 */
export function decideVoids(
  importedIds: readonly string[],
  presentIds: ReadonlySet<string>,
  missing: Readonly<Record<string, number>>,
): { confirmed: string[]; missing: Record<string, number>; suspicious: boolean } {
  const gone = importedIds.filter((id) => !presentIds.has(id));
  if (gone.length > Math.max(5, Math.ceil(importedIds.length * 0.1)))
    return { confirmed: [], missing: { ...missing }, suspicious: true };
  const confirmed: string[] = [];
  const next: Record<string, number> = {};
  for (const id of gone) {
    const reads = (missing[id] ?? 0) + 1;
    if (reads >= 2) confirmed.push(id);
    else next[id] = reads;
  }
  return { confirmed: confirmed.sort(), missing: next, suspicious: false };
}

/**
 * Qual dia ler agora. Normalmente hoje. Um dia que acabou ainda recebe duas leituras
 * finais, a partir de meia-noite e quinze, para itens que o caixa mandou atrasados e
 * cancelamentos tardios. Dias que ficaram sem nenhuma leitura (servidor parado) entram
 * na fila, até sete para trás, para nenhuma venda se perder. A primeira leitura de todas é
 * a do dia anterior, para aprender o horário da loja.
 */
export function planSalesRead(
  state: SalesState,
  today: string,
  minutesSinceMidnight: number,
): { date: string; state: SalesState } {
  const days: Record<string, DayState> = {};
  for (const [date, day] of Object.entries(state.days ?? {}))
    if (DATE.test(date) && date <= today)
      days[date] = { closingReads: day.closingReads ?? 0, missing: { ...(day.missing ?? {}) } };
  const known = Object.keys(days).sort();
  const last = known.at(-1);
  // Primeira leitura: o dia anterior, inteiro, ensina o horário da loja logo de início. As
  // vendas dele são anteriores a qualquer contagem e não mexem em saldo; uma leitura basta.
  if (!last && !state.hours)
    days[shiftDate(today, -1)] = { closingReads: CLOSING_READS - 1, missing: {} };
  if (last && last < today) {
    // Dias entre a última leitura e hoje, que nunca foram lidos — os mais recentes.
    const oldest = shiftDate(today, -MAX_GAP_DAYS);
    let date = shiftDate(last, 1) < oldest ? oldest : shiftDate(last, 1);
    while (date < today) {
      days[date] ??= { closingReads: 0, missing: {} };
      date = shiftDate(date, 1);
    }
  }
  days[today] ??= { closingReads: 0, missing: {} };
  const pending = Object.keys(days)
    .filter((date) => date < today && days[date]!.closingReads < CLOSING_READS)
    .sort();
  const yesterday = shiftDate(today, -1);
  // O dia anterior espera os quinze minutos; dias mais antigos já podem ser lidos.
  const next = pending.find(
    (date) => date < yesterday || minutesSinceMidnight >= CLOSING_AFTER_MINUTES,
  );
  // Encerrados há mais de um dia saem do estado.
  for (const date of Object.keys(days))
    if (date < yesterday && days[date]!.closingReads >= CLOSING_READS) delete days[date];
  return { date: next ?? today, state: { ...state, days } };
}

/**
 * Registra a leitura feita: conta como final se o dia já acabou. A leitura final traz o dia
 * inteiro, e dela sai o horário em que a loja vendeu naquele dia da semana.
 */
export function recordSalesRead(
  state: SalesState,
  date: string,
  today: string,
  missing: Record<string, number>,
  times: readonly string[] = [],
): SalesState {
  const day = state.days[date] ?? { closingReads: 0, missing: {} };
  const closing = date < today;
  const days = {
    ...state.days,
    [date]: { closingReads: day.closingReads + (closing ? 1 : 0), missing },
  };
  if (!closing) return { ...state, days, lastReadDate: date };
  const sorted = [...times].sort();
  const seen = { date, first: sorted[0] ?? null, last: sorted.at(-1) ?? null };
  const key = weekday(date);
  return {
    ...state,
    days,
    lastReadDate: date,
    hours: {
      ...state.hours,
      // A segunda leitura final do dia substitui a primeira.
      [key]: [seen, ...(state.hours?.[key] ?? []).filter((item) => item.date !== date)]
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, HOURS_WEEKS),
    },
  };
}

/**
 * Horário em que a loja costuma vender naquele dia da semana, em minutos: o mais largo das
 * últimas semanas, para um dia com vendas faltando não encolher o horário. Sem nenhuma
 * venda nas semanas vistas, a loja não abre. Dia de semana ainda não visto usa o horário dos
 * dias já vistos; domingo costuma ser mais curto e, sem histórico, fica sem expectativa —
 * horário largo demais acusaria atraso com a loja fechada.
 */
function usualHours(
  hours: Readonly<Record<string, readonly SalesHours[]>>,
  day: string,
): { first: number; last: number } | null {
  const seen = hours[day] ?? (day === '0' ? [] : Object.values(hours).flat());
  const open = seen.filter((item) => item.first && item.last);
  if (!open.length) return null;
  return {
    first: Math.min(...open.map((item) => clockMinutes(item.first!))),
    last: Math.max(...open.map((item) => clockMinutes(item.last!))),
  };
}

function withinUsualHours(state: SalesState, date: string, minutes: number): boolean {
  const usual = usualHours(state.hours ?? {}, weekday(date));
  return !!usual && minutes >= usual.first && minutes <= usual.last;
}

/**
 * Registra uma consulta concluída. Várias leituras forçadas próximas preservam o início
 * da mesma observação; não é necessário esperar uma hora entre duas consultas adjacentes.
 * Dias antigos, falhas, dados inválidos e leituras fora do expediente interrompem a sequência.
 */
export function recordSalesObservation(
  state: SalesState,
  input: {
    date: string;
    today: string;
    minutes: number;
    through: string | null;
    observedAt: Date;
    valid: boolean;
  },
): SalesState {
  const { date, today, minutes, through, observedAt, valid } = input;
  const observed = observedAt.getTime();
  const read = { ...state, lastReadDate: date };
  if (
    !valid ||
    date !== today ||
    !Number.isFinite(observed) ||
    !withinUsualHours(state, today, minutes)
  )
    return { ...read, freshness: null };

  const previous = state.freshness;
  const first = previous ? Date.parse(previous.firstSeenAt) : NaN;
  const last = previous ? Date.parse(previous.lastSeenAt) : NaN;
  const continued =
    previous?.date === date &&
    previous.through === through &&
    Number.isFinite(first) &&
    Number.isFinite(last) &&
    first <= last &&
    last <= observed &&
    observed - last <= SALES_OBSERVATION_MAX_AGE_MS;
  const stamp = observedAt.toISOString();
  return {
    ...read,
    freshness: {
      date,
      through,
      firstSeenAt: continued ? previous.firstSeenAt : stamp,
      lastSeenAt: stamp,
      backlogMinutes: salesBacklog(state, through, today, minutes),
    },
  };
}

/** Um aviso requer evidência recente; atualizar a tela não substitui consultar a origem. */
export function hasConfirmedSalesDelay(
  state: SalesState | null | undefined,
  through: string | null,
  today: string,
  minutes: number,
  now: Date,
): boolean {
  const observation = state?.freshness;
  if (
    !state ||
    state.lastReadDate !== today ||
    !observation ||
    observation.date !== today ||
    observation.through !== through ||
    !withinUsualHours(state, today, minutes)
  )
    return false;
  const first = Date.parse(observation.firstSeenAt);
  const last = Date.parse(observation.lastSeenAt);
  const current = now.getTime();
  return (
    Number.isFinite(first) &&
    Number.isFinite(last) &&
    Number.isFinite(current) &&
    last - first >= SALES_OBSERVATION_CONFIRM_MS &&
    last <= current &&
    current - last <= SALES_OBSERVATION_MAX_AGE_MS &&
    Number.isFinite(observation.backlogMinutes) &&
    observation.backlogMinutes >= SALES_DELAY_MINUTES
  );
}

/**
 * Quanto do horário em que a loja costuma vender passou sem chegar venda nenhuma: minutos
 * desde a venda mais recente recebida (`AAAA-MM-DD HH:MM`, horário da loja) até agora,
 * contando só os trechos em que ela vende. Madrugada e loja fechada não contam: aí não
 * vender é o normal. Sem histórico do horário não há como saber, e o atraso é zero.
 */
export function salesBacklog(
  state: SalesState | null | undefined,
  through: string | null,
  today: string,
  minutesSinceMidnight: number,
): number {
  const hours = state?.hours ?? {};
  const oldest = shiftDate(today, -MAX_GAP_DAYS);
  const [fromDate, fromTime] = through?.split(' ') ?? [oldest, '00:00'];
  let backlog = 0;
  for (
    let date = fromDate! < oldest ? oldest : fromDate!;
    date <= today;
    date = shiftDate(date, 1)
  ) {
    const usual = usualHours(hours, weekday(date));
    if (!usual) continue;
    const start = Math.max(usual.first, date === fromDate ? clockMinutes(fromTime!) : 0);
    const end = Math.min(usual.last, date === today ? minutesSinceMidnight : 1440);
    backlog += Math.max(0, end - start);
  }
  return backlog;
}
