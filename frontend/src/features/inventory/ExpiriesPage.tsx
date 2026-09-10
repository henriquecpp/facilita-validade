import type { CSSProperties } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { Button, Tab, Tabs } from '@mui/material';
import { useApiQuery } from '../../shared/api/hooks';
import { queryString } from '../../shared/api/client';
import type { ExpiryItem, ExpiryLevelSummary, ExpirySummary, Page } from '../../shared/api/types';
import {
  Empty,
  ErrorState,
  Icon,
  LevelBadge,
  Loading,
  PageNav,
  PageTitle,
} from '../../shared/ui/components';
import { formatDate, integer, money } from '../../shared/lib/format';
import { describeRange, expiryText, forecastText } from '../../shared/lib/risk';

/** Um lote na lista de validades, na cor do nível da loja; leva ao produto. */
export function ExpiryRow({ item }: { item: ExpiryItem }) {
  const detail = [item.lotCode && `Lote ${item.lotCode}`, item.barcode].filter(Boolean).join(' · ');
  const forecast = forecastText(item.forecastLeftover, item.quantity);
  return (
    <Link className="expiry-row" to={`/products/${item.productId}`}>
      <LevelBadge color={item.levelColor} name={item.levelName}>
        {expiryText(item.daysToExpiry)}
      </LevelBadge>
      <span className="expiry-product">
        <strong>{item.productName}</strong>
        <small>{detail || 'Lote não informado'}</small>
        {forecast && (
          <small className={`forecast ${forecast.ok ? 'ok' : 'risk'}`}>{forecast.text}</small>
        )}
      </span>
      <span className="expiry-date">
        <small>Validade</small>
        {formatDate(item.expiresOn)}
      </span>
      <span className="expiry-qty">
        <strong>{integer(item.quantity)}</strong>
        <small>{item.quantity === 1 ? 'unidade' : 'unidades'}</small>
      </span>
      <Icon name="chevron" />
    </Link>
  );
}

/** Uma aba por nível da loja, a faixa sem nível quando há lote nela, e todos os lotes. */
const ALL = 'ALL';
const NONE = 'NONE';
const SIZES = [25, 50, 100];
const DEFAULT_SIZE = 25;

const keyOf = (level: ExpiryLevelSummary) => level.levelId ?? NONE;

function describe(level: ExpiryLevelSummary | null) {
  if (!level)
    return {
      title: 'Todos os lotes com saldo',
      hint: 'Do que vence primeiro ao último.',
      empty: 'Nenhum lote com saldo na loja.',
    };
  if (!level.levelId)
    return {
      title: 'Sem nível',
      hint: 'Lotes fora das faixas de todos os níveis da loja. Ajuste os níveis em Configurações.',
      empty: 'Nenhum lote fora dos níveis.',
    };
  const expired = level.maxDays != null && level.maxDays < 0;
  return {
    title: `${level.name}: ${describeRange(level)}`,
    hint: expired
      ? 'Retire da área de venda e dê baixa nos lotes vencidos.'
      : level.notify
        ? 'Confira na gôndola e priorize a venda destes lotes.'
        : 'Validade fora dos prazos de aviso.',
    empty: `Nenhum lote em ${level.name}.`,
  };
}

/** Sem aba escolhida, abre no nível mais urgente que avisa e tem lotes. */
function urgentBand(summary: ExpirySummary): string {
  const filled = summary.items.find((item) => item.levelId && item.notify && item.lots > 0);
  return filled ? keyOf(filled) : ALL;
}

