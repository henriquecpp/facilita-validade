import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { useApiQuery } from '../../shared/api/hooks';
import { queryString } from '../../shared/api/client';
import type { HistoryItem, InventoryDetail, Page, StockRecord } from '../../shared/api/types';
import {
  Empty,
  ErrorState,
  Icon,
  Loading,
  PageTitle,
  Pagination,
} from '../../shared/ui/components';
import { formatDate, integer, statusLabels } from '../../shared/lib/format';
import { movementSign } from '../../shared/lib/labels';

/** O que mudou na movimentação, além do tipo e da quantidade. */
function describe(item: HistoryItem): string {
  const parts: string[] = [];
  if (item.type === 'APP_RECEIPT' || item.type === 'RETURN_RECEIPT')
    if (item.expiresOn) parts.push(`Validade ${formatDate(item.expiresOn)}`);
  if (item.type === 'RECORD_EDIT') {
    if (item.expiresOn)
      parts.push(`Validade ${formatDate(item.previousExpiresOn)} → ${formatDate(item.expiresOn)}`);
    if (item.quantity != null)
      parts.push(
        `Lançado ${item.previousQuantity != null ? integer(item.previousQuantity) : '—'} → ${integer(item.quantity)}`,
      );
  }
  if (item.reason) parts.push(`Motivo: ${item.reason}`);
  if (item.actorName) parts.push(`por ${item.actorName}`);
  return parts.join(' · ');
}

/**
 * Movimentações do produto numa tela própria (AV12), da mais recente. Com `recordId`, só as do
 * lote: o lançamento, as correções e as vendas e baixas que saíram dele (AV11).
 */
export function MovementsPage() {
  const { productId } = useParams();
  const [params, setParams] = useSearchParams();
  const recordId = params.get('recordId') ?? '';
  const cursor = params.get('cursor') ?? '';
  const detail = useApiQuery<InventoryDetail>(`/inventory/products/${productId}`);
  const closed = useApiQuery<Page<StockRecord>>(
    `/inventory/products/${productId}/closed-records?limit=100`,
    { enabled: !!recordId },
  );
  const query = useApiQuery<Page<HistoryItem>>(
    `/inventory/products/${productId}/history${queryString({ recordId, cursor, limit: 50 })}`,
    { poll: true },
  );
  const lot =
    detail.data?.records.find((record) => record.id === recordId) ??
    closed.data?.items.find((record) => record.id === recordId);
  const items = query.data?.items ?? [];
  const name = detail.data?.product.description ?? 'Produto';
  return (
    <>
      <PageTitle
        back={{ to: `/products/${productId}`, label: name }}
        title={recordId ? 'Movimentações do lote' : 'Movimentações'}
        description={
          recordId
            ? 'O lançamento, as correções e o que saiu deste lote, do mais recente.'
            : 'Vendas, entradas, baixas e correções do produto, da mais recente.'
        }
        action={
          <Button
            startIcon={<Icon name="refresh" size={18} />}
            onClick={() => void query.refetch()}
          >
            Atualizar
          </Button>
        }
      />
      {recordId && (
        <Alert
          severity="info"
          sx={{ mb: 2 }}
          action={
            <Button color="inherit" size="small" onClick={() => setParams({})}>
              Ver todas
            </Button>
          }
        >
          {lot
            ? `Lote com validade ${formatDate(lot.expiresOn)}${lot.lotCode ? `, lote ${lot.lotCode}` : ''}, lançado em ${formatDate(lot.launchedAt)}${lot.launchedBy ? ` por ${lot.launchedBy}` : ''}.`
            : 'Só as movimentações de um lote.'}
        </Alert>
      )}
      <section className="surface table-surface">
        {query.isPending ? (
          <Loading />
        ) : query.isError ? (
          <ErrorState error={query.error} retry={() => void query.refetch()} />
        ) : !items.length ? (
          <Empty
            icon="audit"
            title={recordId ? 'Nenhuma movimentação neste lote' : 'Nenhuma movimentação recebida'}
            description={
              recordId
                ? 'Os lotes da contagem não têm lançamento próprio; as vendas aparecem aqui quando saírem dele.'
                : undefined
            }
          />
        ) : (
          <>
            <TableContainer>
              <Table className="responsive-table">
                <TableHead>
                  <TableRow>
                    <TableCell>Quando</TableCell>
                    <TableCell>Movimentação</TableCell>
                    <TableCell align="right">Quantidade</TableCell>
                    {recordId && <TableCell align="right">Saiu deste lote</TableCell>}
                    <TableCell>Detalhe</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {items.map((item) => {
                    const sign = movementSign(item.type);
                    return (
                      <TableRow key={item.id}>
                        <TableCell data-label="Quando">{formatDate(item.occurredAt)}</TableCell>
                        <TableCell className="cell-main" data-label="Movimentação">
                          <Typography variant="body2" component="span" sx={{ fontWeight: 600 }}>
                            {statusLabels[item.type] ?? item.type}
                          </Typography>
                        </TableCell>
                        <TableCell
                          align="right"
                          data-label="Quantidade"
                          className={`quantity-cell ${sign === '+' ? 'in' : sign ? 'out' : ''}`}
                        >
                          {item.quantity == null ? '—' : `${sign}${integer(item.quantity)}`}
                        </TableCell>
                        {recordId && (
                          <TableCell
                            align="right"
                            className="quantity-cell out"
                            data-label="Saiu deste lote"
                          >
                            {item.allocatedQuantity == null
                              ? '—'
                              : `−${integer(item.allocatedQuantity)}`}
                          </TableCell>
                        )}
                        <TableCell className="cell-wide" data-label="Detalhe">
                          {describe(item) || '—'}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
            <Pagination
              nextCursor={query.data.nextCursor}
              hasPrevious={!!cursor}
              onNext={(next) => setParams(recordId ? { recordId, cursor: next } : { cursor: next })}
              onReset={() => setParams(recordId ? { recordId } : {})}
            />
          </>
        )}
      </section>
      <div className="form-actions">
        <Button component={Link} to={`/products/${productId}`} variant="outlined">
          Voltar ao produto
        </Button>
      </div>
    </>
  );
}
