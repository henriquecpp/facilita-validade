import { Fragment, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Button,
  Chip,
  InputAdornment,
  MenuItem,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
} from '@mui/material';
import { useApiQuery } from '../../shared/api/hooks';
import { useExpiryRules } from '../../shared/api/store';
import { queryString } from '../../shared/api/client';
import type { InventoryItem, Page, ProductCategories } from '../../shared/api/types';
import {
  Empty,
  ErrorState,
  ExpiryBadge,
  FilterChips,
  Icon,
  Loading,
  PageTitle,
  Pagination,
  Status,
} from '../../shared/ui/components';
import { formatDate, integer, money } from '../../shared/lib/format';
import { EntryDialog } from './EntryDialog';

type Tracking = '' | 'TRACKED' | 'UNTRACKED';

/** Só os parâmetros preenchidos, para a URL não carregar filtros vazios. */
const only = (values: Record<string, string>) =>
  Object.fromEntries(Object.entries(values).filter(([, value]) => !!value));

/**
 * Módulo Produtos (AV14): o catálogo inteiro da loja, com busca por nome ou código de barras,
 * filtros por situação e por grupo/categoria do ERP, e paginação. Substitui Estoque e Contagens:
 * a contagem e o histórico de cada produto ficam na página dele.
 */
export function ProductsPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const search = params.get('search') ?? '';
  const cursor = params.get('cursor') ?? '';
  const tracking = (params.get('situacao') ?? '') as Tracking;
  const category = params.get('categoria') ?? '';
  const [draft, setDraft] = useState(search);
  const [entry, setEntry] = useState(false);
  const rules = useExpiryRules();
  const categories = useApiQuery<ProductCategories>('/products/categories', {
    refetchOnWindowFocus: false,
  });
  const query = useApiQuery<Page<InventoryItem>>(
    `/inventory${queryString({ search, cursor, limit: 50, trackingStatus: tracking, category })}`,
    { poll: true },
  );
  const filters = (next: { search?: string; situacao?: Tracking; categoria?: string }) =>
    setParams(only({ search, situacao: tracking, categoria: category, ...next }), {
      replace: true,
    });
  // Busca enquanto digita; a URL guarda a busca para o voltar do navegador.
  useEffect(() => {
    const next = draft.trim();
    if (next === search) return;
    const timer = window.setTimeout(
      () =>
        setParams(only({ search: next, situacao: tracking, categoria: category }), {
          replace: true,
        }),
      400,
    );
    return () => window.clearTimeout(timer);
  }, [draft, search, tracking, category, setParams]);
  const items = query.data?.items ?? [];
  const filtered = !!(search || tracking || category);
  return (
    <>
      <PageTitle
        title="Produtos"
        description="Catálogo da loja, com os produtos controlados primeiro."
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
      <section className="surface table-surface">
        <form
          className="table-toolbar product-filters"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            filters({ search: draft.trim() });
          }}
        >
          <TextField
            className="search-field"
            label="Buscar produto"
            placeholder="Nome ou código de barras"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            autoComplete="off"
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <Icon name="search" size={18} />
                  </InputAdornment>
                ),
              },
            }}
          />
          <TextField
            select
            className="category-field"
            label="Categoria"
            value={category}
            onChange={(event) => filters({ categoria: event.target.value })}
            helperText="Grupo/categoria do sistema da loja"
          >
            <MenuItem value="">Todas</MenuItem>
            {(categories.data?.items ?? []).map((item) => (
              <MenuItem key={item.code} value={item.code}>
                {item.code} · {integer(item.products)} produtos
              </MenuItem>
            ))}
          </TextField>
          <FilterChips<Tracking>
            label="Situação"
            value={tracking}
            onChange={(next) => filters({ situacao: next })}
            options={[
              { value: '', label: 'Todos' },
              { value: 'TRACKED', label: 'Controlados' },
              { value: 'UNTRACKED', label: 'Sem contagem' },
            ]}
          />
          {filtered && (
            <Button
              onClick={() => {
                setDraft('');
                setParams({});
              }}
            >
              Limpar filtros
            </Button>
          )}
        </form>
        {query.isPending ? (
          <Loading />
        ) : query.isError ? (
          <ErrorState error={query.error} retry={() => void query.refetch()} />
        ) : !items.length ? (
          <Empty
            icon="search"
            title={
              search
                ? `Nenhum produto com “${search}”`
                : filtered
                  ? 'Nenhum produto com estes filtros'
                  : 'Nenhum produto no catálogo'
            }
            description={
              search
                ? 'Confira a escrita ou busque pelo código de barras.'
                : filtered
                  ? 'Troque a categoria ou a situação.'
                  : 'Os produtos aparecem aqui quando o catálogo chega do sistema da loja.'
            }
          />
        ) : (
          <>
            <TableContainer>
              <Table className="clickable-rows responsive-table">
                <TableHead>
                  <TableRow>
                    <TableCell>Produto</TableCell>
                    <TableCell>Categoria</TableCell>
                    <TableCell align="right">Preço</TableCell>
                    <TableCell align="right">Em estoque</TableCell>
                    <TableCell>Próxima validade</TableCell>
                    <TableCell>Situação</TableCell>
                    <TableCell className="hide-sm" />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {items.map((item, index) => {
                    // Controlados vêm antes: a faixa marca onde começam os demais.
                    const firstUntracked =
                      !tracking &&
                      item.trackingStatus === 'UNTRACKED' &&
                      index > 0 &&
                      items[index - 1]!.trackingStatus === 'TRACKED';
                    return (
                      <Fragment key={item.productId}>
                        {firstUntracked && (
                          <TableRow className="group-row">
                            <TableCell colSpan={7}>
                              Ainda sem contagem inicial — conte o produto para começar a controlar
                              as validades
                            </TableCell>
                          </TableRow>
                        )}
                        <TableRow
                          hover
                          onClick={() => navigate(`/products/${item.productId}`)}
                          className={item.trackingStatus === 'UNTRACKED' ? 'untracked' : ''}
                        >
                          <TableCell className="cell-main">
                            <Link
                              className="product-name"
                              to={`/products/${item.productId}`}
                              onClick={(event) => event.stopPropagation()}
                            >
                              {item.productName}
                            </Link>
                            <span className="muted">{item.barcode ?? 'Sem código de barras'}</span>
                          </TableCell>
                          <TableCell data-label="Categoria">{item.category ?? '—'}</TableCell>
                          <TableCell align="right" className="quantity-cell" data-label="Preço">
                            {item.salePrice != null ? money(item.salePrice) : '—'}
                          </TableCell>
                          <TableCell
                            align="right"
                            data-label="Em estoque"
                            className="quantity-cell"
                          >
                            {item.trackingStatus === 'UNTRACKED'
                              ? '—'
                              : integer(item.estimatedQuantity)}
                          </TableCell>
                          <TableCell data-label="Próxima validade">
                            {item.nearestExpiry ? (
                              <span className="expiry-cell">
                                {formatDate(item.nearestExpiry)}
                                <ExpiryBadge date={item.nearestExpiry} rules={rules} />
                              </span>
                            ) : (
                              <span className="muted-inline">—</span>
                            )}
                          </TableCell>
                          <TableCell data-label="Situação" className="cell-wide">
                            <span className="status-stack">
                              <Status value={item.trackingStatus} />
                              {item.countActive && (
                                <Chip
                                  size="small"
                                  color="info"
                                  variant="outlined"
                                  label="Contagem aberta"
                                />
                              )}
                            </span>
                            {item.stale && <span className="muted">Atualizando o saldo…</span>}
                          </TableCell>
                          <TableCell className="hide-sm chevron-cell">
                            <Icon name="chevron" />
                          </TableCell>
                        </TableRow>
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
            <Pagination
              nextCursor={query.data.nextCursor}
              hasPrevious={!!cursor}
              onNext={(next) =>
                setParams(only({ search, situacao: tracking, categoria: category, cursor: next }))
              }
              onReset={() => filters({})}
            />
          </>
        )}
      </section>
      <EntryDialog
        open={entry}
        onClose={() => setEntry(false)}
        onSaved={(detail) => navigate(`/products/${detail.product.id}`)}
      />
    </>
  );
}
