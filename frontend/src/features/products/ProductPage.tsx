import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import { useApiQuery, useBusinessMutation } from '../../shared/api/hooks';
import { ApiError, queryString } from '../../shared/api/client';
import { useExpiryRules } from '../../shared/api/store';
import type {
  CountSession,
  InventoryDetail,
  Page,
  Product,
  StockRecord,
} from '../../shared/api/types';
import {
  Empty,
  ErrorState,
  ExpiryBadge,
  Icon,
  Loading,
  PageTitle,
  Pagination,
  RiskBadge,
  Status,
} from '../../shared/ui/components';
import { decimal, formatDate, integer, units } from '../../shared/lib/format';
import { forecastText } from '../../shared/lib/risk';
import { recordOriginLabels, recordStatusLabels, recordStatusTone } from '../../shared/lib/labels';
import { useAuth } from '../auth/AuthProvider';
import { EntryDialog } from './EntryDialog';
import { DeleteLotDialog, EditLotDialog, WriteOffDialog } from './LotDialogs';

type LotAction = { kind: 'write-off' | 'edit' | 'delete'; lot: StockRecord };

/** Data e hora do lançamento e quem lançou (AV01, AV11): as vendas só saem depois dele. */
function Launch({ lot }: { lot: StockRecord }) {
  return (
    <span className="cell-stack">
      <span>{lot.launchedAt ? formatDate(lot.launchedAt) : '—'}</span>
      <small className="muted">
        {recordOriginLabels[lot.origin ?? ''] ?? 'Lançamento'}
        {lot.launchedBy ? ` · ${lot.launchedBy}` : ''}
      </small>
    </span>
  );
}

