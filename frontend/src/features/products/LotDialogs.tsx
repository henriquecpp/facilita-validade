import { useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
} from '@mui/material';
import { useBusinessMutation } from '../../shared/api/hooks';
import { ApiError } from '../../shared/api/client';
import type {
  InventoryDetail,
  RecordEditInput,
  StockRecord,
  VersionInput,
  WriteOffInput,
} from '../../shared/api/types';
import { ExpiryDateField } from '../../shared/ui/components';
import { formatDate, integer, units } from '../../shared/lib/format';
import { parseExpiryInput } from '../../shared/lib/expiry-date';

/** O lote numa linha: validade, lote textual e saldo. */
function LotSummary({ lot }: { lot: StockRecord }) {
  return (
    <div className="lot-summary">
      <span>
        <small>Validade</small>
        <strong>{formatDate(lot.expiresOn)}</strong>
      </span>
      <span>
        <small>Lote</small>
        <strong>{lot.lotCode || 'Não informado'}</strong>
      </span>
      <span>
        <small>Lançado</small>
        <strong>{integer(lot.launchedQuantity ?? lot.quantity)}</strong>
      </span>
      <span>
        <small>Saldo</small>
        <strong>{integer(lot.quantity)}</strong>
      </span>
    </div>
  );
}

/** Lote mexido em outro lugar desde que a tela abriu: a versão não confere. */
function staleMessage(error: Error | null) {
  return error instanceof ApiError && error.code === 'VERSION_CONFLICT'
    ? 'O lote foi alterado em outro lugar. Feche e confira o saldo atual antes de repetir.'
    : error?.message;
}

/** Baixa manual de parte ou de todo o saldo de um lote (AV05). */
export function WriteOffDialog({ lot, onClose }: { lot: StockRecord; onClose: () => void }) {
  const [quantity, setQuantity] = useState(String(lot.quantity));
  const [reason, setReason] = useState('');
  const mutation = useBusinessMutation<WriteOffInput, InventoryDetail>(
    `/inventory/records/${lot.id}/write-off`,
  );
  const amount = Number(quantity);
  const valid = /^\d+$/.test(quantity) && amount >= 1 && amount <= lot.quantity;
  const locked = mutation.isPending || mutation.isUncertain;
  return (
    <Dialog open onClose={() => !locked && onClose()} fullWidth maxWidth="sm">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          mutation.mutate(
            {
              expectedVersion: lot.version ?? 1,
              quantity: amount,
              ...(reason.trim() ? { reason: reason.trim() } : {}),
            },
            { onSuccess: onClose },
          );
        }}
      >
        <DialogTitle>Dar baixa no lote</DialogTitle>
        <DialogContent>
          <LotSummary lot={lot} />
          <Typography variant="body2" color="text.secondary" sx={{ my: 2 }}>
            A baixa manual tira unidades só deste lote, até o saldo dele, e fica registrada separada
            das vendas. As vendas seguintes consomem o que sobrar.
          </Typography>
          <div className="form-stack">
            <TextField
              label="Quantidade a baixar"
              type="number"
              value={quantity}
              disabled={locked}
              autoFocus
              onChange={(event) => setQuantity(event.target.value)}
              error={!!quantity && !valid}
              helperText={
                !quantity || valid
                  ? `Até ${units(lot.quantity)}, o saldo do lote.`
                  : `Use um número inteiro de 1 a ${integer(lot.quantity)}.`
              }
              slotProps={{
                htmlInput: { min: 1, max: lot.quantity, step: 1, inputMode: 'numeric' },
              }}
            />
            <TextField
              label="Motivo (opcional)"
              value={reason}
              disabled={locked}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Ex.: embalagem danificada, vencido retirado da gôndola"
              slotProps={{ htmlInput: { maxLength: 500 } }}
            />
            {mutation.isUncertain && (
              <Alert severity="warning">
                A resposta não foi confirmada. Clique de novo em Dar baixa para recuperar o
                resultado sem baixar duas vezes.
              </Alert>
            )}
            {mutation.error && <Alert severity="error">{staleMessage(mutation.error)}</Alert>}
          </div>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} disabled={locked}>
            Voltar
          </Button>
          <Button type="submit" variant="contained" disabled={!valid || mutation.isPending}>
            {mutation.isPending ? 'Baixando…' : `Dar baixa de ${valid ? units(amount) : '…'}`}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

/**
 * Edição da validade e da quantidade lançada, só do proprietário (AV08). Vale dali em
 * diante: o que já saiu do lote fica como está, e o lançado não desce abaixo disso.
 */
