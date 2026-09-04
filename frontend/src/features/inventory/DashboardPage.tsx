import { useState } from 'react';
import { Alert, Button, Typography } from '@mui/material';
import { Link, useNavigate } from 'react-router-dom';
import type { UseQueryResult } from '@tanstack/react-query';
import { useApiQuery } from '../../shared/api/hooks';
import { useDashboard, useExpiryRules } from '../../shared/api/store';
import type { Dashboard, ExpiryItem, Page } from '../../shared/api/types';
import {
  Empty,
  ErrorState,
  Icon,
  Loading,
  MetricCard,
  PageTitle,
} from '../../shared/ui/components';
import { compactMoney, formatDate, integer, longToday, money } from '../../shared/lib/format';
import { useAuth } from '../auth/AuthProvider';
import { ExpiryRow } from './ExpiriesPage';
import { EntryDialog } from '../products/EntryDialog';
import { expiringLevel } from '../../shared/lib/expiry-navigation';

export function DashboardPage() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const manager = session?.user.role !== 'OPERATOR';
  const query = useDashboard();
  const rules = useExpiryRules();
  const [entry, setEntry] = useState(false);
  // A lista já vem em ordem de validade: os primeiros são os mais urgentes.
  // Só os níveis que avisam, já filtrados no servidor: os primeiros lotes da loja podem estar
  // num nível que não avisa e esconder os que avisam.
  const soon = useApiQuery<Page<ExpiryItem>>('/inventory/expiries?limit=8&notify=true', {
    poll: true,
  });
  const expired = rules.levels.find((level) => level.maxDays != null && level.maxDays < 0);
  const expiring = expiringLevel(rules.levels);
  return (
    <>
      <PageTitle
        title="Sua loja, em dia"
        description={`${longToday(rules.timezone)}. Veja o que precisa de atenção hoje.`}
        action={
          <Button
            variant="contained"
            startIcon={<Icon name="plus" size={18} />}
            onClick={() => setEntry(true)}
          >
            Nova entrada
          </Button>
        }
      />
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : (
        <>
          {query.data.salesDelayed && (
            <Alert
              severity="warning"
              sx={{ mb: 3 }}
              action={
                manager ? (
                  <Button
                    component={Link}
                    to="/imports"
                    color="inherit"
                    size="small"
                    sx={{ whiteSpace: 'nowrap' }}
                  >
                    Ver integração
                  </Button>
                ) : undefined
              }
            >
              <strong>Possível atraso nas vendas.</strong>{' '}
              {query.data.salesThroughAt ? (
                <>
                  As últimas consultas não trouxeram vendas posteriores a{' '}
                  {formatDate(query.data.salesThroughAt)}. Se houve vendas depois desse horário, os
                  saldos podem estar acima do real.
                </>
              ) : (
                <>
                  As últimas consultas não trouxeram vendas. Se a loja já vendeu hoje, os saldos
                  podem estar acima do real.
                </>
              )}
            </Alert>
          )}
          <div className="metric-grid">
            <MetricCard
              label="Vencidos sem baixa"
              value={query.data.expiredRecords}
              help={
                query.data.expiredValue
                  ? `${money(query.data.expiredValue)} perdidos em lotes vencidos ainda com saldo`
                  : 'Lotes vencidos com saldo na loja: retire da venda e dê baixa'
              }
              tone="danger"
              icon="issues"
              to={expired ? `/expiries?nivel=${expired.id}` : '/expiries'}
            />
            <MetricCard
              label="A vencer"
              value={query.data.atRiskRecords}
              help={
                (query.data.expiringValue
                  ? `${money(query.data.expiringValue)} em lotes nos níveis que avisam`
                  : 'Lotes nos níveis de urgência que avisam') +
                (query.data.sellingInTimeRecords
                  ? ` · ${integer(query.data.sellingInTimeRecords)} ${
                      query.data.sellingInTimeRecords === 1 ? 'deve' : 'devem'
                    } vender antes de vencer`
                  : '')
              }
              tone="warning"
              icon="calendar"
              to={expiring ? `/expiries?nivel=${encodeURIComponent(expiring.id)}` : '/expiries'}
            />
            <MetricCard
              label="Valor em estoque"
              value={query.data.stockValue ?? 0}
              display={compactMoney(query.data.stockValue ?? 0)}
              help={
                query.data.unpricedLots
                  ? `Pelo preço de venda · ${integer(query.data.unpricedLots)} lotes sem preço`
                  : 'Pelo preço de venda dos lotes controlados'
              }
              icon="money"
            />
            <MetricCard
              label="Produtos controlados"
              value={query.data.trackedProducts}
              help="Com contagem confirmada"
              icon="stock"
              to="/products?situacao=TRACKED"
            />
          </div>
          <div className="chart-grid">
            <LevelsChart data={query.data} />
            <WeeksChart data={query.data} />
          </div>
          <div className="dashboard-grid">
            <section className="surface">
              <div className="surface-heading">
                <div>
                  <Typography variant="h6" component="h2">
                    Vencendo primeiro
                  </Typography>
                  <span className="muted">Lotes nos níveis que avisam, do que vence antes</span>
                </div>
                <Button component={Link} to="/expiries" size="small">
                  Ver todas as validades →
                </Button>
              </div>
              <SoonList
                query={soon}
                counted={(query.data.levels ?? []).some((level) => level.lots > 0)}
              />
            </section>
            <div className="dashboard-side">
              <section className="surface">
                <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
                  Atalhos
                </Typography>
                <Link className="quick-link" to="/products">
                  <Icon name="search" />
                  <span>
                    <strong>Consultar um produto</strong>
                    <small>Lotes, validades, contagens e movimentações</small>
                  </span>
                </Link>
                <button type="button" className="quick-link" onClick={() => setEntry(true)}>
                  <Icon name="receipt" />
                  <span>
                    <strong>Registrar entrada</strong>
                    <small>Mercadoria que chegou, por validade</small>
                  </span>
                </button>
                <Link className="quick-link" to="/alerts">
                  <Icon name="bell" />
                  <span>
                    <strong>Ver alertas</strong>
                    <small>
                      {query.data.unreadNotifications
                        ? `${integer(query.data.unreadNotifications)} ainda não lidos`
                        : 'Nenhum alerta novo'}
                    </small>
                  </span>
                </Link>
              </section>
              <section className="surface">
                <Typography variant="h6" component="h2" sx={{ mb: 1.5 }}>
                  Dados do sistema da loja
                </Typography>
                <dl className="facts">
                  {/* Com a Pagonet, o que importa é até quando as vendas chegaram, não a leitura. */}
                  {query.data.salesThroughAt ? (
                    <div>
                      <dt>Vendas recebidas até</dt>
                      <dd>{formatDate(query.data.salesThroughAt)}</dd>
                    </div>
                  ) : (
                    <div>
                      <dt>Última importação</dt>
                      <dd>
                        {query.data.lastImportAt
                          ? formatDate(query.data.lastImportAt)
                          : 'Nenhuma importação recebida'}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt>Importações na fila</dt>
                    <dd>{integer(query.data.pendingImports)}</dd>
                  </div>
                </dl>
              </section>
            </div>
          </div>
        </>
      )}
      <EntryDialog
        open={entry}
        onClose={() => setEntry(false)}
        onSaved={(detail) => navigate(`/products/${detail.product.id}`)}
      />
    </>
  );
}

