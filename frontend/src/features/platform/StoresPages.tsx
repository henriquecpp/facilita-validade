import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Chip,
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
  TextField,
  Typography,
} from '@mui/material';
import type {
  CreateStoreInput,
  CreatedStore,
  OwnerAccess,
  Page,
  PlatformPagonetCheck,
  PlatformStore,
  PlatformStoreDetail,
  PlatformStoreUser,
} from '../../shared/api/types';
import {
  formatCnpj,
  formatDate,
  formatSince,
  integer,
  normalizeCnpj,
  roleLabels,
} from '../../shared/lib/format';
import { Empty, ErrorState, Icon, Loading, PageTitle } from '../../shared/ui/components';
import { usePlatformMutation, usePlatformQuery } from './api';
import { CopyField } from './CopyField';

const USERNAME = /^[a-z0-9][a-z0-9._-]{2,63}$/i;
const CNPJ = /^[A-Z0-9]{12}[0-9]{2}$/;

/** Sem acento e em minúsculas, para a busca. */
const plain = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function StoreStatus({ active }: { active: boolean }) {
  return (
    <Chip
      label={active ? 'Ativa' : 'Suspensa'}
      color={active ? 'success' : 'warning'}
      size="small"
      variant="outlined"
    />
  );
}

/** `2026-10-12 10:32` (horário da loja) → `12/10/2026 10:32`. */
function saleTime(value: string): string {
  const [date, time] = value.split(' ');
  return `${formatDate(date)} ${time ?? ''}`.trim();
}

/** Se os dados da loja estão chegando: Pagonet e última importação. */
function DataStatus({ store }: { store: PlatformStore }) {
  const { pagonet } = store;
  return (
    <span>
      {!pagonet ? (
        'Sem leitura da Pagonet'
      ) : !pagonet.active ? (
        'Pagonet pausada'
      ) : pagonet.lastError ? (
        <span className="warning-text">Pagonet com aviso</span>
      ) : pagonet.salesThrough ? (
        `Vendas até ${saleTime(pagonet.salesThrough)}`
      ) : (
        'Pagonet ligada, sem vendas ainda'
      )}
      <span className="muted">
        {store.lastImportAt
          ? `Última importação ${formatSince(store.lastImportAt)}`
          : 'Nenhuma importação'}
      </span>
    </span>
  );
}

/** O token da Pagonet é da aplicação: aqui se vê se ele existe e se a Pagonet o aceita. */
function PagonetStrip() {
  const status = usePlatformQuery<{ configured: boolean }>('/pagonet');
  const check = usePlatformMutation<Record<string, never>, PlatformPagonetCheck>('/pagonet/check');
  if (!status.data) return null;
  const result = check.data;
  const severity = !status.data.configured ? 'warning' : result && !result.ok ? 'error' : 'info';
  return (
    <Alert
      severity={severity}
      sx={{ mb: 2.5 }}
      action={
        status.data.configured ? (
          <Button
            color="inherit"
            size="small"
            disabled={check.isPending}
            onClick={() => check.mutate({})}
          >
            {check.isPending ? 'Testando…' : 'Testar conexão'}
          </Button>
        ) : undefined
      }
    >
      {!status.data.configured
        ? 'Pagonet: o servidor está sem o token da aplicação (PAGONET_TOKEN). Nenhuma loja lê catálogo e vendas.'
        : result
          ? result.ok
            ? `Pagonet: token aceito${result.userName ? `, usuário ${result.userName}` : ''}. Cada loja lê só o próprio CNPJ.`
            : `Pagonet: ${result.message}`
          : 'Pagonet: token da aplicação configurado. Cada loja lê só o próprio CNPJ.'}
    </Alert>
  );
}

