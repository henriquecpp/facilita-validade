import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useApiQuery, useBusinessMutation } from '../../shared/api/hooks';
import { ApiError } from '../../shared/api/client';
import type { CountSession, SaveCountLinesInput, Product } from '../../shared/api/types';
import {
  Empty,
  ErrorState,
  ExpiryDateField,
  Icon,
  Loading,
  PageTitle,
  Status,
} from '../../shared/ui/components';
import { formatDate, integer, units } from '../../shared/lib/format';
import { parseExpiryInput } from '../../shared/lib/expiry-date';
import { randomUuid } from '../../shared/lib/uuid';

export function CountPage() {
  const { countId } = useParams();
  const query = useApiQuery<CountSession>(`/count-sessions/${countId}`, {
    refetchOnWindowFocus: false,
  });
  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  if (query.data.status === 'CONFIRMED' || query.data.status === 'CANCELLED')
    return <FinishedCount count={query.data} />;
  return (
    <CountEditor
      key={`${query.data.id}:${query.data.version}`}
      count={query.data}
      reload={() => void query.refetch()}
    />
  );
}

/** Outro aparelho mexeu na contagem (nova versão) ou já a encerrou. */
function changedElsewhere(error: Error | null): boolean {
  return (
    error instanceof ApiError &&
    (error.code === 'VERSION_CONFLICT' || error.code === 'INVALID_COUNT_STATE')
  );
}

function useProductName(count: CountSession) {
  const product = useApiQuery<Product>(`/products/${count.productId}`);
  return product.data?.description ?? count.productName ?? 'Produto';
}

