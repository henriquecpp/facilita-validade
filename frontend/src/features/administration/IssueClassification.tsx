import { useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  TextField,
  Typography,
} from '@mui/material';
import { useApiQuery, useBusinessMutation } from '../../shared/api/hooks';
import type { InventoryDetail, Issue, ResolveIssueInput } from '../../shared/api/types';
import { formatDate } from '../../shared/lib/format';
import { parseExpiryInput } from '../../shared/lib/expiry-date';
import { ErrorState, ExpiryDateField, Loading } from '../../shared/ui/components';
export function IssueClassification({ issue, close }: { issue: Issue; close: () => void }) {
  const isScrap = issue.movementType === 'SCRAP';
  const inventory = useApiQuery<InventoryDetail>(`/inventory/products/${issue.productId}`, {
    enabled: isScrap && !!issue.productId,
  });
  const [recordId, setRecordId] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [lotCode, setLotCode] = useState('');
  const [reason, setReason] = useState('');
  const mutation = useBusinessMutation<ResolveIssueInput>(
    `/reconciliation-issues/${issue.id}/resolve`,
  );
  const locked = mutation.isPending || mutation.isUncertain;
  const valid = reason.trim().length >= 3 && (isScrap ? !!recordId : !!parseExpiryInput(expiresOn));
  return (
    <Dialog open onClose={() => !locked && close()} fullWidth maxWidth="sm">
      <DialogTitle>{isScrap ? 'Identificar o descarte' : 'Identificar a devolução'}</DialogTitle>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (valid)
            mutation.mutate(
              {
                action: 'CLASSIFY',
                reason: reason.trim(),
                ...(isScrap
                  ? { recordId }
                  : {
                      expiresOn: parseExpiryInput(expiresOn)!,
                      ...(lotCode.trim() ? { lotCode: lotCode.trim() } : {}),
                    }),
              },
              { onSuccess: close },
            );
        }}
      >
        <DialogContent>
          <div className="form-stack">
            <Typography sx={{ fontWeight: 650 }}>
              {issue.productName}
              {issue.quantity != null && (
                <span className="muted">
                  {issue.quantity} {issue.quantity === 1 ? 'unidade' : 'unidades'}{' '}
                  {isScrap ? 'descartadas' : 'devolvidas'}
                </span>
              )}
            </Typography>
            <Alert severity="info">
              {isScrap
                ? 'Confira na loja de qual lote saiu o descarte.'
                : 'Confira a validade impressa na mercadoria devolvida.'}{' '}
              A escolha fica no histórico e o estoque é recalculado desde a data do movimento.
            </Alert>
            {isScrap ? (
              inventory.isPending ? (
                <Loading />
              ) : inventory.isError ? (
                <ErrorState error={inventory.error} />
              ) : (
                <TextField
                  disabled={locked}
                  select
                  label="Lote que foi descartado"
                  value={recordId}
                  onChange={(event) => setRecordId(event.target.value)}
                  required
                >
                  {inventory.data.records.map((record) => (
                    <MenuItem key={record.id} value={record.id}>
                      Validade {formatDate(record.expiresOn)} · Lote{' '}
                      {record.lotCode || 'não informado'} · {record.quantity} em estoque
                    </MenuItem>
                  ))}
                </TextField>
              )
            ) : (
              <>
                <ExpiryDateField
                  disabled={locked}
                  label="Validade da mercadoria devolvida"
                  value={expiresOn}
                  onChange={setExpiresOn}
                  required
                />
                <TextField
                  disabled={locked}
                  label="Lote (opcional)"
                  value={lotCode}
                  onChange={(event) => setLotCode(event.target.value)}
                  slotProps={{ htmlInput: { maxLength: 100 } }}
                />
              </>
            )}
            <TextField
              disabled={locked}
              label="Motivo e conferência realizada"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              multiline
              rows={3}
              required
              slotProps={{ htmlInput: { maxLength: 1000 } }}
            />
            {mutation.isUncertain && (
              <Alert severity="warning">
                A resposta não foi confirmada. Clique novamente em Confirmar classificação para
                recuperar o resultado com os mesmos dados.
              </Alert>
            )}
            {mutation.error && <ErrorState error={mutation.error} />}
          </div>
        </DialogContent>
        <DialogActions>
          <Button onClick={close} disabled={locked}>
            Voltar
          </Button>
          <Button type="submit" variant="contained" disabled={!valid || mutation.isPending}>
            Confirmar classificação
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
