import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
} from '@mui/material';
import { ApiError } from '../../shared/api/client';
import type { Page, PlatformEvent } from '../../shared/api/types';
import { formatDate } from '../../shared/lib/format';
import { Empty, ErrorState, Loading, PageTitle } from '../../shared/ui/components';
import { ME, platformApi, platformKey } from './api';
import { describeEvent, platformActions } from './labels';

/** O que a plataforma fez, inclusive nas lojas, do mais recente para trás. */
export function HistoryPage() {
  const client = useQueryClient();
  const history = useInfiniteQuery({
    queryKey: platformKey('/history'),
    queryFn: ({ pageParam }) =>
      platformApi<Page<PlatformEvent>>(
        `/history?limit=50${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  useEffect(() => {
    if (history.error instanceof ApiError && history.error.status === 401)
      client.setQueryData(ME, null);
  }, [client, history.error]);
  const events = history.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <>
      <PageTitle
        title="Histórico"
        description="Entradas no painel, troca de senha e tudo o que a plataforma fez nas lojas, com quem fez e o motivo."
      />
      <section className="surface table-surface">
        {history.isPending ? (
          <Loading />
        ) : history.isError ? (
          <ErrorState error={history.error} retry={() => void history.refetch()} />
        ) : !events.length ? (
          <Empty icon="audit" title="Nada registrado ainda" />
        ) : (
          <TableContainer>
            <Table className="responsive-table">
              <TableHead>
                <TableRow>
                  <TableCell>Quando</TableCell>
                  <TableCell>Quem</TableCell>
                  <TableCell>O que</TableCell>
                  <TableCell>Loja</TableCell>
                  <TableCell>Detalhe</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {events.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell className="cell-main nowrap">
                      {formatDate(event.createdAt)}
                    </TableCell>
                    <TableCell data-label="Quem">{event.operator ?? 'Sistema'}</TableCell>
                    <TableCell data-label="O que">
                      {platformActions[event.action] ?? event.action}
                    </TableCell>
                    <TableCell data-label="Loja">
                      {event.store ? (
                        <Link className="text-link" to={`/platform/stores/${event.store.id}`}>
                          {event.store.name}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell data-label="Detalhe">{describeEvent(event) || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
        {history.hasNextPage && (
          <div className="table-toolbar">
            <Button
              onClick={() => void history.fetchNextPage()}
              disabled={history.isFetchingNextPage}
            >
              {history.isFetchingNextPage ? 'Carregando…' : 'Mais antigos'}
            </Button>
          </div>
        )}
      </section>
    </>
  );
}