/** Contagem encerrada: só leitura, em tabela, sem campos desabilitados. */
function FinishedCount({ count }: { count: CountSession }) {
  const productName = useProductName(count);
  const lines = count.lines ?? [];
  const total = lines.reduce((sum, line) => sum + line.quantity, 0);
  return (
    <>
      <PageTitle
        back={{ to: `/products/${count.productId}`, label: productName }}
        title={productName}
        description={`Contagem ${count.status === 'CONFIRMED' ? 'confirmada' : 'cancelada'}. Iniciada em ${formatDate(count.startedAt ?? count.createdAt)}.`}
        action={<Status value={count.status} />}
      />
      <section className="surface table-surface">
        <div className="table-toolbar">
          <Typography variant="h6" component="h2">
            Lotes e validades encontrados
          </Typography>
        </div>
        {!lines.length ? (
          <Empty
            icon="count"
            title="Nenhuma unidade contada"
            description={
              count.status === 'CONFIRMED'
                ? 'A contagem confirmou que não havia unidades na loja.'
                : 'A contagem foi cancelada antes de ter quantidades.'
            }
          />
        ) : (
          <TableContainer>
            <Table className="responsive-table">
              <TableHead>
                <TableRow>
                  <TableCell>Validade</TableCell>
                  <TableCell>Lote</TableCell>
                  <TableCell align="right">Quantidade</TableCell>
                  <TableCell>Observação</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {lines.map((line) => (
                  <TableRow key={line.id}>
                    <TableCell className="cell-main" data-label="Validade">
                      {formatDate(line.expiresOn)}
                    </TableCell>
                    <TableCell data-label="Lote">{line.lotCode || 'Não informado'}</TableCell>
                    <TableCell align="right" className="quantity-cell" data-label="Quantidade">
                      {integer(line.quantity)}
                    </TableCell>
                    <TableCell className="cell-wide" data-label="Observação">
                      {line.note || '—'}
                    </TableCell>
                  </TableRow>
                ))}
                <TableRow className="total-row">
                  <TableCell colSpan={2}>Total contado</TableCell>
                  <TableCell align="right" className="quantity-cell">
                    {integer(total)}
                  </TableCell>
                  <TableCell className="hide-sm" />
                </TableRow>
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </section>
      <div className="form-actions">
        <Button component={Link} to={`/products/${count.productId}`} variant="outlined">
          Ver produto
        </Button>
      </div>
    </>
  );
}

type EditableLine = {
  id: string;
  expiresOn: string;
  quantity: string;
  lotCode: string;
  note: string;
};
function CountEditor({ count, reload }: { count: CountSession; reload: () => void }) {
  const navigate = useNavigate();
  const productName = useProductName(count);
  const [complete, setComplete] = useState(false);
  const [empty, setEmpty] = useState(false);
  const [error, setError] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [focusId, setFocusId] = useState<string | null>(null);
  const initial: EditableLine[] = (count.lines ?? []).map((line) => ({
    ...line,
    expiresOn: formatDate(line.expiresOn),
    quantity: String(line.quantity),
    lotCode: line.lotCode ?? '',
    note: line.note ?? '',
  }));
  const [lines, setLines] = useState<EditableLine[]>(initial);
  const dirty = JSON.stringify(lines) !== JSON.stringify(initial);
  const save = useBusinessMutation<SaveCountLinesInput>(`/count-sessions/${count.id}/lines`, 'PUT');
  const confirm = useBusinessMutation<{
    expectedVersion: number;
    completeConfirmed: boolean;
    emptyConfirmed?: boolean;
  }>(`/count-sessions/${count.id}/confirm`);
  const cancel = useBusinessMutation<{ expectedVersion: number; reason: string }>(
    `/count-sessions/${count.id}/cancel`,
  );
  const busy = save.isPending || confirm.isPending || cancel.isPending;
  const uncertain = save.isUncertain || confirm.isUncertain || cancel.isUncertain;
  const frozen = busy || uncertain;
  const total = lines.reduce((sum, line) => sum + (Number(line.quantity) || 0), 0);
  function change(id: string, field: keyof EditableLine, value: string) {
    setLines((current) =>
      current.map((line) => (line.id === id ? { ...line, [field]: value } : line)),
    );
    setComplete(false);
    setEmpty(false);
  }
  function addLine() {
    const id = randomUuid();
    setLines((current) => [...current, { id, expiresOn: '', quantity: '', lotCode: '', note: '' }]);
    setFocusId(id);
    setComplete(false);
  }
  function saveLines() {
    setError('');
    const invalid = lines.some(
      (line) =>
        !parseExpiryInput(line.expiresOn) ||
        !/^\d+$/.test(line.quantity) ||
        !Number.isSafeInteger(Number(line.quantity)) ||
        Number(line.quantity) > 1000000000 ||
        line.lotCode.length > 100 ||
        line.note.length > 1000,
    );
    if (invalid) {
      setError(
        'Confira as datas (DD/MM/AAAA ou só os números), quantidades inteiras entre zero e 1 bilhão, lotes até 100 caracteres e observações até 1.000 caracteres.',
      );
      return;
    }
    save.mutate({
      expectedVersion: count.version,
      lines: lines.map((line) => ({
        id: line.id,
        expiresOn: parseExpiryInput(line.expiresOn)!,
        quantity: Number(line.quantity),
        ...(line.lotCode.trim() ? { lotCode: line.lotCode.trim() } : {}),
        ...(line.note.trim() ? { note: line.note.trim() } : {}),
      })),
    });
  }
  return (
    <>
      <PageTitle
        back={{ to: `/products/${count.productId}`, label: productName }}
        title={productName}
        description={`Contagem em andamento, iniciada em ${formatDate(count.startedAt ?? count.createdAt)}.`}
        action={<Status value={count.status} />}
      />
      <div className="count-steps">
        <section className="surface">
          <div className="step-head">
            <span className="step-number">1</span>
            <div>
              <Typography variant="h6" component="h2">
                Lotes e validades encontrados
              </Typography>
              <span className="muted">
                Conte em todos os locais da loja e anote cada validade em uma linha. Salve logo
                depois de contar: vendas feitas depois disso são descontadas normalmente.
              </span>
            </div>
          </div>
          {lines.map((line, index) => (
            <div className="count-line" key={line.id}>
              <ExpiryDateField
                label={`Validade ${index + 1}`}
                value={line.expiresOn}
                disabled={frozen}
                autoFocus={line.id === focusId}
                onChange={(value) => change(line.id, 'expiresOn', value)}
              />
              <TextField
                label="Quantidade"
                type="number"
                value={line.quantity}
                disabled={frozen}
                onChange={(event) => change(line.id, 'quantity', event.target.value)}
                slotProps={{ htmlInput: { min: 0, step: 1, inputMode: 'numeric' } }}
              />
              <TextField
                label="Lote (opcional)"
                value={line.lotCode}
                disabled={frozen}
                onChange={(event) => change(line.id, 'lotCode', event.target.value)}
              />
              <TextField
                className="count-note"
                label={`Observação ${index + 1} (opcional)`}
                value={line.note}
                disabled={frozen}
                onChange={(event) => change(line.id, 'note', event.target.value)}
                slotProps={{ htmlInput: { maxLength: 1000 } }}
              />
              <Button
                color="inherit"
                className="remove-line"
                aria-label={`Remover linha ${index + 1}`}
                disabled={frozen}
                onClick={() => {
                  setLines((current) => current.filter((item) => item.id !== line.id));
                  setComplete(false);
                }}
              >
                Remover
              </Button>
            </div>
          ))}
          {!lines.length && (
            <Empty
              icon="calendar"
              title="Nenhuma validade anotada"
              description="Adicione uma linha para cada validade encontrada. Se não houver nenhuma unidade na loja, confirme o estoque zerado na revisão final."
            />
          )}
          <div className="count-footer">
            <Button variant="outlined" disabled={frozen} onClick={addLine}>
              + Adicionar validade
            </Button>
            <span className="count-total">
              Total contado: <strong>{units(total)}</strong>
            </span>
          </div>
          <div className="count-save">
            <Button
              variant="contained"
              disabled={busy || !dirty || confirm.isUncertain || cancel.isUncertain}
              onClick={saveLines}
            >
              {save.isPending ? 'Salvando…' : 'Salvar quantidades'}
            </Button>
            {dirty ? (
              <span className="save-state pending">Alterações ainda não salvas</span>
            ) : lines.length ? (
              <span className="save-state saved">
                <Icon name="check" size={16} /> Quantidades salvas
              </span>
            ) : null}
          </div>
          {error && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {error}
            </Alert>
          )}
        </section>
        <section className={`surface ${dirty ? 'is-waiting' : ''}`}>
          <div className="step-head">
            <span className="step-number">2</span>
            <div>
              <Typography variant="h6" component="h2">
                Revisão final
              </Typography>
              <span className="muted">
                O estoque do produto passa a ser exatamente o que foi contado. Validades que não
                estiverem na lista ficam zeradas.
              </span>
            </div>
          </div>
          <div className="confirm-checks">
            <FormControlLabel
              control={
                <Checkbox
                  checked={complete}
                  disabled={dirty || frozen}
                  onChange={(event) => setComplete(event.target.checked)}
                />
              }
              label="Conferi todos os lotes e locais da loja; as quantidades acima estão completas."
            />
            {total === 0 && (
              <FormControlLabel
                control={
                  <Checkbox
                    checked={empty}
                    disabled={dirty || frozen}
                    onChange={(event) => setEmpty(event.target.checked)}
                  />
                }
                label="Confirmo que o produto não possui nenhuma unidade física na loja."
              />
            )}
          </div>
          <Button
            variant="contained"
            size="large"
            disabled={
              dirty ||
              busy ||
              save.isUncertain ||
              cancel.isUncertain ||
              !complete ||
              (total === 0 && !empty)
            }
            onClick={() =>
              confirm.mutate(
                {
                  expectedVersion: count.version,
                  completeConfirmed: true,
                  ...(total === 0 ? { emptyConfirmed: true } : {}),
                },
                { onSuccess: () => navigate(`/products/${count.productId}`) },
              )
            }
          >
            Confirmar contagem completa
          </Button>
          {dirty && <p className="muted">Salve as quantidades antes da revisão final.</p>}
        </section>
      </div>
      {uncertain && (
        <Alert severity="warning" sx={{ mt: 2 }}>
          A resposta do envio anterior não foi confirmada. Repita a mesma ação para recuperar o
          resultado; os dados digitados foram preservados.
        </Alert>
      )}
      {[save.error, confirm.error, cancel.error].some(changedElsewhere) ? (
        <Alert
          severity="warning"
          sx={{ mt: 2 }}
          action={
            <Button color="inherit" size="small" onClick={reload}>
              Recarregar contagem
            </Button>
          }
        >
          Esta contagem foi alterada em outro lugar, por exemplo no coletor. Recarregue para ver as
          linhas atuais; o que não foi salvo aqui será descartado.
        </Alert>
      ) : (
        [save.error?.message, confirm.error?.message, cancel.error?.message]
          .filter(Boolean)
          .map((message) => (
            <Alert severity="error" key={message} sx={{ mt: 2 }}>
              {message}
            </Alert>
          ))
      )}
      <div className="form-actions">
        <Button component={Link} to={`/products/${count.productId}`} disabled={frozen}>
          Voltar ao produto
        </Button>
        <Button color="error" disabled={frozen} onClick={() => setCancelOpen(true)}>
          Cancelar contagem
        </Button>
      </div>
      <Dialog
        open={cancelOpen}
        onClose={() => !frozen && setCancelOpen(false)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>Cancelar esta contagem?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 2 }}>
            Nada muda no estoque: o saldo anterior é mantido.
          </Typography>
          <TextField
            label="Motivo do cancelamento"
            multiline
            rows={3}
            value={reason}
            disabled={cancel.isPending || cancel.isUncertain}
            onChange={(event) => setReason(event.target.value)}
            required
            helperText="Pelo menos 3 letras, para o histórico."
            slotProps={{ htmlInput: { maxLength: 1000 } }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCancelOpen(false)} disabled={frozen}>
            Continuar contagem
          </Button>
          <Button
            color="error"
            disabled={busy || reason.trim().length < 3}
            onClick={() =>
              cancel.mutate(
                { expectedVersion: count.version, reason: reason.trim() },
                { onSuccess: () => setCancelOpen(false) },
              )
            }
          >
            Confirmar cancelamento
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