export function ExpiriesPage() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const summary = useApiQuery<ExpirySummary>('/inventory/expiries/summary', { poll: true });
  const levels = summary.data?.items ?? [];
  const requested = params.get('nivel');
  const band: string | null =
    requested && (requested === ALL || levels.some((level) => keyOf(level) === requested))
      ? requested
      : summary.data
        ? urgentBand(summary.data)
        : null;
  const current = levels.find((level) => keyOf(level) === band) ?? null;
  const size = SIZES.includes(Number(params.get('size')))
    ? Number(params.get('size'))
    : DEFAULT_SIZE;
  // As páginas andam por cursor: o de cada página visitada fica no histórico do navegador, e
  // voltar de um produto devolve a mesma página. Link aberto direto numa página volta à primeira.
  const cursors = (location.state as { cursors?: (string | null)[] } | null)?.cursors ?? [null];
  const asked = Math.max(1, Number(params.get('page')) || 1) - 1;
  const page = asked < cursors.length && (asked === 0 || cursors[asked]) ? asked : 0;
  const total = levels.reduce((sum, item) => sum + item.lots, 0);
  const go = (next: { band?: string; size?: number; page?: number }, stack?: (string | null)[]) => {
    const target = next.band ?? band ?? ALL;
    const targetSize = next.size ?? size;
    const query: Record<string, string> = { nivel: target };
    if (targetSize !== DEFAULT_SIZE) query.size = String(targetSize);
    if (next.page) query.page = String(next.page + 1);
    setParams(query, stack ? { state: { cursors: stack } } : undefined);
  };
  return (
    <>
      <PageTitle
        title="Validades"
        description="Lotes com saldo na loja, separados pelos níveis de urgência da loja. Toque em um lote para ver o produto."
      />
      <section className="surface table-surface">
        {summary.isError && !summary.data ? (
          <ErrorState error={summary.error} retry={() => void summary.refetch()} />
        ) : !band ? (
          <Loading />
        ) : (
          <>
            <Tabs
              value={band}
              onChange={(_, next: string) => go({ band: next })}
              variant="scrollable"
              scrollButtons="auto"
              allowScrollButtonsMobile
              className="band-tabs"
              aria-label="Níveis de urgência"
            >
              {levels.map((level) => (
                <Tab
                  key={keyOf(level)}
                  value={keyOf(level)}
                  label={
                    <span className="band-label">
                      <span className="band-dot" style={{ background: level.color }} aria-hidden />
                      {level.name}
                      <span className="band-count">{integer(level.lots)}</span>
                    </span>
                  }
                />
              ))}
              <Tab
                value={ALL}
                label={
                  <span className="band-label">
                    Todos
                    <span className="band-count">{integer(total)}</span>
                  </span>
                }
              />
            </Tabs>
            <BandList
              key={`${band}:${size}`}
              band={band}
              level={current}
              levels={levels}
              size={size}
              page={page}
              cursor={cursors[page] ?? null}
              onPage={(next, nextCursor) => {
                go(
                  { page: next },
                  next > page ? [...cursors.slice(0, page + 1), nextCursor] : cursors,
                );
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
              onSize={(next) => go({ size: next })}
              onFirst={() => go({})}
            />
          </>
        )}
      </section>
    </>
  );
}

function BandList({
  band,
  level,
  levels,
  size,
  page,
  cursor,
  onPage,
  onSize,
  onFirst,
}: {
  band: string;
  level: ExpiryLevelSummary | null;
  levels: ExpiryLevelSummary[];
  size: number;
  page: number;
  cursor: string | null;
  onPage: (page: number, cursor: string | null) => void;
  onSize: (size: number) => void;
  onFirst: () => void;
}) {
  const info = describe(level);
  const query = useApiQuery<Page<ExpiryItem>>(
    `/inventory/expiries${queryString({ levelId: band === ALL ? undefined : band, limit: size, cursor })}`,
    { poll: true },
  );
  const shown = level ? [level] : levels;
  const lots = shown.reduce((sum, item) => sum + item.lots, 0);
  const units = shown.reduce((sum, item) => sum + item.units, 0);
  const value = shown.reduce((sum, item) => sum + (item.value ?? 0), 0);
  const items = query.data?.items ?? [];
  return (
    <div className="band" style={level ? ({ '--level': level.color } as CSSProperties) : undefined}>
      <div className="band-head">
        <h2>{info.title}</h2>
        <span className="band-stats">
          {integer(lots)} {lots === 1 ? 'lote' : 'lotes'} · {integer(units)}{' '}
          {units === 1 ? 'unidade' : 'unidades'}
          {value > 0 && ` · ${money(value)} em preço de venda`}
        </span>
        <p>{info.hint}</p>
      </div>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : !items.length ? (
        page > 0 ? (
          <Empty
            icon="calendar"
            title="Nada nesta página"
            description="Os lotes mudaram desde que a lista foi aberta."
            action={
              <Button variant="outlined" onClick={onFirst}>
                Ir para a primeira página
              </Button>
            }
          />
        ) : band === ALL ? (
          <Empty
            icon="calendar"
            title="Nenhum lote com saldo"
            description="As validades aparecem aqui depois da contagem inicial de cada produto."
            action={
              <Button component={Link} to="/products" variant="outlined">
                Ir para Produtos
              </Button>
            }
          />
        ) : (
          <Empty icon="check" title={info.empty} />
        )
      ) : (
        <>
          <div className="expiry-list">
            {items.map((item) => (
              <ExpiryRow key={item.id} item={item} />
            ))}
          </div>
          {/* Uma página só, no tamanho padrão: a barra seria só ruído. */}
          {(page > 0 || !!query.data.nextCursor || size !== DEFAULT_SIZE) && (
            <PageNav
              page={page}
              size={size}
              sizes={SIZES}
              shown={items.length}
              total={lots}
              hasNext={!!query.data.nextCursor}
              onPrevious={() => onPage(page - 1, null)}
              onNext={() => onPage(page + 1, query.data.nextCursor)}
              onSize={onSize}
            />
          )}
        </>
      )}
    </div>
  );
}
