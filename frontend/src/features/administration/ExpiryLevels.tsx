import { useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  FormControlLabel,
  IconButton,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { useApiQuery, useBusinessMutation } from '../../shared/api/hooks';
import { ApiError } from '../../shared/api/client';
import type { ExpiryLevels, ExpiryLevelsInput } from '../../shared/api/types';
import { ErrorState, Icon, LevelBadge, Loading } from '../../shared/ui/components';
import { describeRange, duplicateLevelLimit, levelHierarchy } from '../../shared/lib/risk';
import { randomUuid } from '../../shared/lib/uuid';
import { ExpiryLevelNotificationsButton } from './ExpiryLevelNotificationsButton';

type Draft = {
  key: string;
  id?: string;
  name: string;
  maxDays: string;
  color: string;
  notify: boolean;
};

const toDraft = (level: ExpiryLevels['items'][number]): Draft => ({
  key: level.id,
  id: level.id,
  name: level.name,
  maxDays: level.maxDays == null ? '' : String(level.maxDays),
  color: level.color,
  notify: level.notify,
});
const days = (value: string) => (value.trim() === '' ? null : Number(value));
const validDays = (value: string) =>
  value.trim() === '' || (/^-?\d+$/.test(value.trim()) && Math.abs(Number(value)) <= 36500);

/**
 * Níveis de urgência da loja (NV01): um limite por nível, com os inícios derivados da
 * hierarquia. Vencido e Em dia são registros editáveis como os demais, sem níveis implícitos.
 */
export function ExpiryLevelsSection() {
  const query = useApiQuery<ExpiryLevels>('/store/expiry-levels', { refetchOnWindowFocus: false });
  // Fora do editor: salvar muda a versão, o editor é recriado e o aviso sumiria na hora.
  const [saved, setSaved] = useState(false);
  return (
    <section className="surface">
      <Typography variant="h6" component="h2">
        Níveis de urgência
      </Typography>
      <p className="section-help">
        Defina até quantos dias cada nível vale: 0 é hoje, negativos são vencidos. Os limites
        ordenam os níveis e preenchem os intervalos. Um único nível pode ficar sem limite para
        cobrir os dias restantes.
      </p>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : (
        <LevelsEditor
          key={query.data.version}
          levels={query.data}
          saved={saved}
          setSaved={setSaved}
          reload={() => void query.refetch()}
        />
      )}
    </section>
  );
}

