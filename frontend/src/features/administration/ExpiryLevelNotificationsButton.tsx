import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  TextField,
  Tooltip,
} from '@mui/material';
import { useApiQuery, useBusinessMutation } from '../../shared/api/hooks';
import { ApiError } from '../../shared/api/client';
import { ErrorState, Icon, Loading } from '../../shared/ui/components';
import type { PushPreferences, PushPreferencesInput } from './push-preferences';

export function ExpiryLevelNotificationsButton({
  levelId,
  levelName,
  disabled = false,
}: {
  levelId: string;
  levelName: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [locked, setLocked] = useState(false);
  return (
    <>
      <Tooltip
        title={
          disabled ? 'Ative “Avisa” para configurar as notificações.' : 'Configurar notificações'
        }
      >
        <span>
          <IconButton
            disabled={disabled}
            aria-label={`Notificações do nível ${levelName}`}
            onClick={() => setOpen(true)}
          >
            <Icon name="bell" size={18} />
          </IconButton>
        </span>
      </Tooltip>
      <Dialog
        open={open}
        onClose={() => {
          if (!locked) setOpen(false);
        }}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Notificações: {levelName}</DialogTitle>
        {open && (
          <LevelNotificationSettings
            levelId={levelId}
            onClose={() => setOpen(false)}
            onLockChange={setLocked}
          />
        )}
      </Dialog>
    </>
  );
}

function LevelNotificationSettings({
  levelId,
  onClose,
  onLockChange,
}: {
  levelId: string;
  onClose: () => void;
  onLockChange: (locked: boolean) => void;
}) {
  const query = useApiQuery<PushPreferences>('/push/preferences', { refetchOnWindowFocus: false });
  const settings = useApiQuery<{ timezone: string }>('/store/settings');
  if (query.isPending)
    return (
      <DialogContent>
        <Loading />
      </DialogContent>
    );
  if (query.isError)
    return (
      <DialogContent>
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      </DialogContent>
    );
  return (
    <Editor
      key={query.data.version}
      preferences={query.data}
      levelId={levelId}
      timezone={settings.data?.timezone}
      onClose={onClose}
      onLockChange={onLockChange}
      reload={() => void query.refetch()}
    />
  );
}

function Editor({
  preferences,
  levelId,
  timezone,
  onClose,
  onLockChange,
  reload,
}: {
  preferences: PushPreferences;
  levelId: string;
  timezone?: string;
  onClose: () => void;
  onLockChange: (locked: boolean) => void;
  reload: () => void;
}) {
  const existing = preferences.levels.find((level) => level.levelId === levelId);
  const [immediate, setImmediate] = useState(existing?.immediate ?? true);
  const [periodic, setPeriodic] = useState(existing?.intervalHours != null);
  const [hours, setHours] = useState(String(existing?.intervalHours ?? 3));
  const [daily, setDaily] = useState(existing?.dailyTime != null);
  const [time, setTime] = useState(existing?.dailyTime ?? '08:00');
  const mutation = useBusinessMutation<PushPreferencesInput, PushPreferences>(
    '/push/preferences',
    'PUT',
  );
  const locked = mutation.isPending || mutation.isUncertain;
  useEffect(() => {
    onLockChange(locked);
    return () => onLockChange(false);
  }, [locked, onLockChange]);
  const valid =
    !!existing &&
    (!periodic || (/^\d+$/.test(hours) && Number(hours) >= 1 && Number(hours) <= 24)) &&
    (!daily || /^([01]\d|2[0-3]):[0-5]\d$/.test(time));
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        mutation.mutate(
          {
            expectedVersion: preferences.version,
            dailyDigestEnabled: preferences.dailyDigestEnabled,
            depletedEnabled: preferences.depletedEnabled,
            levels: preferences.levels.map((level) =>
              level.levelId === levelId
                ? {
                    levelId,
                    immediate,
                    intervalHours: periodic ? Number(hours) : null,
                    dailyTime: daily ? time : null,
                  }
                : level,
            ),
          },
          { onSuccess: onClose },
        );
      }}
    >
      <DialogContent className="form-stack">
        <p>
          Escolha uma ou mais formas de avisar sobre os lotes deste nível. Só o proprietário recebe.
        </p>
        <fieldset
          disabled={locked}
          className="form-stack"
          style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
        >
          <FormControlLabel
            control={
              <Checkbox checked={immediate} onChange={(e) => setImmediate(e.target.checked)} />
            }
            label="Quando um lote entrar neste nível"
          />
          <FormControlLabel
            control={
              <Checkbox checked={periodic} onChange={(e) => setPeriodic(e.target.checked)} />
            }
            label="Repetir enquanto houver lotes neste nível"
          />
          {periodic && (
            <TextField
              label="Intervalo em horas"
              value={hours}
              type="number"
              onChange={(e) => setHours(e.target.value)}
              slotProps={{ htmlInput: { min: 1, max: 24, step: 1 } }}
              helperText="De 1 a 24 horas"
            />
          )}
          <FormControlLabel
            control={<Checkbox checked={daily} onChange={(e) => setDaily(e.target.checked)} />}
            label="Avisar diariamente neste horário"
          />
          {daily && (
            <TextField
              label="Horário"
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              slotProps={{ inputLabel: { shrink: true } }}
              helperText={timezone ? `Fuso da loja: ${timezone}` : 'Horário da loja'}
            />
          )}
        </fieldset>
        {mutation.isUncertain && (
          <Alert severity="warning">
            O envio ainda não foi confirmado. Tente salvar novamente com os mesmos dados.
          </Alert>
        )}
        {!immediate && !periodic && !daily && (
          <Alert severity="info">
            Este nível continuará na lista de alertas e no resumo diário, se habilitado.
          </Alert>
        )}
        {mutation.error instanceof ApiError &&
        ['VERSION_CONFLICT', 'LEVELS_CHANGED'].includes(mutation.error.code) ? (
          <Alert severity="warning" action={<Button onClick={reload}>Recarregar</Button>}>
            {mutation.error.message}
          </Alert>
        ) : (
          mutation.error && <ErrorState error={mutation.error} />
        )}
        {!existing && (
          <Alert severity="warning">Este nível foi removido. Recarregue a página.</Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button disabled={locked} onClick={onClose}>
          Cancelar
        </Button>
        <Button type="submit" variant="contained" disabled={!valid || mutation.isPending}>
          {mutation.isPending ? 'Salvando…' : 'Salvar'}
        </Button>
      </DialogActions>
    </form>
  );
}
