import { useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { useApiQuery, useBusinessMutation } from '../../shared/api/hooks';
import type { DeviceSession, Page } from '../../shared/api/types';
import { Empty, ErrorState, Loading } from '../../shared/ui/components';
import { formatDate, formatSince } from '../../shared/lib/format';

/**
 * Coletores com acesso aberto à loja. O proprietário desconecta o aparelho perdido, o que
 * trocou de mãos ou o que ficou logado com o usuário de quem saiu da loja.
 */
export function ConnectedCollectors() {
  const query = useApiQuery<Page<DeviceSession>>('/device-sessions', { poll: true });
  const [target, setTarget] = useState<DeviceSession | null>(null);
  return (
    <section className="surface table-surface">
      <div className="table-toolbar">
        <div>
          <Typography variant="h6" component="h2">
            Coletores conectados
          </Typography>
          <span className="muted">
            Aparelhos com acesso aberto à loja. A última atividade se atualiza a cada 10 minutos,
            mais ou menos, enquanto o coletor está em uso.
          </span>
        </div>
      </div>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : !query.data.items.length ? (
        <Empty
          icon="barcode"
          title="Nenhum coletor conectado"
          description="Os coletores aparecem aqui depois do login com usuário e senha ou pelo QR."
        />
      ) : (
        <TableContainer>
          <Table className="responsive-table">
            <TableHead>
              <TableRow>
                <TableCell>Usuário</TableCell>
                <TableCell>Entrou em</TableCell>
                <TableCell>Última atividade</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {query.data.items.map((session) => (
                <TableRow key={session.id} hover>
                  <TableCell className="cell-main">
                    <span className="product-name">{session.username}</span>
                  </TableCell>
                  <TableCell data-label="Entrou em">{formatDate(session.startedAt)}</TableCell>
                  <TableCell data-label="Última atividade">
                    {formatSince(session.lastActiveAt)}
                  </TableCell>
                  <TableCell align="right" className="cell-action">
                    <Button color="error" onClick={() => setTarget(session)}>
                      Desconectar
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      {target && <Disconnect session={target} close={() => setTarget(null)} />}
    </section>
  );
}

function Disconnect({ session, close }: { session: DeviceSession; close: () => void }) {
  const revoke = useBusinessMutation<Record<string, never>>(
    `/device-sessions/${session.id}/revoke`,
  );
  return (
    <Dialog open onClose={() => !revoke.isPending && close()} fullWidth maxWidth="xs">
      <DialogTitle>Desconectar o coletor de {session.username}?</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ mb: revoke.error ? 2 : 0 }}>
          O aparelho volta para o login na próxima ação e só entra de novo com usuário e senha ou
          com um novo QR. O que já foi enviado não se perde.
        </Typography>
        {revoke.error && <ErrorState error={revoke.error} />}
      </DialogContent>
      <DialogActions>
        <Button onClick={close} disabled={revoke.isPending}>
          Voltar
        </Button>
        <Button
          color="error"
          variant="contained"
          disabled={revoke.isPending}
          onClick={() => revoke.mutate({}, { onSuccess: close })}
        >
          {revoke.isPending ? 'Desconectando…' : 'Desconectar'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
