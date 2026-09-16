import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import { api, ApiError, queryString } from '../../shared/api/client';
import { useApiQuery, useBusinessMutation } from '../../shared/api/hooks';
import { useDashboard } from '../../shared/api/store';
import type {
  AuditEvent,
  ImportBatch,
  Issue,
  Page,
  Role,
  StoreSettings,
  User,
} from '../../shared/api/types';
import {
  Empty,
  ErrorState,
  FilterChips,
  Icon,
  Loading,
  PageTitle,
  Pagination,
  Status,
} from '../../shared/ui/components';
import { formatDate, integer, roleLabels } from '../../shared/lib/format';
import { auditDetail, auditLabel, describeBatch, describeIssue } from '../../shared/lib/labels';
import { IntegrationConnections } from './IntegrationConnections';
import { PagonetSourceSection } from './PagonetSource';
import { ExpiryLevelsSection } from './ExpiryLevels';
import { PushNotificationsSection } from './PushNotifications';
import { IssueClassification } from './IssueClassification';
import { PairCollectorButton, PairCollectorDialog } from './PairCollector';
import { ConnectedCollectors } from './ConnectedCollectors';
import { useAuth } from '../auth/AuthProvider';

export function ImportsPage() {
  const { session } = useAuth();
  const owner = session?.user.role === 'OWNER';
  const [params, setParams] = useSearchParams();
  const cursor = params.get('cursor') ?? '';
  const [selected, setSelected] = useState<string | null>(null);
  const query = useApiQuery<Page<ImportBatch>>(`/imports${queryString({ cursor, limit: 50 })}`, {
    poll: true,
  });
  return (
    <>
      <PageTitle
        title="Importações"
        description="Produtos e vendas que chegam do sistema da loja. São as vendas recebidas que dão baixa no estoque."
        action={
          <Button
            variant="outlined"
            startIcon={<Icon name="refresh" size={18} />}
            onClick={() => void query.refetch()}
          >
            Atualizar
          </Button>
        }
      />
      {owner && <PagonetSourceSection />}
      <section className="surface table-surface">
        <div className="table-toolbar">
          <div>
            <Typography variant="h6" component="h2">
              Importações recebidas
            </Typography>
            <span className="muted">
              Cada linha é um pacote recebido, do mais novo para o mais antigo.
            </span>
          </div>
        </div>
        {query.isPending ? (
          <Loading />
        ) : query.isError ? (
          <ErrorState error={query.error} retry={() => void query.refetch()} />
        ) : !query.data.items.length ? (
          <Empty
            icon="import"
            title="Nenhuma importação recebida"
            description="Configure a integração com o sistema da loja para receber produtos e vendas."
          />
        ) : (
          <>
            <TableContainer>
              <Table className="responsive-table">
                <TableHead>
                  <TableRow>
                    <TableCell>Importação</TableCell>
                    <TableCell>Recebida em</TableCell>
                    <TableCell>Processados</TableCell>
                    <TableCell>Situação</TableCell>
                    <TableCell />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {query.data.items.map((batch) => {
                    const label = describeBatch(batch.externalBatchId);
                    const issues = batch.issuesCount ?? 0;
                    return (
                      <TableRow key={batch.id} hover>
                        <TableCell className="cell-main">
                          <span className="product-name">{label ?? batch.externalBatchId}</span>
                          {label && <span className="muted mono">{batch.externalBatchId}</span>}
                        </TableCell>
                        <TableCell data-label="Recebida em">
                          {formatDate(batch.createdAt)}
                        </TableCell>
                        <TableCell data-label="Processados">
                          {integer(batch.processedCount ?? 0)} de {integer(batch.eventCount ?? 0)}
                          {issues > 0 && (
                            <span className="muted warning-text">
                              {issues} {issues === 1 ? 'pendência' : 'pendências'}
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Status value={batch.status} />
                        </TableCell>
                        <TableCell align="right" className="cell-action">
                          <Button size="small" onClick={() => setSelected(batch.id)}>
                            Detalhes
                          </Button>
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
              onNext={(next) => setParams({ cursor: next })}
              onReset={() => setParams({})}
            />
          </>
        )}
      </section>
      {owner && <IntegrationConnections />}
      {selected && <ImportDetails id={selected} close={() => setSelected(null)} />}
    </>
  );
}
function ImportDetails({ id, close }: { id: string; close: () => void }) {
  const query = useApiQuery<ImportBatch>(`/imports/${id}`, { poll: true });
  const reprocess = useBusinessMutation<Record<string, never>>(`/imports/${id}/reprocess`);
  const label = query.data ? describeBatch(query.data.externalBatchId) : null;
  return (
    <Dialog open onClose={() => !reprocess.isPending && close()} fullWidth maxWidth="sm">
      <DialogTitle>Detalhes da importação</DialogTitle>
      <DialogContent>
        {query.isPending ? (
          <Loading />
        ) : query.isError ? (
          <ErrorState error={query.error} />
        ) : (
          <div className="form-stack compact">
            <div>
              <Typography sx={{ fontWeight: 700 }}>
                {label ?? query.data.externalBatchId}
              </Typography>
              {label && <span className="muted mono">{query.data.externalBatchId}</span>}
            </div>
            <dl className="facts">
              <div>
                <dt>Recebida em</dt>
                <dd>{formatDate(query.data.createdAt)}</dd>
              </div>
              <div>
                <dt>Processados</dt>
                <dd>
                  {integer(query.data.processedCount ?? 0)} de {integer(query.data.eventCount ?? 0)}
                </dd>
              </div>
              <div>
                <dt>Situação</dt>
                <dd>
                  <Status value={query.data.status} />
                </dd>
              </div>
            </dl>
            {!!query.data.errors?.length && (
              <div className="status-block warning">
                <strong>Pendências encontradas</strong>
                {query.data.errors.map((error, index) => (
                  <p key={`${error.externalEventId}:${index}`}>
                    {error.externalEventId && <strong>{error.externalEventId}: </strong>}
                    {error.message}
                  </p>
                ))}
              </div>
            )}
            {reprocess.isSuccess && (
              <Alert severity="success">
                Reprocessamento solicitado. Aguarde a atualização do resultado.
              </Alert>
            )}
            {reprocess.error && <ErrorState error={reprocess.error} />}
          </div>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={close} disabled={reprocess.isPending}>
          Fechar
        </Button>
        {query.data && ['FAILED', 'COMPLETED_WITH_ISSUES'].includes(query.data.status) && (
          <Button
            variant="contained"
            disabled={reprocess.isPending}
            onClick={() => reprocess.mutate({})}
          >
            Reprocessar pendências
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

const roleHelp: Record<Role, string> = {
  OPERATOR: 'Usa o coletor e o painel do dia a dia: consulta, conta e registra entradas.',
  MANAGER: 'Também acompanha divergências, importações e o histórico de ações.',
  OWNER: 'Acesso completo, inclusive equipe e configurações da loja.',
};

export function UsersPage() {
  const { session } = useAuth();
  const [editing, setEditing] = useState<User | 'new' | null>(null);
  const [resetting, setResetting] = useState<User | null>(null);
  const [pairing, setPairing] = useState<User | null>(null);
  const query = useApiQuery<Page<User>>('/users');
  return (
    <>
      <PageTitle
        title="Equipe"
        description="Cada pessoa entra com o próprio usuário. Desative quem saiu da loja: o histórico é preservado."
        action={
          <Button
            variant="contained"
            startIcon={<Icon name="plus" size={18} />}
            onClick={() => setEditing('new')}
          >
            Novo usuário
          </Button>
        }
      />
      <section className="surface table-surface">
        {query.isPending ? (
          <Loading />
        ) : query.isError ? (
          <ErrorState error={query.error} retry={() => void query.refetch()} />
        ) : !query.data.items.length ? (
          <Empty icon="users" title="Nenhum usuário cadastrado" />
        ) : (
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
                {query.data.items.map((user) => (
                  <TableRow key={user.id} hover>
                    <TableCell className="cell-main">
                      <span className="product-name">{user.username}</span>
                      {user.id === session?.user.id && <span className="muted">Você</span>}
                    </TableCell>
                    <TableCell data-label="Função">{roleLabels[user.role]}</TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        variant="outlined"
                        color={user.active !== false ? 'success' : 'default'}
                        label={user.active !== false ? 'Ativo' : 'Desativado'}
                      />
                      {user.mustChangePassword && (
                        <span className="muted">Ainda não trocou a senha provisória</span>
                      )}
                    </TableCell>
                    <TableCell align="right" className="cell-wide">
                      <div className="inline-actions end">
                        <PairCollectorButton user={user} onClick={() => setPairing(user)} />
                        {user.role !== 'OWNER' && user.active !== false && (
                          <Button onClick={() => setResetting(user)}>Redefinir senha</Button>
                        )}
                        <Button onClick={() => setEditing(user)}>Editar</Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </section>
      <ConnectedCollectors />
      {editing && (
        <UserEditor
          user={editing}
          close={() => setEditing(null)}
          refresh={() => void query.refetch()}
        />
      )}
      {resetting && <ResetUserPassword user={resetting} close={() => setResetting(null)} />}
      {pairing && <PairCollectorDialog user={pairing} close={() => setPairing(null)} />}
    </>
  );
}
function UserEditor({
  user,
  close,
  refresh,
}: {
  user: User | 'new';
  close: () => void;
  refresh: () => void;
}) {
  const existing = user === 'new' ? null : user;
  const [username, setUsername] = useState(existing?.username ?? '');
  // Mesmos limites do servidor: avisar aqui evita o "Confira os campos informados" genérico.
  const name = username.trim();
  const nameValid = name.length >= 3 && name.length <= 64;
  const [role, setRole] = useState<Role>(existing?.role ?? 'OPERATOR');
  const [active, setActive] = useState(existing?.active !== false);
  const [password, setPassword] = useState('');
  const save = useBusinessMutation<{
    username: string;
    role: Role;
    temporaryPassword?: string;
    expectedVersion?: number;
    active?: boolean;
  }>(existing ? `/users/${existing.id}` : '/users', existing ? 'PATCH' : 'POST');
  return (
    <Dialog open onClose={() => !save.isPending && close()} fullWidth maxWidth="sm">
      <DialogTitle>{existing ? `Editar ${existing.username}` : 'Novo usuário'}</DialogTitle>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate(
            {
              username: username.trim(),
              role,
              ...(existing
                ? { expectedVersion: existing.version, active }
                : { temporaryPassword: password }),
            },
            {
              onSuccess: close,
              // Outra pessoa alterou o usuário: a lista atrás do diálogo precisa da versão nova.
              onError: (error) => {
                if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') refresh();
              },
            },
          );
        }}
      >
        <DialogContent>
          <div className="form-stack">
            {save.error instanceof ApiError && save.error.code === 'VERSION_CONFLICT' ? (
              <Alert severity="warning">
                Outra pessoa alterou este usuário agora há pouco. Feche e abra de novo para editar a
                versão atual.
              </Alert>
            ) : (
              save.error && <ErrorState error={save.error} />
            )}
            <TextField
              label="Usuário"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
              autoComplete="off"
              error={!!username && !nameValid}
              helperText={
                username && !nameValid
                  ? 'Use de 3 a 64 caracteres.'
                  : 'O nome que a pessoa digita para entrar, como joao ou maria.silva.'
              }
              slotProps={{ htmlInput: { maxLength: 64 } }}
            />
            <TextField
              select
              label="Função"
              value={role}
              onChange={(event) => setRole(event.target.value as Role)}
              helperText={roleHelp[role]}
            >
              {Object.entries(roleLabels).map(([value, label]) => (
                <MenuItem key={value} value={value}>
                  {label}
                </MenuItem>
              ))}
            </TextField>
            {existing ? (
              <TextField
                select
                label="Situação"
                value={active ? 'active' : 'inactive'}
                onChange={(event) => setActive(event.target.value === 'active')}
                helperText="Usuário desativado não entra mais, nem no coletor."
              >
                <MenuItem value="active">Ativo</MenuItem>
                <MenuItem value="inactive">Desativado</MenuItem>
              </TextField>
            ) : (
              <TextField
                label="Senha provisória"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                helperText="Use ao menos 12 caracteres e entregue diretamente à pessoa. Ela troca a senha no primeiro acesso."
                slotProps={{ htmlInput: { minLength: 12, maxLength: 128 } }}
              />
            )}
          </div>
        </DialogContent>
        <DialogActions>
          <Button onClick={close} disabled={save.isPending}>
            Cancelar
          </Button>
          <Button
            type="submit"
            variant="contained"
            disabled={save.isPending || !nameValid || (!existing && password.length < 12)}
          >
            Salvar usuário
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
function ResetUserPassword({ user, close }: { user: User; close: () => void }) {
  const mutation = useMutation({
    mutationFn: () =>
      api<{ resetToken: string; expiresAt: string }>(`/users/${user.id}/reset-password`, {
        method: 'POST',
        body: '{}',
      }),
  });
  const url = mutation.data
    ? `${window.location.origin}/reset-password#${encodeURIComponent(mutation.data.resetToken)}`
    : '';
  return (
    <Dialog open onClose={() => !mutation.isPending && close()} fullWidth maxWidth="sm">
      <DialogTitle>Redefinir senha de {user.username}</DialogTitle>
      <DialogContent>
        {mutation.data ? (
          <>
            <Alert severity="success" sx={{ mb: 2 }}>
              Entregue este link diretamente à pessoa. Ele vale uma vez só.
            </Alert>
            <TextField
              label="Link de redefinição"
              value={url}
              multiline
              slotProps={{ input: { readOnly: true } }}
            />
            <Typography variant="body2" sx={{ mt: 2 }}>
              Válido até {formatDate(mutation.data.expiresAt)}. O link deixa de aparecer ao fechar
              esta janela.
            </Typography>
          </>
        ) : (
          <Typography>
            A redefinição encerra as sessões de {user.username}. Um link aparece aqui para a pessoa
            escolher uma nova senha.
          </Typography>
        )}
        {mutation.error && <ErrorState error={mutation.error} />}
      </DialogContent>
      <DialogActions>
        <Button onClick={close} disabled={mutation.isPending}>
          Fechar
        </Button>
        {!mutation.data && (
          <Button
            color="warning"
            variant="contained"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            Gerar link de redefinição
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

export function SettingsPage() {
  const query = useApiQuery<StoreSettings>('/store/settings', { refetchOnWindowFocus: false });
  // Fora do editor: salvar muda a versão, o editor é recriado e o aviso sumiria na hora.
  const [saved, setSaved] = useState(false);
  return (
    <>
      <PageTitle
        title="Configurações"
        description="Níveis de urgência, notificações, resumo diário por e-mail e fuso horário da loja."
      />
      <div className="settings-form">
        <ExpiryLevelsSection />
        <PushNotificationsSection />
      </div>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : (
        <SettingsEditor
          key={query.data.version}
          settings={query.data}
          saved={saved}
          setSaved={setSaved}
          reload={() => void query.refetch()}
        />
      )}
    </>
  );
}
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const digestStatusText: Record<string, string> = {
  SENT: 'enviado',
  SKIPPED: 'sem alertas no dia, nada enviado',
  FAILED: 'falhou',
  SENDING: 'em envio',
};
/** Fusos do Brasil; a diferença é em relação a Brasília. */
const TIMEZONES: [string, string][] = [
  ['America/Sao_Paulo', 'Brasília: SP, RJ, MG, ES, GO, DF e Sul'],
  ['America/Bahia', 'Bahia'],
  ['America/Fortaleza', 'CE, RN, PB, PI e MA'],
  ['America/Recife', 'Pernambuco'],
  ['America/Maceio', 'Alagoas e Sergipe'],
  ['America/Belem', 'Pará (leste) e Amapá'],
  ['America/Santarem', 'Pará (oeste)'],
  ['America/Araguaina', 'Tocantins'],
  ['America/Cuiaba', 'Mato Grosso (−1h)'],
  ['America/Campo_Grande', 'Mato Grosso do Sul (−1h)'],
  ['America/Porto_Velho', 'Rondônia (−1h)'],
  ['America/Boa_Vista', 'Roraima (−1h)'],
  ['America/Manaus', 'Amazonas (−1h)'],
  ['America/Eirunepe', 'Amazonas, oeste (−2h)'],
  ['America/Rio_Branco', 'Acre (−2h)'],
  ['America/Noronha', 'Fernando de Noronha (+1h)'],
];
function SettingsEditor({
  settings,
  saved,
  setSaved,
  reload,
}: {
  settings: StoreSettings;
  saved: boolean;
  setSaved: (saved: boolean) => void;
  reload: () => void;
}) {
  const [timezone, setTimezone] = useState(settings.timezone);
  const [emails, setEmails] = useState(settings.alertEmails.join('\n'));
  const [digestHour, setDigestHour] = useState(String(settings.digestHour));
  const [forecastAlerts, setForecastAlerts] = useState(settings.salesForecastAlerts ?? false);
  const mutation = useBusinessMutation<{
    expectedVersion: number;
    timezone: string;
    alertEmails: string[];
    digestHour: number;
    salesForecastAlerts: boolean;
  }>('/store/settings', 'PATCH');
  const testEmail = useMutation({
    mutationFn: () => api<{ recipients: number }>('/store/settings/test-email', { method: 'POST' }),
  });
  const recipients = emails
    .split(/[\n,;]+/)
    .map((email) => email.trim())
    .filter(Boolean);
  const emailsValid = recipients.length <= 10 && recipients.every((email) => EMAIL.test(email));
  const dirty =
    recipients.join('\n') !== settings.alertEmails.join('\n') ||
    Number(digestHour) !== settings.digestHour;
  const valid = !!timezone.trim() && emailsValid;
  const touch = () => setSaved(false);
  const zones = TIMEZONES.some(([zone]) => zone === timezone)
    ? TIMEZONES
    : [[timezone, timezone] as [string, string], ...TIMEZONES];
  return (
    <form
      className="settings-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid)
          mutation.mutate(
            {
              expectedVersion: settings.version,
              timezone: timezone.trim(),
              alertEmails: recipients,
              digestHour: Number(digestHour),
              salesForecastAlerts: forecastAlerts,
            },
            { onSuccess: () => setSaved(true) },
          );
      }}
    >
      <section className="surface">
        <Typography variant="h6" component="h2">
          Previsão de venda
        </Typography>
        <p className="section-help">
          Com a média de vendas de cada produto, o sistema prevê se o lote acaba antes de vencer. A
          previsão aparece nas Validades e na página do produto.
        </p>
        <div className="form-stack">
          <FormControlLabel
            control={
              <Switch
                checked={forecastAlerts}
                onChange={(event) => {
                  setForecastAlerts(event.target.checked);
                  touch();
                }}
              />
            }
            label="Não avisar lotes que devem vender antes de vencer"
          />
          <p className="section-help">
            Vale para o sino, as notificações e o resumo diário. A conta usa 80% da venda média dos
            últimos 6 meses, para ter margem, e começa quando houver 7 dias de vendas lidas da
            Pagonet. Lote que vence hoje ou amanhã sempre avisa.
          </p>
        </div>
      </section>
      <section className="surface">
        <Typography variant="h6" component="h2">
          Resumo diário por e-mail
        </Typography>
        <p className="section-help">
          Uma vez por dia, os lotes de cada nível de urgência que avisa e os saldos esgotados.
        </p>
        <div className="form-stack">
          {!settings.emailAvailable && (
            <Alert severity="warning">
              O servidor ainda não tem envio de e-mail configurado (SMTP). Os destinatários ficam
              salvos e passam a receber o resumo quando a configuração for concluída.
            </Alert>
          )}
          <TextField
            label="Destinatários"
            multiline
            minRows={2}
            value={emails}
            onChange={(event) => {
              setEmails(event.target.value);
              touch();
            }}
            error={!emailsValid}
            helperText={
              emailsValid
                ? 'Um e-mail por linha, até 10. Deixe vazio para não enviar.'
                : 'Confira os endereços: use um e-mail válido por linha, até 10.'
            }
          />
          <TextField
            select
            label="Enviar a partir de"
            value={digestHour}
            onChange={(event) => {
              setDigestHour(event.target.value);
              touch();
            }}
            helperText="Horário da loja."
          >
            {Array.from({ length: 24 }, (_, hour) => (
              <MenuItem key={hour} value={String(hour)}>
                {String(hour).padStart(2, '0')}:00
              </MenuItem>
            ))}
          </TextField>
          {settings.lastDigestDate && (
            <Alert severity={settings.lastDigestStatus === 'FAILED' ? 'error' : 'info'}>
              Último resumo ({formatDate(settings.lastDigestDate)}):{' '}
              {digestStatusText[settings.lastDigestStatus ?? ''] ?? settings.lastDigestStatus}
              {settings.lastDigestStatus === 'FAILED' && settings.lastDigestError
                ? `. ${settings.lastDigestError}`
                : '.'}
            </Alert>
          )}
          <div className="inline-actions">
            <Button
              variant="outlined"
              disabled={
                !settings.emailAvailable ||
                !settings.alertEmails.length ||
                dirty ||
                testEmail.isPending
              }
              onClick={() => testEmail.mutate()}
            >
              {testEmail.isPending ? 'Enviando…' : 'Enviar e-mail de teste'}
            </Button>
            {dirty && <span className="muted-inline">Salve antes de testar.</span>}
          </div>
          {testEmail.isSuccess && (
            <Alert severity="success">
              E-mail de teste enviado para {testEmail.data.recipients} destinatário(s).
            </Alert>
          )}
          {testEmail.error && <ErrorState error={testEmail.error} />}
        </div>
      </section>
      <section className="surface">
        <Typography variant="h6" component="h2">
          Fuso horário
        </Typography>
        <p className="section-help">
          Define a virada do dia para as validades e o horário do resumo por e-mail.
        </p>
        <TextField
          select
          label="Fuso horário da loja"
          value={timezone}
          onChange={(event) => {
            setTimezone(event.target.value);
            touch();
          }}
          required
        >
          {zones.map(([zone, label]) => (
            <MenuItem key={zone} value={zone}>
              {label}
            </MenuItem>
          ))}
        </TextField>
      </section>
      <div className="form-actions sticky-actions">
        <Button
          type="submit"
          variant="contained"
          size="large"
          disabled={!valid || mutation.isPending}
        >
          {mutation.isPending ? 'Salvando…' : 'Salvar configurações'}
        </Button>
        {saved && (
          <span className="save-state saved">
            <Icon name="check" size={16} /> Configurações salvas
          </span>
        )}
      </div>
      {mutation.error instanceof ApiError && mutation.error.code === 'VERSION_CONFLICT' ? (
        <Alert
          severity="warning"
          action={
            <Button color="inherit" size="small" onClick={reload}>
              Recarregar
            </Button>
          }
        >
          Outra pessoa salvou as configurações agora há pouco. Recarregue para ver os valores atuais
          antes de alterar.
        </Alert>
      ) : (
        mutation.error && <ErrorState error={mutation.error} />
      )}
    </form>
  );
}

export function IssuesPage() {
  const [classifying, setClassifying] = useState<Issue | null>(null);
  const [params, setParams] = useSearchParams();
  const cursor = params.get('cursor') ?? '';
  const status = params.get('status') === 'RESOLVED' ? 'RESOLVED' : 'OPEN';
  const summary = useDashboard();
  const query = useApiQuery<Page<Issue>>(
    `/reconciliation-issues${queryString({ cursor, status, limit: 50 })}`,
    { poll: true },
  );
  return (
    <>
      <PageTitle
        title="Divergências"
        description="Movimentos do sistema da loja que não encaixaram no estoque. Resolva para o saldo continuar certo."
      />
      <section className="surface table-surface">
        <div className="table-toolbar">
          <FilterChips
            label="Situação"
            value={status}
            onChange={(next) => setParams(next === 'RESOLVED' ? { status: next } : {})}
            options={[
              { value: 'OPEN', label: 'Abertas', count: summary.data?.openIssues },
              { value: 'RESOLVED', label: 'Resolvidas' },
            ]}
          />
          <Button
            className="toolbar-end"
            startIcon={<Icon name="refresh" size={18} />}
            onClick={() => void query.refetch()}
          >
            Atualizar
          </Button>
        </div>
        {query.isPending ? (
          <Loading />
        ) : query.isError ? (
          <ErrorState error={query.error} retry={() => void query.refetch()} />
        ) : !query.data.items.length ? (
          <Empty
            icon="check"
            title={
              status === 'OPEN' ? 'Nenhuma divergência aberta' : 'Nenhuma divergência resolvida'
            }
            description={
              status === 'OPEN'
                ? 'Tudo o que chegou do sistema da loja encaixou no estoque.'
                : 'As divergências resolvidas aparecem aqui.'
            }
          />
        ) : (
          <>
            <TableContainer>
              <Table className="responsive-table">
                <TableHead>
                  <TableRow>
                    <TableCell>Produto e pendência</TableCell>
                    <TableCell>Detectada em</TableCell>
                    <TableCell>Situação</TableCell>
                    <TableCell />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {query.data.items.map((issue) => {
                    const text = describeIssue(issue);
                    const classifiable =
                      issue.status === 'OPEN' &&
                      issue.type === 'PENDING_STOCK_IDENTIFICATION' &&
                      ['SCRAP', 'RETURN_RECEIPT'].includes(issue.movementType ?? '');
                    return (
                      <TableRow key={issue.id}>
                        <TableCell className="issue-cell cell-main">
                          {issue.productId ? (
                            <Link className="product-name" to={`/inventory/${issue.productId}`}>
                              {issue.productName ?? 'Produto'}
                            </Link>
                          ) : (
                            <span className="product-name">Produto não identificado</span>
                          )}
                          <strong className="issue-title">{text.title}</strong>
                          <span className="muted">{text.detail}</span>
                        </TableCell>
                        <TableCell data-label="Detectada em">
                          {formatDate(issue.createdAt)}
                        </TableCell>
                        <TableCell>
                          <Status value={issue.status} />
                        </TableCell>
                        <TableCell align="right" className="cell-wide">
                          {issue.productId ? (
                            <div className="inline-actions end">
                              {classifiable && (
                                <Button variant="outlined" onClick={() => setClassifying(issue)}>
                                  {issue.movementType === 'SCRAP'
                                    ? 'Identificar lote'
                                    : 'Informar validade'}
                                </Button>
                              )}
                              {issue.status === 'OPEN' && (
                                <Button
                                  component={Link}
                                  to={`/counts?productId=${issue.productId}`}
                                >
                                  Fazer contagem
                                </Button>
                              )}
                            </div>
                          ) : (
                            <Button component={Link} to="/imports">
                              Ver importações
                            </Button>
                          )}
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
              onNext={(next) => setParams({ status, cursor: next })}
              onReset={() => setParams(status === 'RESOLVED' ? { status } : {})}
            />
          </>
        )}
      </section>
      <p className="form-footnote">
        Uma contagem completa sempre resolve: o estoque do produto passa a ser o que foi contado.
      </p>
      {classifying && (
        <IssueClassification issue={classifying} close={() => setClassifying(null)} />
      )}
    </>
  );
}

export function AuditPage() {
  const { session } = useAuth();
  const [params, setParams] = useSearchParams();
  const cursor = params.get('cursor') ?? '';
  const query = useApiQuery<Page<AuditEvent>>(
    `/audit-events${queryString({ cursor, limit: 50 })}`,
    { poll: true },
  );
  // Só o proprietário lista a equipe; para os demais, o nome aparece quando é o próprio.
  const users = useApiQuery<Page<User>>('/users', { enabled: session?.user.role === 'OWNER' });
  const names = new Map((users.data?.items ?? []).map((user) => [user.id, user.username]));
  if (session) names.set(session.user.id, session.user.username);
  // Sem autor da loja: a plataforma (quem administra o serviço) ou o próprio sistema.
  const who = (id: string | null | undefined, action: string) =>
    id
      ? (names.get(id) ?? `Usuário ${id.slice(0, 8)}`)
      : action.startsWith('PLATFORM_')
        ? 'Plataforma'
        : 'Sistema';
  return (
    <>
      <PageTitle
        title="Histórico de ações"
        description="Quem fez o quê, e quando: entradas, contagens, acessos e mudanças de configuração."
        action={
          <Button
            startIcon={<Icon name="refresh" size={18} />}
            onClick={() => void query.refetch()}
          >
            Atualizar
          </Button>
        }
      />
      <section className="surface table-surface">
        {query.isPending ? (
          <Loading />
        ) : query.isError ? (
          <ErrorState error={query.error} retry={() => void query.refetch()} />
        ) : !query.data.items.length ? (
          <Empty icon="audit" title="Nenhuma ação registrada" />
        ) : (
          <>
            <TableContainer>
              <Table className="responsive-table">
                <TableHead>
                  <TableRow>
                    <TableCell>Quando</TableCell>
                    <TableCell>O que aconteceu</TableCell>
                    <TableCell>Quem</TableCell>
                    <TableCell>Registro</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {query.data.items.map((event) => (
                    <TableRow key={event.id}>
                      <TableCell className="nowrap">{formatDate(event.createdAt)}</TableCell>
                      <TableCell className="cell-main">
                        {auditLabel(event.action)}
                        {auditDetail(event.details) && (
                          <span className="muted">{auditDetail(event.details)}</span>
                        )}
                      </TableCell>
                      <TableCell data-label="Quem">{who(event.actorId, event.action)}</TableCell>
                      <TableCell className="cell-action">
                        {event.entityId && event.action.startsWith('count.') ? (
                          <Link className="text-link" to={`/counts/${event.entityId}`}>
                            Ver contagem
                          </Link>
                        ) : event.entityId && names.has(event.entityId) ? (
                          names.get(event.entityId)
                        ) : event.entityId && !event.action.startsWith('AUTH_') ? (
                          <code title={event.entityId}>{event.entityId.slice(0, 8)}</code>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
            <Pagination
              nextCursor={query.data.nextCursor}
              hasPrevious={!!cursor}
              onNext={(next) => setParams({ cursor: next })}
              onReset={() => setParams({})}
            />
          </>
        )}
      </section>
    </>
  );
}