export function ProductPage() {
  const { productId } = useParams();
  const navigate = useNavigate();
  const { session } = useAuth();
  const owner = session?.user.role === 'OWNER';
  const rules = useExpiryRules();
  const [entry, setEntry] = useState(false);
  const [counting, setCounting] = useState(false);
  const [action, setAction] = useState<LotAction | null>(null);
  const query = useApiQuery<InventoryDetail>(`/inventory/products/${productId}`, { poll: true });
  const product = useApiQuery<Product>(`/products/${productId}`);
  const active = useApiQuery<Page<CountSession>>(
    `/count-sessions${queryString({ status: 'COUNTING', productId, limit: 1 })}`,
  );
  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  const detail = query.data;
  const untracked = detail.trackingStatus === 'UNTRACKED';
  const openCount = active.data?.items[0];
  const lots = detail.records;
  const next = lots[0];
  const barcodes = product.data?.barcodes ?? [];
  const canEnter = !untracked && detail.product.active && !openCount;
  return (
    <>
      <PageTitle
        back={{ to: '/products', label: 'Produtos' }}
        title={detail.product.description}
        description={
          <span className="title-meta">
            {barcodes.length > 0 && <span>{barcodes.join(' · ')}</span>}
            <Status value={detail.trackingStatus} />
            {!detail.product.active && (
              <Chip size="small" variant="outlined" label="Inativo no catálogo" />
            )}
          </span>
        }
        action={
          <>
            <Button
              disabled={query.isFetching}
              startIcon={<Icon name="refresh" size={18} />}
              onClick={() => {
                void query.refetch();
                void active.refetch();
              }}
            >
              Atualizar
            </Button>
            <Button
              component={Link}
              to={`/products/${productId}/movements`}
              startIcon={<Icon name="list" size={18} />}
            >
              Ver movimentações
            </Button>
            {openCount ? (
              <Button component={Link} to={`/counts/${openCount.id}`} variant="outlined">
                Continuar contagem
              </Button>
            ) : (
              <Button variant="outlined" onClick={() => setCounting(true)}>
                {untracked ? 'Contagem inicial' : 'Contar estoque'}
              </Button>
            )}
            <Button
              variant="contained"
              startIcon={<Icon name="plus" size={18} />}
              disabled={!canEnter}
              onClick={() => setEntry(true)}
            >
              Nova entrada
            </Button>
          </>
        }
      />
      {openCount && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Há uma contagem em andamento deste produto. Termine ou cancele a contagem antes de
          registrar entradas ou corrigir lotes.
        </Alert>
      )}
      {untracked && !openCount && (
        <Alert
          severity="info"
          sx={{ mb: 2 }}
          action={
            <Button color="inherit" size="small" onClick={() => setCounting(true)}>
              Contar agora
            </Button>
          }
        >
          Este produto ainda não é controlado. Conte todas as unidades na loja, separando por
          validade, para começar.
        </Alert>
      )}
      {detail.countWindowQuantity > 0 && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Houve movimentação de {integer(detail.countWindowQuantity)} unidade(s) enquanto a última
          contagem estava aberta. O saldo pode ter diferença de até essa quantidade; se precisar de
          precisão, faça uma nova contagem.
        </Alert>
      )}
      {detail.stale && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          Há movimentações em processamento. O saldo pode mudar em instantes.
        </Alert>
      )}
      <div className="stat-grid">
        <div className="stat">
          <span>Em estoque</span>
          <strong>{untracked ? 'Sem contagem' : units(detail.totalQuantity)}</strong>
          <small>Estimado pelas contagens, entradas, baixas e vendas</small>
        </div>
        <div className="stat">
          <span>Próxima validade</span>
          <strong>{next ? formatDate(next.expiresOn) : '—'}</strong>
          {next ? (
            <ExpiryBadge date={next.expiresOn} rules={rules} />
          ) : (
            <small>Sem lotes com saldo</small>
          )}
        </div>
        <div className="stat">
          <span>Última contagem</span>
          <strong>{formatDate(detail.lastCountAt)}</strong>
          <small>Saldo atualizado em {formatDate(detail.projectedAt)}</small>
        </div>
        {!untracked && (
          <div className="stat">
            <span>Venda média</span>
            <strong>
              {detail.dailySales === null || detail.dailySales === undefined
                ? '—'
                : `${decimal(detail.dailySales)} por dia`}
            </strong>
            <small>
              {detail.dailySales === null || detail.dailySales === undefined
                ? 'A previsão de venda começa com 7 dias de vendas lidas da Pagonet'
                : `Média de ${integer(detail.salesHistoryDays ?? 0)} dias de venda, até 6 meses; prevê a sobra de cada lote`}
            </small>
          </div>
        )}
      </div>
      <section className="surface table-surface">
        <div className="table-toolbar">
          <div>
            <Typography variant="h6" component="h2">
              Lotes ativos
            </Typography>
            <span className="muted">
              As vendas saem primeiro do lote que vence antes, e só dos lotes lançados antes da
              venda. Baixados e excluídos ficam no histórico abaixo.
            </span>
          </div>
        </div>
        {!lots.length ? (
          <Empty
            icon="calendar"
            title={untracked ? 'Nenhum lote registrado' : 'Nenhum lote com saldo'}
            description={
              untracked
                ? 'Os lotes e as validades aparecem depois da contagem inicial.'
                : 'Registre uma entrada quando chegar mercadoria.'
            }
          />
        ) : (
          <TableContainer>
            <Table className="lots-table responsive-table">
              <TableHead>
                <TableRow>
                  <TableCell>Validade</TableCell>
                  <TableCell>Lote</TableCell>
                  <TableCell>Lançado em</TableCell>
                  <TableCell align="right">Lançado</TableCell>
                  <TableCell align="right">Vendido</TableCell>
                  <TableCell align="right">Baixa manual</TableCell>
                  <TableCell align="right">Saldo</TableCell>
                  <TableCell>Observação</TableCell>
                  <TableCell align="right">Ações</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {lots.map((lot) => {
                  const forecast = forecastText(lot.forecastLeftover, lot.quantity);
                  return (
                    <TableRow key={lot.id}>
                      <TableCell className="cell-main" data-label="Validade">
                        <span className="expiry-cell">
                          {formatDate(lot.expiresOn)}
                          <ExpiryBadge date={lot.expiresOn} rules={rules} />
                        </span>
                        {forecast && (
                          <small className={`forecast lot-forecast ${forecast.ok ? 'ok' : 'risk'}`}>
                            {forecast.text}
                          </small>
                        )}
                      </TableCell>
                      <TableCell data-label="Lote">{lot.lotCode || 'Não informado'}</TableCell>
                      <TableCell data-label="Lançado em">
                        <Launch lot={lot} />
                      </TableCell>
                      <TableCell align="right" className="quantity-cell" data-label="Lançado">
                        {integer(lot.launchedQuantity ?? lot.quantity)}
                      </TableCell>
                      <TableCell align="right" className="quantity-cell" data-label="Vendido">
                        {integer(lot.soldQuantity ?? 0)}
                      </TableCell>
                      <TableCell align="right" className="quantity-cell" data-label="Baixa manual">
                        {integer(lot.writtenOffQuantity ?? 0)}
                      </TableCell>
                      <TableCell align="right" className="quantity-cell strong" data-label="Saldo">
                        {integer(lot.quantity)}
                      </TableCell>
                      <TableCell className="cell-wide" data-label="Observação">
                        {lot.note || '—'}
                      </TableCell>
                      <TableCell align="right" className="lot-actions cell-action cell-wide">
                        <Tooltip title="Movimentações deste lote">
                          <IconButton
                            size="small"
                            aria-label="Ver movimentações do lote"
                            onClick={() =>
                              navigate(`/products/${productId}/movements?recordId=${lot.id}`)
                            }
                          >
                            <Icon name="list" size={18} />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Dar baixa">
                          <span>
                            <IconButton
                              size="small"
                              aria-label="Dar baixa"
                              disabled={!!openCount}
                              onClick={() => setAction({ kind: 'write-off', lot })}
                            >
                              <Icon name="minus" size={18} />
                            </IconButton>
                          </span>
                        </Tooltip>
                        {owner && (
                          <Tooltip title="Editar validade ou quantidade">
                            <span>
                              <IconButton
                                size="small"
                                aria-label="Editar lote"
                                disabled={!!openCount}
                                onClick={() => setAction({ kind: 'edit', lot })}
                              >
                                <Icon name="edit" size={18} />
                              </IconButton>
                            </span>
                          </Tooltip>
                        )}
                        <Tooltip title="Excluir lote">
                          <span>
                            <IconButton
                              size="small"
                              aria-label="Excluir lote"
                              disabled={!!openCount}
                              onClick={() => setAction({ kind: 'delete', lot })}
                            >
                              <Icon name="trash" size={18} />
                            </IconButton>
                          </span>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </section>
      <ClosedLots productId={productId!} />
      <ProductCounts productId={productId!} />
      {action?.kind === 'write-off' && (
        <WriteOffDialog lot={action.lot} onClose={() => setAction(null)} />
      )}
      {action?.kind === 'edit' && (
        <EditLotDialog lot={action.lot} onClose={() => setAction(null)} />
      )}
      {action?.kind === 'delete' && (
        <DeleteLotDialog lot={action.lot} onClose={() => setAction(null)} />
      )}
      <EntryDialog open={entry} product={product.data ?? null} onClose={() => setEntry(false)} />
      {counting && (
        <StartCountDialog
          productId={productId!}
          productName={detail.product.description}
          initial={untracked}
          onClose={() => setCounting(false)}
        />
      )}
    </>
  );
}

/** Histórico de lotes (AV10): baixados, excluídos e substituídos por contagem. */
function ClosedLots({ productId }: { productId: string }) {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors.at(-1) ?? null;
  // Toda correção invalida as consultas da loja: uma baixa ou exclusão aparece aqui na hora.
  const query = useApiQuery<Page<StockRecord>>(
    `/inventory/products/${productId}/closed-records${queryString({ cursor, limit: 20 })}`,
    { poll: true },
  );
  const items = query.data?.items ?? [];
  return (
    <section className="surface table-surface">
      <div className="table-toolbar">
        <div>
          <Typography variant="h6" component="h2">
            Histórico de lotes
          </Typography>
          <span className="muted">
            Lotes que as vendas ou as baixas zeraram, os excluídos e os substituídos por uma
            contagem, do lançamento mais recente.
          </span>
        </div>
      </div>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : !items.length && cursors.length === 1 ? (
        <Empty icon="calendar" title="Nenhum lote no histórico" />
      ) : (
        <>
          <TableContainer>
            <Table className="lots-table responsive-table">
              <TableHead>
                <TableRow>
                  <TableCell>Validade</TableCell>
                  <TableCell>Lote</TableCell>
                  <TableCell>Lançado em</TableCell>
                  <TableCell align="right">Lançado</TableCell>
                  <TableCell align="right">Vendido</TableCell>
                  <TableCell align="right">Baixa manual</TableCell>
                  <TableCell>Situação</TableCell>
                  <TableCell align="right" />
                </TableRow>
              </TableHead>
              <TableBody>
                {items.map((lot) => (
                  <TableRow key={lot.id} className="closed-lot">
                    <TableCell className="cell-main" data-label="Validade">
                      {formatDate(lot.expiresOn)}
                    </TableCell>
                    <TableCell data-label="Lote">{lot.lotCode || 'Não informado'}</TableCell>
                    <TableCell data-label="Lançado em">
                      <Launch lot={lot} />
                    </TableCell>
                    <TableCell align="right" className="quantity-cell" data-label="Lançado">
                      {integer(lot.launchedQuantity ?? 0)}
                    </TableCell>
                    <TableCell align="right" className="quantity-cell" data-label="Vendido">
                      {integer(lot.soldQuantity ?? 0)}
                    </TableCell>
                    <TableCell align="right" className="quantity-cell" data-label="Baixa manual">
                      {integer(lot.writtenOffQuantity ?? 0)}
                    </TableCell>
                    <TableCell className="cell-wide" data-label="Situação">
                      <span className="cell-stack">
                        <RiskBadge level={recordStatusTone[lot.status ?? ''] ?? 'NONE'}>
                          {recordStatusLabels[lot.status ?? ''] ?? lot.status}
                        </RiskBadge>
                        {lot.status === 'DELETED' && (
                          <small className="muted">
                            {formatDate(lot.deletedAt)}
                            {lot.deletedBy ? ` · ${lot.deletedBy}` : ''}
                          </small>
                        )}
                      </span>
                    </TableCell>
                    <TableCell align="right" className="cell-action">
                      <Button
                        size="small"
                        component={Link}
                        to={`/products/${productId}/movements?recordId=${lot.id}`}
                      >
                        Movimentações
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          <Pagination
            nextCursor={query.data.nextCursor}
            hasPrevious={cursors.length > 1}
            onNext={(next) => setCursors([...cursors, next])}
            onReset={() => setCursors([null])}
          />
        </>
      )}
    </section>
  );
}

/** Contagem em andamento e contagens anteriores do produto (AV14). */
function ProductCounts({ productId }: { productId: string }) {
  const query = useApiQuery<Page<CountSession>>(
    `/count-sessions${queryString({ productId, limit: 10 })}`,
  );
  const items = query.data?.items ?? [];
  return (
    <section className="surface table-surface">
      <div className="table-toolbar">
        <div>
          <Typography variant="h6" component="h2">
            Contagens
          </Typography>
          <span className="muted">
            A contagem confirmada passa a ser o estoque do produto. As dez mais recentes.
          </span>
        </div>
      </div>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : !items.length ? (
        <Empty icon="count" title="Nenhuma contagem deste produto" />
      ) : (
        <TableContainer>
          <Table className="responsive-table">
            <TableHead>
              <TableRow>
                <TableCell>Iniciada em</TableCell>
                <TableCell>Situação</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {items.map((count) => (
                <TableRow key={count.id} hover>
                  <TableCell className="cell-main" data-label="Iniciada em">
                    {formatDate(count.startedAt ?? count.createdAt)}
                  </TableCell>
                  <TableCell data-label="Situação">
                    <Status value={count.status} />
                  </TableCell>
                  <TableCell align="right" className="cell-action">
                    <Button component={Link} to={`/counts/${count.id}`} size="small">
                      {count.status === 'COUNTING' ? 'Continuar' : 'Ver'}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </section>
  );
}

/** Abre a contagem do produto; no painel, a recontagem de um produto já controlado (AV09). */
function StartCountDialog({
  productId,
  productName,
  initial,
  onClose,
}: {
  productId: string;
  productName: string;
  initial: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const create = useBusinessMutation<{ productId: string }, CountSession>('/count-sessions');
  const locked = create.isPending || create.isUncertain;
  const existing = create.error instanceof ApiError && create.error.code === 'COUNT_ACTIVE';
  return (
    <Dialog open onClose={() => !locked && onClose()} fullWidth maxWidth="sm">
      <DialogTitle>{initial ? 'Contagem inicial' : 'Contar estoque'}</DialogTitle>
      <DialogContent>
        <Typography variant="body1" sx={{ fontWeight: 600, mb: 1 }}>
          {productName}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Conte todas as unidades na loja (gôndola, depósito e câmara fria), separando por validade.{' '}
          {initial
            ? 'A contagem confirmada começa o controle das validades do produto.'
            : 'A contagem confirmada substitui os lotes atuais: o estoque passa a ser exatamente o que for contado.'}
        </Typography>
        {existing && (
          <Alert severity="info" sx={{ mt: 2 }}>
            Já existe uma contagem em andamento deste produto. Atualize a página para continuá-la.
          </Alert>
        )}
        {create.error && !existing && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {create.error.message}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={locked}>
          Voltar
        </Button>
        <Button
          variant="contained"
          disabled={create.isPending}
          onClick={() =>
            create.mutate({ productId }, { onSuccess: (count) => navigate(`/counts/${count.id}`) })
          }
        >
          Iniciar contagem
        </Button>
      </DialogActions>
    </Dialog>
  );
}