/** Lotes com saldo em cada nível da loja: barra única dividida nas cores dos níveis. */
function LevelsChart({ data }: { data: Dashboard }) {
  const levels = (data.levels ?? []).filter((level) => level.lots > 0);
  const lots = levels.reduce((sum, level) => sum + level.lots, 0);
  return (
    <section className="surface chart-card">
      <Typography variant="h6" component="h2">
        Lotes por nível de urgência
      </Typography>
      <span className="muted">Lotes com saldo e o valor deles pelo preço de venda</span>
      {!lots ? (
        <Empty icon="calendar" title="Nenhum lote com saldo" />
      ) : (
        <>
          <div
            className="stack-bar"
            role="img"
            aria-label={levels.map((level) => `${level.name}: ${level.lots} lotes`).join(', ')}
          >
            {levels.map((level) => (
              <span
                key={level.levelId ?? 'none'}
                style={{ flexGrow: level.lots, background: level.color }}
                title={`${level.name}: ${integer(level.lots)} lotes`}
              />
            ))}
          </div>
          <ul className="chart-legend">
            {(data.levels ?? []).map((level) => (
              <li key={level.levelId ?? 'none'}>
                <span className="legend-dot" style={{ background: level.color }} aria-hidden />
                <span className="legend-name">{level.name}</span>
                <span className="legend-value">
                  {integer(level.lots)} {level.lots === 1 ? 'lote' : 'lotes'}
                </span>
                <span className="legend-value muted">{money(level.value)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** O que vence em cada uma das próximas semanas, em R$ pelo preço de venda. */
function WeeksChart({ data }: { data: Dashboard }) {
  const weeks = data.upcomingWeeks ?? [];
  const byValue = weeks.some((week) => week.value > 0);
  const measure = (week: (typeof weeks)[number]) => (byValue ? week.value : week.units);
  const top = Math.max(...weeks.map(measure), 0);
  return (
    <section className="surface chart-card">
      <Typography variant="h6" component="h2">
        A vencer nas próximas semanas
      </Typography>
      <span className="muted">
        {byValue ? 'Valor pelo preço de venda dos lotes com saldo' : 'Unidades dos lotes com saldo'}
      </span>
      {!top ? (
        <Empty icon="check" title="Nada vence nas próximas semanas" />
      ) : (
        <div className="week-bars" role="list">
          {weeks.map((week) => (
            <div className="week-bar" role="listitem" key={week.fromDays}>
              <span className="week-value">
                {byValue ? compactMoney(week.value) : integer(week.units)}
              </span>
              <span className="week-track">
                <span
                  className="week-fill"
                  style={{ height: `${Math.max(2, (measure(week) / top) * 100)}%` }}
                />
              </span>
              <span className="week-label">
                {week.fromDays === 0 ? 'Até 6 dias' : `${week.fromDays}–${week.toDays} dias`}
              </span>
              <span className="week-lots muted">
                {integer(week.lots)} {week.lots === 1 ? 'lote' : 'lotes'}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** Lotes nos níveis que avisam, do que vence antes; `counted` diz se a loja tem algum lote. */
function SoonList({
  query,
  counted,
}: {
  query: UseQueryResult<Page<ExpiryItem>>;
  counted: boolean;
}) {
  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  const items = query.data.items;
  if (!items.length)
    return (
      <Empty
        icon="check"
        title="Nada vencido nem vencendo"
        description={
          counted
            ? 'Nenhum lote nos níveis de urgência que avisam.'
            : 'As validades aparecem aqui depois da contagem inicial dos produtos.'
        }
      />
    );
  return (
    <div className="expiry-list">
      {items.map((item) => (
        <ExpiryRow key={item.id} item={item} />
      ))}
    </div>
  );
}
