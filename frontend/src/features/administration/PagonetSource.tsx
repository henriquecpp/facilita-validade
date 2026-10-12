import { useState, type FormEvent } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  FormControlLabel,
  Typography,
} from '@mui/material';
import { useApiQuery, useBusinessMutation } from '../../shared/api/hooks';
import type { PagonetSource, PagonetSourceInput } from '../../shared/api/types';
import { ErrorState, Loading } from '../../shared/ui/components';
import { formatCnpj, formatDate, integer } from '../../shared/lib/format';

/** Nome da conexão que o servidor cria para a Pagonet (mesmo texto de `pagonet-sync.ts`). */
export const PAGONET_CONNECTION = 'Pagonet — Facilita Validade';

/** Hora local de um instante, para "começa às 14:35". */
function clock(value: string | null | undefined): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(
    new Date(value),
  );
}

/**
 * Origem dos dados da loja pela Bridge da Pagonet (Facilita Validade). O servidor lê o
 * catálogo inteiro e as vendas de hora em hora, com o token da aplicação e o CNPJ da própria
 * loja; aqui o proprietário liga ou pausa a leitura, força uma leitura e acompanha a última.
 */
export function PagonetSourceSection() {
  const [editing, setEditing] = useState(false);
  const sync = useBusinessMutation<Record<string, never>, PagonetSource>('/pagonet-source/sync');
  // Leitura pedida: acompanha de perto até terminar; parado, uma vez por minuto basta.
  const [watching, setWatching] = useState(false);
  // A leitura pedida segue pendente até o servidor dizer que terminou.
  const query = useApiQuery<PagonetSource>('/pagonet-source', {
    poll: (data) => (watching && data?.syncRequestedAt ? 5000 : 60000),
  });
  const source = query.data;
  const requestedNow = !!source?.syncRequestedAt;
  return (
    <section className="surface">
      <div className="surface-heading">
        <div>
          <Typography variant="h6" component="h2">
            {PAGONET_CONNECTION}
          </Typography>
          <span className="muted">
            Catálogo inteiro e vendas lidos automaticamente do sistema da loja, de hora em hora: o
            catálogo primeiro e as vendas logo depois.
          </span>
        </div>
        {source?.configured && !editing && (
          <div className="inline-actions">
            <Chip
              label={source.active ? 'Ativa' : 'Pausada'}
              size="small"
              variant="outlined"
              color={source.active ? 'success' : 'warning'}
            />
            <Button
              disabled={!source.active || !source.available || sync.isPending || requestedNow}
              onClick={() => sync.mutate({}, { onSuccess: () => setWatching(true) })}
            >
              Forçar leitura agora
            </Button>
            <Button onClick={() => setEditing(true)}>Alterar</Button>
          </div>
        )}
      </div>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : (
        <>
          {!query.data.available && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              A leitura da Pagonet não está disponível neste servidor: falta o token da aplicação.
              Fale com o suporte.
            </Alert>
          )}
          <SyncProgress source={query.data} requested={sync.isSuccess} />
          {editing || !query.data.configured ? (
            <PagonetForm source={query.data} close={() => setEditing(false)} />
          ) : (
            <PagonetStatus source={query.data} />
          )}
          {sync.error && <ErrorState error={sync.error} />}
        </>
      )}
    </section>
  );
}

