import { useState } from 'react';
import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../shared/api/client';
import { useApiQuery, useBusinessMutation } from '../../shared/api/hooks';
import type { Page, IntegrationConnection, IntegrationKey } from '../../shared/api/types';
import { Empty, ErrorState, Loading } from '../../shared/ui/components';
import { useAuth } from '../auth/AuthProvider';
import { PAGONET_CONNECTION } from './PagonetSource';
type Connection = IntegrationConnection;

export function IntegrationConnections() {
  const query = useApiQuery<Page<Connection>>('/integration-connections');
  const [name, setName] = useState('');
  const [show, setShow] = useState(false);
  const create = useBusinessMutation<{ name: string }>('/integration-connections');
  return (
    <section className="surface">
      <div className="surface-heading">
        <div>
          <Typography variant="h6" component="h2">
            Integração por API
          </Typography>
          <span className="muted">
            Uso técnico: para sistemas que enviam produtos e vendas por conta própria. Com a
            Pagonet, nada aqui é necessário.
          </span>
        </div>
        <Button onClick={() => setShow(!show)}>
          {show ? 'Fechar cadastro' : '+ Nova conexão'}
        </Button>
      </div>
      {show && (
        <form
          className="form-stack"
          style={{ marginBottom: 24 }}
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate(
              { name: name.trim() },
              {
                onSuccess: () => {
                  setName('');
                  setShow(false);
                },
              },
            );
          }}
        >
          <TextField
            label="Nome da conexão"
            placeholder="Sistema de vendas da loja"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            slotProps={{ htmlInput: { maxLength: 100 } }}
          />
          {create.error && <ErrorState error={create.error} />}
          <Button type="submit" disabled={!name.trim() || create.isPending}>
            Criar conexão
          </Button>
        </form>
      )}
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : !query.data.items.length ? (
        <Empty
          title="Nenhuma conexão configurada"
          description="Crie uma conexão para identificar o sistema que enviará os produtos e movimentos da loja."
        />
      ) : (
        query.data.items.map((connection) => (
          <ConnectionRow key={connection.id} connection={connection} />
        ))
      )}
    </section>
  );
}
function ConnectionRow({ connection }: { connection: Connection }) {
  const { session } = useAuth();
  const cache = useQueryClient();
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [issued, setIssued] = useState<string | null>(null);
  const issue = useMutation({
    mutationFn: () =>
      api<{ id: string; key: string }>('/integration-keys', {
        method: 'POST',
        body: JSON.stringify({
          connectionId: connection.id,
          scopes: ['catalog:write', 'movements:write', 'batches:read'],
        }),
      }),
    onSuccess: (data) => {
      setIssued(data.key);
      void cache.invalidateQueries({ queryKey: [session?.store.id, '/integration-connections'] });
    },
  });
  const deactivate = useBusinessMutation<Record<string, never>>(
    `/integration-connections/${connection.id}/deactivate`,
  );
  // A conexão da Pagonet é do servidor: desativá-la aqui pararia as vendas sem aviso.
  const managed = connection.name === PAGONET_CONNECTION;
  return (
    <div className="connection-row">
      <div className="surface-heading">
        <div>
          <strong>{connection.name}</strong>
          <span className="muted">
            {managed
              ? 'Usada pela leitura automática da Pagonet. Para pausar, use “Alterar” na seção da Pagonet.'
              : connection.active
                ? 'Ativa'
                : 'Desativada'}
            {connection.keys?.length
              ? ` · ${connection.keys.length} ${connection.keys.length === 1 ? 'chave' : 'chaves'}`
              : ''}
          </span>
        </div>
        {connection.active && !managed && (
          <div className="inline-actions">
            <Button disabled={issue.isPending} onClick={() => issue.mutate()}>
              Gerar chave
            </Button>
            <Button color="error" onClick={() => setConfirmDisable(true)}>
              Desativar
            </Button>
          </div>
        )}
      </div>
      {connection.keys?.map((key) => (
        <KeyRow key={key.id} apiKey={key} />
      ))}
      {issue.error && <ErrorState error={issue.error} />}
      {deactivate.error && <ErrorState error={deactivate.error} />}
      <Dialog open={!!issued} onClose={() => setIssued(null)} fullWidth maxWidth="sm">
        <DialogTitle>Chave da integração</DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mb: 2 }}>
            Copie e entregue ao responsável pela integração. O segredo será exibido somente nesta
            janela.
          </Alert>
          <TextField
            label="Chave"
            value={issued ?? ''}
            multiline
            slotProps={{ input: { readOnly: true } }}
          />
          <Typography variant="body2" sx={{ mt: 2 }}>
            A chave permite enviar produtos e movimentos e consultar os lotes desta conexão. Após
            configurar a nova chave, revogue a antiga.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setIssued(null)}>Já copiei, fechar</Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={confirmDisable}
        onClose={() => !deactivate.isPending && setConfirmDisable(false)}
      >
        <DialogTitle>Desativar {connection.name}?</DialogTitle>
        <DialogContent>
          O sistema deixará de aceitar novas importações desta conexão. O histórico será preservado.
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmDisable(false)} disabled={deactivate.isPending}>
            Voltar
          </Button>
          <Button
            color="error"
            disabled={deactivate.isPending}
            onClick={() => deactivate.mutate({}, { onSuccess: () => setConfirmDisable(false) })}
          >
            Desativar conexão
          </Button>
        </DialogActions>
      </Dialog>
    </div>
  );
}
const scopeLabels: Record<string, string> = {
  'catalog:write': 'envia produtos',
  'movements:write': 'envia movimentos',
  'batches:read': 'consulta importações',
};
function KeyRow({ apiKey }: { apiKey: IntegrationKey }) {
  const [confirm, setConfirm] = useState(false);
  const revoke = useBusinessMutation<Record<string, never>>(
    `/integration-keys/${apiKey.id}/revoke`,
  );
  return (
    <div className="key-row">
      <div>
        <code>{apiKey.id}</code>
        <span className="muted">
          {apiKey.scopes.map((scope) => scopeLabels[scope] ?? scope).join(', ')}
        </span>
      </div>
      <Chip
        label={apiKey.revokedAt ? 'Revogada' : 'Ativa'}
        size="small"
        variant="outlined"
        color={apiKey.revokedAt ? 'default' : 'success'}
      />
      {!apiKey.revokedAt && (
        <Button color="error" size="small" onClick={() => setConfirm(true)}>
          Revogar
        </Button>
      )}
      {revoke.error && <ErrorState error={revoke.error} />}
      <Dialog open={confirm} onClose={() => !revoke.isPending && setConfirm(false)}>
        <DialogTitle>Revogar esta chave?</DialogTitle>
        <DialogContent>
          A integração que utiliza esta chave precisará de uma nova credencial para continuar
          enviando dados.
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(false)} disabled={revoke.isPending}>
            Voltar
          </Button>
          <Button
            color="error"
            disabled={revoke.isPending}
            onClick={() => revoke.mutate({}, { onSuccess: () => setConfirm(false) })}
          >
            Revogar chave
          </Button>
        </DialogActions>
      </Dialog>
    </div>
  );
}
