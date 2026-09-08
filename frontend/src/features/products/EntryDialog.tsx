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
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useApiQuery, useBusinessMutation } from '../../shared/api/hooks';
import { queryString } from '../../shared/api/client';
import type {
  CountSession,
  InventoryDetail,
  Page,
  Product,
  ReceiptInput,
} from '../../shared/api/types';
import { ExpiryDateField, Loading } from '../../shared/ui/components';
import { parseExpiryInput } from '../../shared/lib/expiry-date';
import { ProductPicker } from '../inventory/ProductPicker';

const schema = z.object({
  quantity: z
    .number({ error: 'Informe a quantidade.' })
    .int('Use unidades inteiras.')
    .positive('A quantidade deve ser maior que zero.')
    .max(1000000000, 'Use no máximo 1 bilhão de unidades.'),
  expiresOn: z
    .string()
    .refine((value) => !!parseExpiryInput(value), 'Informe uma data válida em DD/MM/AAAA.'),
  lotCode: z.string().max(100),
  note: z.string().max(1000),
});
type Fields = z.infer<typeof schema>;

/**
 * Nova entrada sem sair da tela (AV13): com o produto da página já escolhido, ou com a
 * escolha do produto. Ao confirmar, o lote novo aparece na tela de baixo.
 */
export function EntryDialog({
  open,
  product: fixed,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** Produto da página; sem ele, a janela pede o produto. */
  product?: Product | null;
  onClose: () => void;
  onSaved?: (detail: InventoryDetail) => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      {open && <EntryForm fixed={fixed ?? null} onClose={onClose} onSaved={onSaved} />}
    </Dialog>
  );
}

function EntryForm({
  fixed,
  onClose,
  onSaved,
}: {
  fixed: Product | null;
  onClose: () => void;
  onSaved?: (detail: InventoryDetail) => void;
}) {
  const [chosen, setChosen] = useState<Product | null>(null);
  const product = fixed ?? chosen;
  const inventory = useApiQuery<InventoryDetail>(`/inventory/products/${product?.id}`, {
    enabled: !!product,
  });
  const counting = useApiQuery<Page<CountSession>>(
    `/count-sessions${queryString({ status: 'COUNTING', productId: product?.id, limit: 1 })}`,
    { enabled: !!product },
  );
  const mutation = useBusinessMutation<ReceiptInput, InventoryDetail>('/inventory/receipts');
  const locked = mutation.isPending || mutation.isUncertain;
  const untracked = inventory.data?.trackingStatus === 'UNTRACKED';
  const active = counting.data?.items[0];
  const blocked = !product || !product.active || untracked || !!active;
  const {
    register,
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<Fields>({
    resolver: zodResolver(schema),
    defaultValues: { quantity: 1, expiresOn: '', lotCode: '', note: '' },
  });
  const close = () => {
    if (!locked) onClose();
  };
  return (
    <form
      noValidate
      onSubmit={handleSubmit((values) => {
        if (!product || blocked) return;
        mutation.mutate(
          {
            productId: product.id,
            quantity: values.quantity,
            expiresOn: parseExpiryInput(values.expiresOn)!,
            ...(values.lotCode.trim() ? { lotCode: values.lotCode.trim() } : {}),
            ...(values.note.trim() ? { note: values.note.trim() } : {}),
          },
          {
            onSuccess: (detail) => {
              onSaved?.(detail);
              onClose();
            },
          },
        );
      })}
    >
      <DialogTitle>Nova entrada</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Registre a mercadoria antes de pôr na gôndola.
        </Typography>
        <div className="form-stack">
          {fixed ? (
            <div className="picked-product">
              <span className="picked-text">
                <strong>{fixed.description}</strong>
                <small>{fixed.barcodes?.join(' · ') || 'Sem código de barras'}</small>
              </span>
            </div>
          ) : (
            <ProductPicker value={chosen} onChange={setChosen} disabled={locked} autoFocus />
          )}
          {product && (inventory.isPending || counting.isPending) && <Loading />}
          {product && untracked && (
            <Alert severity="info">
              Este produto ainda não tem contagem inicial. Conte o estoque dele antes de registrar
              entradas.
            </Alert>
          )}
          {product && active && (
            <Alert severity="info">
              Há uma contagem em andamento deste produto. Termine a contagem antes de registrar a
              entrada.
            </Alert>
          )}
          {product && !product.active && (
            <Alert severity="warning">O produto está inativo no catálogo.</Alert>
          )}
          <div className="record-form">
            <TextField
              disabled={locked || blocked}
              label="Quantidade em unidades"
              type="number"
              autoFocus={!!fixed}
              {...register('quantity', { valueAsNumber: true })}
              error={!!errors.quantity}
              helperText={errors.quantity?.message}
              slotProps={{ htmlInput: { min: 1, step: 1, inputMode: 'numeric' } }}
            />
            <Controller
              control={control}
              name="expiresOn"
              render={({ field }) => (
                <ExpiryDateField
                  disabled={locked || blocked}
                  label="Validade"
                  value={field.value}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  inputRef={field.ref}
                  error={!!errors.expiresOn}
                  helperText={errors.expiresOn?.message}
                />
              )}
            />
            <TextField
              disabled={locked || blocked}
              className="full"
              label="Lote (opcional)"
              {...register('lotCode')}
              error={!!errors.lotCode}
              helperText={errors.lotCode?.message}
            />
            <TextField
              disabled={locked || blocked}
              className="full"
              label="Observação (opcional)"
              multiline
              rows={2}
              {...register('note')}
            />
          </div>
          {mutation.isUncertain && (
            <Alert severity="warning">
              A resposta não foi confirmada. Os dados foram preservados: clique de novo em Confirmar
              entrada para recuperar o resultado sem duplicar a mercadoria.
            </Alert>
          )}
          {mutation.error && <Alert severity="error">{mutation.error.message}</Alert>}
        </div>
      </DialogContent>
      <DialogActions>
        <Button onClick={close} disabled={locked}>
          Voltar
        </Button>
        <Button type="submit" variant="contained" disabled={mutation.isPending || blocked}>
          {mutation.isPending ? 'Confirmando…' : 'Confirmar entrada'}
        </Button>
      </DialogActions>
    </form>
  );
}