/** Retorno do botão Forçar (AV16): na fila, lendo ou concluída. */
function SyncProgress({ source, requested }: { source: PagonetSource; requested: boolean }) {
  if (source.syncRequestedAt)
    return source.syncRunning ? (
      <Alert severity="info" icon={<CircularProgress size={18} />} sx={{ mb: 2 }}>
        Lendo a Pagonet agora: o catálogo e, em seguida, as vendas. Pedido às{' '}
        {clock(source.syncRequestedAt)}.
      </Alert>
    ) : (
      <Alert severity="info" sx={{ mb: 2 }}>
        Leitura na fila: a Pagonet aceita uma consulta a cada 5 minutos por rota. Começa por volta
        das {clock(source.syncStartsAt)}.
      </Alert>
    );
  if (requested && source.lastError)
    return (
      <Alert severity="warning" sx={{ mb: 2 }}>
        A leitura pedida não terminou: {source.lastError}
      </Alert>
    );
  if (requested)
    return (
      <Alert severity="success" sx={{ mb: 2 }}>
        Leitura concluída às {clock(source.salesSyncedAt ?? source.catalogSyncedAt)}:{' '}
        {integer(source.catalogProducts ?? 0)} produtos no catálogo
        {source.salesThrough ? `, vendas até ${formatSaleTime(source.salesThrough)}` : ''}.
      </Alert>
    );
  return null;
}

function PagonetStatus({ source }: { source: PagonetSource }) {
  return (
    <div className="source-status">
      <Typography variant="body2">CNPJ da loja: {formatCnpj(source.cnpj)}</Typography>
      <Typography variant="body2">
        Catálogo:{' '}
        {source.catalogSyncedAt
          ? `${integer(source.catalogProducts ?? 0)} produtos, lido em ${formatDate(source.catalogSyncedAt)}`
          : 'aguardando a primeira leitura'}
      </Typography>
      <Typography variant="body2">
        Vendas:{' '}
        {source.salesSyncedAt
          ? `${source.salesThrough ? `até ${formatSaleTime(source.salesThrough)}` : 'nenhuma ainda'}, última leitura em ${formatDate(source.salesSyncedAt)}`
          : 'começam depois da primeira leitura do catálogo'}
      </Typography>
      {source.salesDelayed && !source.syncRequestedAt && !source.syncRunning && (
        <Alert severity="warning">
          {source.salesThrough ? (
            <>
              Possível atraso nas vendas: as últimas consultas não trouxeram vendas posteriores a{' '}
              {formatSaleTime(source.salesThrough)}. Se a loja vendeu depois desse horário, confira
              o envio dos dados pela integração.
            </>
          ) : (
            <>
              Possível atraso nas vendas: as últimas consultas não trouxeram vendas. Se a loja já
              vendeu hoje, confira o envio dos dados pela integração.
            </>
          )}
        </Alert>
      )}
      {source.lastError && (
        <Alert severity="warning">
          {source.lastError} ({formatDate(source.lastErrorAt)})
        </Alert>
      )}
    </div>
  );
}

/** `2026-10-12 10:32` (horário da loja) → `12/10/2026 10:32`. */
function formatSaleTime(value: string): string {
  const [date, time] = value.split(' ');
  return `${formatDate(date)} ${time ?? ''}`.trim();
}

function PagonetForm({ source, close }: { source: PagonetSource; close: () => void }) {
  const save = useBusinessMutation<PagonetSourceInput, PagonetSource>('/pagonet-source');
  // Sem o token da aplicação, o servidor recusa ligar, mas aceita manter ligada.
  const [active, setActive] = useState(source.configured ? source.active : source.available);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate({ active }, { onSuccess: close });
  };
  return (
    <form className="form-stack" onSubmit={submit}>
      <Typography variant="body2" color="text.secondary">
        A leitura usa o CNPJ da loja, {formatCnpj(source.cnpj)}: a Pagonet devolve só os dados dele.
        Toda loja importa o catálogo inteiro, com todos os campos de cada produto.
      </Typography>
      <FormControlLabel
        control={
          <Checkbox
            checked={active}
            disabled={!source.available && !source.active}
            onChange={(event) => setActive(event.target.checked)}
          />
        }
        label="Ler catálogo e vendas automaticamente"
      />
      {save.error && <ErrorState error={save.error} />}
      <div className="inline-actions">
        <Button type="submit" variant="contained" disabled={save.isPending}>
          {save.isPending ? 'Salvando…' : 'Salvar'}
        </Button>
        {source.configured && (
          <Button onClick={close} disabled={save.isPending}>
            Cancelar
          </Button>
        )}
      </div>
    </form>
  );
}