function LevelsEditor({
  levels,
  saved,
  setSaved,
  reload,
}: {
  levels: ExpiryLevels;
  saved: boolean;
  setSaved: (saved: boolean) => void;
  reload: () => void;
}) {
  const initial = levels.items.map(toDraft);
  const [drafts, setDrafts] = useState<Draft[]>(initial);
  const mutation = useBusinessMutation<ExpiryLevelsInput, ExpiryLevels>(
    '/store/expiry-levels',
    'PUT',
  );
  const change = (key: string, patch: Partial<Draft>) => {
    setSaved(false);
    setDrafts((current) =>
      current.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    );
  };
  const names = drafts.map((item) =>
    item.name.normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('pt-BR'),
  );
  const problems = drafts.map((item, index) => {
    if (!item.name.trim()) return 'Dê um nome ao nível.';
    if (names.indexOf(names[index]!) !== index) return 'Já há um nível com este nome.';
    if (!validDays(item.maxDays)) return 'Use um limite inteiro entre −36500 e 36500 dias.';
    return null;
  });
  const parsed = drafts.map((item) => ({
    ...item,
    name: item.name.trim(),
    maxDays: validDays(item.maxDays) ? days(item.maxDays) : null,
  }));
  const duplicate = problems.every((problem) => !problem) ? duplicateLevelLimit(parsed) : null;
  const valid = problems.every((problem) => !problem) && !duplicate;
  const dirty = JSON.stringify(drafts) !== JSON.stringify(initial);
  return (
    <form
      className="form-stack"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        mutation.mutate(
          {
            expectedVersion: levels.version,
            levels: drafts.map((item) => ({
              ...(item.id ? { id: item.id } : {}),
              name: item.name.trim(),
              maxDays: days(item.maxDays),
              color: item.color,
              notify: item.notify,
            })),
          },
          { onSuccess: () => setSaved(true) },
        );
      }}
    >
      <div className="levels-editor">
        {drafts.map((item, index) => (
          <div className="level-row" key={item.key}>
            <input
              type="color"
              className="level-color"
              aria-label={`Cor do nível ${item.name || index + 1}`}
              value={item.color}
              onChange={(event) => change(item.key, { color: event.target.value })}
            />
            <TextField
              className="level-name"
              label="Nome"
              value={item.name}
              onChange={(event) => change(item.key, { name: event.target.value })}
              error={!!problems[index]}
              helperText={problems[index] ?? ' '}
              slotProps={{ htmlInput: { maxLength: 40 } }}
            />
            <TextField
              className="level-limit"
              label="Limite (dias)"
              value={item.maxDays}
              placeholder="sem limite"
              onChange={(event) => change(item.key, { maxDays: event.target.value })}
              helperText=" "
              slotProps={{ htmlInput: { inputMode: 'numeric' } }}
            />
            <FormControlLabel
              className="level-notify"
              control={
                <Checkbox
                  checked={item.notify}
                  onChange={(event) => change(item.key, { notify: event.target.checked })}
                />
              }
              label="Avisa"
            />
            {item.id ? (
              <ExpiryLevelNotificationsButton
                levelId={item.id}
                levelName={item.name}
                disabled={!item.notify}
              />
            ) : (
              <Tooltip title="Salve o nível para configurar os avisos">
                <span>
                  <IconButton disabled aria-label="Configurar avisos após salvar o nível">
                    <Icon name="bell" size={18} />
                  </IconButton>
                </span>
              </Tooltip>
            )}
            <Tooltip title="Remover nível">
              <IconButton
                aria-label={`Remover o nível ${item.name || index + 1}`}
                onClick={() => {
                  setSaved(false);
                  setDrafts((current) => current.filter((other) => other.key !== item.key));
                }}
              >
                <Icon name="trash" size={18} />
              </IconButton>
            </Tooltip>
          </div>
        ))}
      </div>
      <div className="inline-actions">
        <Button
          variant="outlined"
          startIcon={<Icon name="plus" size={18} />}
          onClick={() => {
            setSaved(false);
            setDrafts((current) => [
              ...current,
              {
                key: randomUuid(),
                name: '',
                maxDays: '',
                color: '#607d8b',
                notify: true,
              },
            ]);
          }}
        >
          Adicionar nível
        </Button>
      </div>
      {duplicate && (
        <Alert severity="error">
          “{duplicate[0]}” e “{duplicate[1]}” têm o mesmo limite. Use limites diferentes e apenas um
          nível sem limite.
        </Alert>
      )}
      {valid && drafts.length > 0 && (
        <div className="risk-scale" aria-label="Como os lotes serão classificados">
          {levelHierarchy(parsed).map((item) => (
            <LevelBadge key={item.key} color={item.color} name={item.name}>
              {item.name}: {describeRange(item)}
              {item.notify ? '' : ' (sem aviso)'}
            </LevelBadge>
          ))}
        </div>
      )}
      {!drafts.length && (
        <Alert severity="warning">
          Sem níveis, nenhum lote fica em atenção e não há alertas de validade.
        </Alert>
      )}
      <div className="inline-actions">
        <Button type="submit" variant="contained" disabled={!valid || !dirty || mutation.isPending}>
          {mutation.isPending ? 'Salvando…' : 'Salvar níveis'}
        </Button>
        {saved && !dirty && (
          <span className="save-state saved">
            <Icon name="check" size={16} /> Níveis salvos
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
          Outra pessoa salvou os níveis agora há pouco. Recarregue antes de alterar.
        </Alert>
      ) : (
        mutation.error && <ErrorState error={mutation.error} />
      )}
    </form>
  );
}
