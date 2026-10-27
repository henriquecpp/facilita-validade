import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, FormControlLabel, Typography } from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import { api } from '../../shared/api/client';
import { useApiQuery, useBusinessMutation } from '../../shared/api/hooks';
import { ApiError } from '../../shared/api/client';
import type { PushPreferences, PushPreferencesInput } from './push-preferences';
import type { PushConfig } from '../../shared/api/types';
import { ErrorState, Loading } from '../../shared/ui/components';
import { currentSubscription, disablePush, enablePush, pushSupported } from '../../shared/lib/push';

/**
 * Notificações push neste navegador (AV18), só do proprietário: lote que entra num nível que
 * avisa ou vence, lote zerado pelas vendas e o resumo do dia. Instalado como aplicativo, o
 * painel recebe mesmo fechado.
 */
export function PushNotificationsSection() {
  const config = useApiQuery<PushConfig>('/push/config', { refetchOnWindowFocus: false });
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const test = useMutation({
    mutationFn: () => api<{ sent: number; targets: number }>('/push/test', { method: 'POST' }),
  });
  useEffect(() => {
    void currentSubscription().then((subscription) => setSubscribed(!!subscription));
  }, []);
  const toggle = async (on: boolean) => {
    setBusy(true);
    setError('');
    try {
      if (on) await enablePush(config.data!);
      else await disablePush();
      setSubscribed(on);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Não foi possível alterar as notificações.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="surface">
      <Typography variant="h6" component="h2">
        Notificações push
      </Typography>
      <p className="section-help">
        Escolha os avisos no computador e no celular. A frequência de cada nível é configurada pelo
        sino em Níveis de urgência. Só o proprietário recebe. Para receber com o painel fechado,
        instale o painel como aplicativo pelo menu do navegador.
      </p>
      {config.data?.allowed && <PushChoices />}
      {config.isPending ? (
        <Loading />
      ) : config.isError ? (
        <ErrorState error={config.error} retry={() => void config.refetch()} />
      ) : !config.data.allowed ? (
        <Alert severity="info">Só o proprietário da loja recebe notificações push.</Alert>
      ) : !config.data.webPushPublicKey ? (
        <Alert severity="warning">
          O servidor ainda não tem as notificações push configuradas. Fale com o suporte.
        </Alert>
      ) : !pushSupported() ? (
        <Alert severity="warning">
          Este navegador não recebe notificações push. No iPhone, instale o painel na tela de início
          primeiro.
        </Alert>
      ) : (
        <div className="form-stack">
          <Alert severity={subscribed ? 'success' : 'info'}>
            {subscribed
              ? 'Este navegador recebe as notificações da loja.'
              : 'Este navegador ainda não recebe as notificações da loja.'}
          </Alert>
          <div className="inline-actions">
            {subscribed ? (
              <>
                <Button
                  variant="outlined"
                  disabled={busy || test.isPending}
                  onClick={() => test.mutate()}
                >
                  {test.isPending ? 'Enviando…' : 'Enviar notificação de teste'}
                </Button>
                <Button color="inherit" disabled={busy} onClick={() => void toggle(false)}>
                  Desligar neste navegador
                </Button>
              </>
            ) : (
              <Button variant="contained" disabled={busy} onClick={() => void toggle(true)}>
                {busy ? 'Ativando…' : 'Receber notificações neste navegador'}
              </Button>
            )}
          </div>
          {test.isSuccess && (
            <Alert severity="success">
              Notificação de teste enviada para {test.data.sent} de {test.data.targets} aparelho(s).
            </Alert>
          )}
          {test.error && <ErrorState error={test.error} />}
          {error && <Alert severity="error">{error}</Alert>}
        </div>
      )}
    </section>
  );
}

function PushChoices() {
  const query = useApiQuery<PushPreferences>('/push/preferences', { refetchOnWindowFocus: false });
  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  return (
    <PushChoicesEditor
      key={query.data.version}
      preferences={query.data}
      reload={() => void query.refetch()}
    />
  );
}

function PushChoicesEditor({
  preferences,
  reload,
}: {
  preferences: PushPreferences;
  reload: () => void;
}) {
  const [dailyDigestEnabled, setDaily] = useState(preferences.dailyDigestEnabled);
  const [depletedEnabled, setDepleted] = useState(preferences.depletedEnabled);
  const mutation = useBusinessMutation<PushPreferencesInput, PushPreferences>(
    '/push/preferences',
    'PUT',
  );
  const dirty =
    dailyDigestEnabled !== preferences.dailyDigestEnabled ||
    depletedEnabled !== preferences.depletedEnabled;
  return (
    <form
      className="form-stack"
      onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate({
          expectedVersion: preferences.version,
          dailyDigestEnabled,
          depletedEnabled,
          levels: preferences.levels,
        });
      }}
    >
      <FormControlLabel
        disabled={mutation.isPending || mutation.isUncertain}
        control={
          <Checkbox
            checked={dailyDigestEnabled}
            onChange={(event) => setDaily(event.target.checked)}
          />
        }
        label="Receber resumo diário por push no horário configurado para o resumo"
      />
      <FormControlLabel
        disabled={mutation.isPending || mutation.isUncertain}
        control={
          <Checkbox
            checked={depletedEnabled}
            onChange={(event) => setDepleted(event.target.checked)}
          />
        }
        label="Avisar quando as vendas zerarem um lote, com a última quantidade abatida"
      />
      {mutation.isUncertain && (
        <Alert severity="warning">
          O envio ainda não foi confirmado. Tente salvar novamente com os mesmos dados.
        </Alert>
      )}
      <div>
        <Button type="submit" variant="outlined" disabled={!dirty || mutation.isPending}>
          {mutation.isPending ? 'Salvando…' : 'Salvar escolhas de push'}
        </Button>
      </div>
      {mutation.error instanceof ApiError &&
      ['VERSION_CONFLICT', 'LEVELS_CHANGED'].includes(mutation.error.code) ? (
        <Alert severity="warning" action={<Button onClick={reload}>Recarregar</Button>}>
          {mutation.error.message}
        </Alert>
      ) : (
        mutation.error && <ErrorState error={mutation.error} />
      )}
    </form>
  );
}