export function StoresPage() {
  const stores = usePlatformQuery<Page<PlatformStore>>('/stores');
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const items = stores.data?.items ?? [];
  const term = plain(search.trim());
  const digits = search.replace(/[^\dA-Za-z]/g, '').toUpperCase();
  const shown = items.filter(
    (store) =>
      !term || plain(store.name).includes(term) || (!!digits && store.cnpj.includes(digits)),
  );
  const suspended = items.filter((store) => !store.active).length;
  return (
    <>
      <PageTitle
        title="Lojas"
        description="Cada loja só enxerga os próprios dados. Aqui a plataforma cadastra lojas, suspende e reativa, e devolve o acesso de um proprietário."
        action={
          <Button
            variant="contained"
            startIcon={<Icon name="plus" size={18} />}
            onClick={() => setCreating(true)}
          >
            Nova loja
          </Button>
        }
      />
      <PagonetStrip />
      <section className="surface table-surface">
        <div className="table-toolbar">
          <TextField
            className="search-field"
            size="small"
            label="Buscar por nome ou CNPJ"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {!!items.length && (
            <span className="toolbar-end muted-inline">
              {items.length} {items.length === 1 ? 'loja' : 'lojas'}
              {suspended ? ` · ${suspended} ${suspended === 1 ? 'suspensa' : 'suspensas'}` : ''}
            </span>
          )}
        </div>
        {stores.isPending ? (
          <Loading />
        ) : stores.isError ? (
          <ErrorState error={stores.error} retry={() => void stores.refetch()} />
        ) : !shown.length ? (
          <Empty
            icon="home"
            title={items.length ? 'Nenhuma loja encontrada' : 'Nenhuma loja cadastrada'}
            description={
              items.length
                ? 'Confira o nome ou o CNPJ digitado.'
                : 'Cadastre a primeira loja com o CNPJ e o usuário do proprietário.'
            }
          />
        ) : (
          <TableContainer>
            <Table className="responsive-table">
              <TableHead>
                <TableRow>
                  <TableCell>Loja</TableCell>
                  <TableCell>Situação</TableCell>
                  <TableCell>Proprietário</TableCell>
                  <TableCell>Equipe</TableCell>
                  <TableCell>Dados da loja</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {shown.map((store) => (
                  <TableRow key={store.id} hover>
                    <TableCell className="cell-main">
                      <Link className="product-name text-link" to={`/platform/stores/${store.id}`}>
                        {store.name}
                      </Link>
                      <span className="muted">CNPJ {formatCnpj(store.cnpj)}</span>
                    </TableCell>
                    <TableCell data-label="Situação">
                      <StoreStatus active={store.active} />
                    </TableCell>
                    <TableCell data-label="Proprietário">
                      {store.owners.length ? store.owners.join(', ') : '—'}
                    </TableCell>
                    <TableCell data-label="Equipe">
                      {integer(store.activeUsers)}{' '}
                      {store.activeUsers === 1 ? 'usuário ativo' : 'usuários ativos'}
                    </TableCell>
                    <TableCell data-label="Dados da loja">
                      <DataStatus store={store} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </section>
      {creating && <NewStoreDialog close={() => setCreating(false)} />}
    </>
  );
}

function NewStoreDialog({ close }: { close: () => void }) {
  const create = usePlatformMutation<CreateStoreInput, CreatedStore>('/stores');
  const [name, setName] = useState('');
  const [cnpj, setCnpj] = useState('');
  const [owner, setOwner] = useState('admin');
  const cnpjInvalid = !!cnpj.trim() && !CNPJ.test(normalizeCnpj(cnpj));
  const ownerInvalid = !!owner.trim() && !USERNAME.test(owner.trim());
  const ready = !!name.trim() && !!cnpj.trim() && !!owner.trim() && !cnpjInvalid && !ownerInvalid;
  const created = create.data;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    create.mutate({ name: name.trim(), cnpj: normalizeCnpj(cnpj), ownerUsername: owner.trim() });
  };
  return (
    // Com a senha provisória na tela, só fecha pelos botões: clique fora ou Esc a perderiam.
    <Dialog open onClose={() => !create.isPending && !created && close()} fullWidth maxWidth="sm">
      {created ? (
        <>
          <DialogTitle>Loja cadastrada</DialogTitle>
          <DialogContent>
            <div className="form-stack">
              <Typography variant="body2">
                Passe ao proprietário de <strong>{created.store.name}</strong> estes dados de acesso
                ao painel da loja:
              </Typography>
              <dl className="facts">
                <div>
                  <dt>Endereço</dt>
                  <dd>{`${window.location.origin}/login`}</dd>
                </div>
                <div>
                  <dt>CNPJ</dt>
                  <dd>{formatCnpj(created.store.cnpj)}</dd>
                </div>
                <div>
                  <dt>Usuário</dt>
                  <dd>{created.owner.username}</dd>
                </div>
              </dl>
              <CopyField label="Senha provisória" value={created.owner.temporaryPassword} />
              <Alert severity="warning">
                A senha aparece só agora. No primeiro acesso, o proprietário define a dele. Se ela
                se perder, use <strong>Gerar acesso</strong> na página da loja.
              </Alert>
            </div>
          </DialogContent>
          <DialogActions>
            <Button component={Link} to={`/platform/stores/${created.store.id}`} onClick={close}>
              Abrir a loja
            </Button>
            <Button variant="contained" onClick={close}>
              Concluir
            </Button>
          </DialogActions>
        </>
      ) : (
        <form onSubmit={submit} noValidate>
          <DialogTitle>Nova loja</DialogTitle>
          <DialogContent>
            <div className="form-stack">
              <Typography variant="body2" color="text.secondary">
                O CNPJ identifica a loja no login e é o mesmo da leitura da Pagonet: os dados que
                chegam são os desse CNPJ.
              </Typography>
              <TextField
                label="Nome da loja"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                autoFocus
                slotProps={{ htmlInput: { maxLength: 160 } }}
              />
              <TextField
                label="CNPJ"
                value={cnpj}
                onChange={(event) => setCnpj(event.target.value)}
                required
                error={cnpjInvalid}
                helperText={
                  cnpjInvalid
                    ? 'Informe o CNPJ completo, com 14 caracteres.'
                    : 'Com ou sem pontuação.'
                }
                slotProps={{ htmlInput: { maxLength: 18, autoCapitalize: 'characters' } }}
              />
              <TextField
                label="Usuário do proprietário"
                value={owner}
                onChange={(event) => setOwner(event.target.value)}
                required
                error={ownerInvalid}
                helperText={
                  ownerInvalid
                    ? 'De 3 a 64 letras, números, pontos, hífens ou sublinhados.'
                    : 'Ele entra com este usuário e uma senha provisória, gerada agora.'
                }
                slotProps={{ htmlInput: { maxLength: 64 } }}
              />
              {create.error && <ErrorState error={create.error} />}
            </div>
          </DialogContent>
          <DialogActions>
            <Button onClick={close} disabled={create.isPending}>
              Cancelar
            </Button>
            <Button type="submit" variant="contained" disabled={!ready || create.isPending}>
              {create.isPending ? 'Cadastrando…' : 'Cadastrar loja'}
            </Button>
          </DialogActions>
        </form>
      )}
    </Dialog>
  );
}

export function StorePage() {
  const { storeId = '' } = useParams();
  const store = usePlatformQuery<PlatformStoreDetail>(`/stores/${storeId}`);
  const [statusChange, setStatusChange] = useState<'suspend' | 'reactivate' | null>(null);
  const [access, setAccess] = useState<PlatformStoreUser | null>(null);
  const back = { to: '/platform', label: 'Lojas' };
  if (store.isPending) return <Loading />;
  if (store.isError)
    return (
      <>
        <PageTitle title="Loja" back={back} />
        <ErrorState error={store.error} retry={() => void store.refetch()} />
      </>
    );
  const data = store.data;
  const pagonet = data.pagonet;
  return (
    <>
      <PageTitle
        back={back}
        title={
          <span className="title-with-status">
            {data.name} <StoreStatus active={data.active} />
          </span>
        }
        description={`CNPJ ${formatCnpj(data.cnpj)} · cadastrada em ${formatDate(data.createdAt)} · fuso ${data.timezone}`}
        action={
          data.active ? (
            <Button color="warning" variant="outlined" onClick={() => setStatusChange('suspend')}>
              Suspender loja
            </Button>
          ) : (
            <Button variant="contained" onClick={() => setStatusChange('reactivate')}>
              Reativar loja
            </Button>
          )
        }
      />
      {!data.active && (
        <Alert severity="warning" sx={{ mb: 2.5 }}>
          Loja suspensa: ninguém dela entra no painel nem no coletor, as integrações são recusadas e
          a leitura da Pagonet e os alertas param. Os dados continuam guardados.
        </Alert>
      )}
      <div className="platform-grid">
        <section className="surface">
          <Typography variant="h6" component="h2" sx={{ mb: 1.5 }}>
            Dados da loja
          </Typography>
          <dl className="facts">
            <div>
              <dt>Pagonet</dt>
              <dd>{!pagonet ? 'Não configurada' : pagonet.active ? 'Ligada' : 'Pausada'}</dd>
            </div>
            {pagonet && (
              <>
                <div>
                  <dt>Catálogo</dt>
                  <dd>
                    {pagonet.catalogSyncedAt
                      ? `${integer(pagonet.catalogProducts ?? 0)} produtos, ${formatSince(pagonet.catalogSyncedAt)}`
                      : 'Ainda não lido'}
                  </dd>
                </div>
                <div>
                  <dt>Vendas</dt>
                  <dd>
                    {pagonet.salesThrough
                      ? `Até ${saleTime(pagonet.salesThrough)}`
                      : 'Nenhuma ainda'}
                  </dd>
                </div>
              </>
            )}
            <div>
              <dt>Última importação</dt>
              <dd>{data.lastImportAt ? formatDate(data.lastImportAt) : 'Nenhuma'}</dd>
            </div>
          </dl>
          {pagonet?.lastError && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              {pagonet.lastError} ({formatDate(pagonet.lastErrorAt)})
            </Alert>
          )}
        </section>
        <section className="surface table-surface">
          <div className="table-toolbar">
            <div>
              <Typography variant="h6" component="h2">
                Equipe
              </Typography>
              <span className="muted">
                Para um proprietário que perdeu o acesso, gere um link novo de uso único.
              </span>
            </div>
          </div>
          <TableContainer>
            <Table className="responsive-table">
              <TableHead>
                <TableRow>
                  <TableCell>Usuário</TableCell>
                  <TableCell>Função</TableCell>
                  <TableCell>Situação</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {data.users.map((user) => (
                  <TableRow key={user.id} hover>
                    <TableCell className="cell-main">
                      <span className="product-name">{user.username}</span>
                      {user.active && user.mustChangePassword && (
                        <span className="muted">Ainda não trocou a senha provisória</span>
                      )}
                    </TableCell>
                    <TableCell data-label="Função">{roleLabels[user.role]}</TableCell>
                    <TableCell data-label="Situação">{user.active ? 'Ativo' : 'Inativo'}</TableCell>
                    <TableCell align="right" className="cell-action">
                      {user.role === 'OWNER' && user.active && (
                        <Button disabled={!data.active} onClick={() => setAccess(user)}>
                          Gerar acesso
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </section>
      </div>
      {statusChange && (
        <StatusDialog store={data} mode={statusChange} close={() => setStatusChange(null)} />
      )}
      {access && <OwnerAccessDialog store={data} owner={access} close={() => setAccess(null)} />}
    </>
  );
}

function StatusDialog({
  store,
  mode,
  close,
}: {
  store: PlatformStoreDetail;
  mode: 'suspend' | 'reactivate';
  close: () => void;
}) {
  const change = usePlatformMutation<{ reason: string }, PlatformStoreDetail>(
    `/stores/${store.id}/${mode}`,
  );
  const [reason, setReason] = useState('');
  const invalid = reason.trim().length < 3;
  const suspend = mode === 'suspend';
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!invalid) change.mutate({ reason: reason.trim() }, { onSuccess: close });
  };
  return (
    <Dialog open onClose={() => !change.isPending && close()} fullWidth maxWidth="sm">
      <form onSubmit={submit} noValidate>
        <DialogTitle>
          {suspend ? `Suspender ${store.name}?` : `Reativar ${store.name}?`}
        </DialogTitle>
        <DialogContent>
          <div className="form-stack">
            <Typography variant="body2">
              {suspend
                ? 'Na hora: ninguém da loja entra no painel nem no coletor, quem estava dentro para na próxima ação, as integrações são recusadas e a leitura da Pagonet e os alertas param. Nada é apagado: reativar devolve tudo como estava.'
                : 'A equipe volta a entrar, as sessões que ainda estavam no prazo voltam a valer, e a leitura da Pagonet e os alertas recomeçam.'}
            </Typography>
            <TextField
              label="Motivo"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              required
              autoFocus
              multiline
              minRows={2}
              helperText="Fica no histórico da loja e da plataforma."
              slotProps={{ htmlInput: { maxLength: 500 } }}
            />
            {change.error && <ErrorState error={change.error} />}
          </div>
        </DialogContent>
        <DialogActions>
          <Button onClick={close} disabled={change.isPending}>
            Voltar
          </Button>
          <Button
            type="submit"
            variant="contained"
            color={suspend ? 'warning' : 'primary'}
            disabled={invalid || change.isPending}
          >
            {suspend ? 'Suspender' : 'Reativar'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

function OwnerAccessDialog({
  store,
  owner,
  close,
}: {
  store: PlatformStoreDetail;
  owner: PlatformStoreUser;
  close: () => void;
}) {
  const issue = usePlatformMutation<{ userId: string; reason: string }, OwnerAccess>(
    `/stores/${store.id}/owner-access`,
  );
  const [reason, setReason] = useState('');
  const invalid = reason.trim().length < 3;
  const result = issue.data;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!invalid) issue.mutate({ userId: owner.id, reason: reason.trim() });
  };
  return (
    // Com o link na tela, só fecha pelo botão: clique fora ou Esc o perderiam.
    <Dialog open onClose={() => !issue.isPending && !result && close()} fullWidth maxWidth="sm">
      {result ? (
        <>
          <DialogTitle>Acesso gerado para {result.username}</DialogTitle>
          <DialogContent>
            <div className="form-stack">
              <Typography variant="body2">
                Envie o link ao proprietário por um canal seguro. Ele vale uma vez, até{' '}
                {formatDate(result.expiresAt)}. A senha anterior já não vale, e as sessões abertas
                dele foram encerradas.
              </Typography>
              <CopyField
                label="Link para definir a senha"
                value={`${window.location.origin}/reset-password#${result.resetToken}`}
              />
            </div>
          </DialogContent>
          <DialogActions>
            <Button variant="contained" onClick={close}>
              Concluir
            </Button>
          </DialogActions>
        </>
      ) : (
        <form onSubmit={submit} noValidate>
          <DialogTitle>Gerar acesso para {owner.username}?</DialogTitle>
          <DialogContent>
            <div className="form-stack">
              <Typography variant="body2">
                Para quem perdeu a senha ou o acesso. A senha atual dele deixa de valer na hora e as
                sessões abertas são encerradas; o link novo vale 30 minutos e uma vez só.
              </Typography>
              <TextField
                label="Motivo"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                required
                autoFocus
                helperText="Fica no histórico da loja e da plataforma."
                slotProps={{ htmlInput: { maxLength: 500 } }}
              />
              {issue.error && <ErrorState error={issue.error} />}
            </div>
          </DialogContent>
          <DialogActions>
            <Button onClick={close} disabled={issue.isPending}>
              Voltar
            </Button>
            <Button type="submit" variant="contained" disabled={invalid || issue.isPending}>
              {issue.isPending ? 'Gerando…' : 'Gerar acesso'}
            </Button>
          </DialogActions>
        </form>
      )}
    </Dialog>
  );
}