export function EditLotDialog({ lot, onClose }: { lot: StockRecord; onClose: () => void }) {
  const [expiresOn, setExpiresOn] = useState(formatDate(lot.expiresOn));
  const launched = lot.launchedQuantity ?? lot.quantity;
  const [quantity, setQuantity] = useState(String(launched));
  const mutation = useBusinessMutation<RecordEditInput, InventoryDetail>(
    `/inventory/records/${lot.id}`,
    'PATCH',
  );
  const taken = (lot.soldQuantity ?? 0) + (lot.writtenOffQuantity ?? 0);
  const kept =
    taken === 1
      ? 'a unidade que já saiu deste lote continua nele'
      : `as ${integer(taken)} unidades que já saíram deste lote continuam nele`;
  const iso = parseExpiryInput(expiresOn);
  const amount = Number(quantity);
  const quantityValid = /^\d+$/.test(quantity) && amount >= Math.max(1, taken);
  const changed = (iso !== null && iso !== lot.expiresOn) || amount !== launched;
  const valid = !!iso && quantityValid && changed;
  const locked = mutation.isPending || mutation.isUncertain;
  return (
    <Dialog open onClose={() => !locked && onClose()} fullWidth maxWidth="sm">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          mutation.mutate(
            {
              expectedVersion: lot.version ?? 1,
              ...(iso !== lot.expiresOn ? { expiresOn: iso! } : {}),
              ...(amount !== launched ? { quantity: amount } : {}),
            },
            { onSuccess: onClose },
          );
        }}
      >
        <DialogTitle>Editar lote</DialogTitle>
        <DialogContent>
          <LotSummary lot={lot} />
          <Alert severity="info" sx={{ my: 2 }}>
            A edição vale daqui para a frente:{' '}
            {taken
              ? `${kept}, e só as próximas vendas usam a validade e a quantidade novas.`
              : 'as próximas vendas usam a validade e a quantidade novas.'}
          </Alert>
          <div className="record-form">
            <ExpiryDateField
              label="Validade"
              value={expiresOn}
              disabled={locked}
              onChange={setExpiresOn}
              error={!!expiresOn && !iso}
              helperText={!expiresOn || iso ? undefined : 'Informe uma data válida em DD/MM/AAAA.'}
            />
            <TextField
              label="Quantidade lançada"
              type="number"
              value={quantity}
              disabled={locked}
              onChange={(event) => setQuantity(event.target.value)}
              error={!!quantity && !quantityValid}
              helperText={
                quantityValid || !quantity
                  ? `Saldo depois da edição: ${integer(Math.max(0, amount - taken))}.`
                  : `No mínimo ${integer(Math.max(1, taken))}: o que já saiu do lote.`
              }
              slotProps={{ htmlInput: { min: Math.max(1, taken), step: 1, inputMode: 'numeric' } }}
            />
          </div>
          {mutation.error && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {staleMessage(mutation.error)}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} disabled={locked}>
            Voltar
          </Button>
          <Button type="submit" variant="contained" disabled={!valid || mutation.isPending}>
            {mutation.isPending ? 'Salvando…' : 'Salvar edição'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

/**
 * Exclusão de um lote, mesmo com vendas (AV07): as baixas do produto são refeitas sem ele, e
 * o lote fica no histórico como Excluído.
 */
export function DeleteLotDialog({ lot, onClose }: { lot: StockRecord; onClose: () => void }) {
  const mutation = useBusinessMutation<VersionInput, InventoryDetail>(
    `/inventory/records/${lot.id}/delete`,
  );
  const sold = lot.soldQuantity ?? 0;
  const locked = mutation.isPending || mutation.isUncertain;
  return (
    <Dialog open onClose={() => !locked && onClose()} fullWidth maxWidth="sm">
      <DialogTitle>Excluir este lote?</DialogTitle>
      <DialogContent>
        <LotSummary lot={lot} />
        <Typography variant="body2" sx={{ mt: 2 }}>
          O lote sai da lista e fica no histórico do produto como Excluído.
        </Typography>
        {sold > 0 && (
          <Alert severity="warning" sx={{ mt: 2 }}>
            {units(sold)} vendidas saíram deste lote. Com a exclusão, essas vendas passam para os
            outros lotes, do que vence antes, ou ficam sem lote se não couberem.
          </Alert>
        )}
        {mutation.error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {staleMessage(mutation.error)}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={locked}>
          Voltar
        </Button>
        <Button
          color="error"
          variant="contained"
          disabled={mutation.isPending}
          onClick={() =>
            mutation.mutate({ expectedVersion: lot.version ?? 1 }, { onSuccess: onClose })
          }
        >
          {mutation.isPending ? 'Excluindo…' : 'Excluir lote'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
