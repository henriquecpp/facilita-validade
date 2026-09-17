import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Tooltip,
  Typography,
} from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import { api } from '../../shared/api/client';
import type { DevicePairing, User } from '../../shared/api/types';
import { ErrorState } from '../../shared/ui/components';

/** Quem pode entrar no coletor por QR — a mesma regra do backend. */
export function canPair(user: User): boolean {
  return user.role === 'OPERATOR' && user.active !== false && !user.mustChangePassword;
}

/** Botão da linha do usuário: habilitado só para operadores elegíveis, com o motivo quando não. */
export function PairCollectorButton({ user, onClick }: { user: User; onClick: () => void }) {
  if (user.role !== 'OPERATOR' || user.active === false) return null;
  if (user.mustChangePassword)
    return (
      <Tooltip title="O operador precisa trocar a senha provisória antes de entrar por QR.">
        {/* Botão desabilitado não dispara eventos de mouse: o span carrega o tooltip. */}
        <span>
          <Button disabled>QR do coletor</Button>
        </span>
      </Tooltip>
    );
  return <Button onClick={onClick}>QR do coletor</Button>;
}

function remaining(expiresAt: string, now: number): number {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
}

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * Mostra o QR que o coletor lê para entrar como o operador.
 *
 * Mesmo desenho do reset de senha: a rota emite uma credencial de uso único e não
 * usa Idempotency-Key, e o código some ao fechar — não fica em estado nem em cache.
 * Um código novo é gerado ao abrir, e outro a pedido quando o anterior expira.
 */
export function PairCollectorDialog({ user, close }: { user: User; close: () => void }) {
  const issue = useMutation({
    mutationFn: () =>
      api<DevicePairing>('/device-pairings', {
        method: 'POST',
        body: JSON.stringify({ userId: user.id }),
      }),
  });
  const [now, setNow] = useState(() => Date.now());

  // Gera ao abrir. O StrictMode roda efeitos duas vezes no desenvolvimento, e cada
  // chamada emite uma credencial e uma entrada de auditoria: a ref garante uma só.
  const { mutate } = issue;
  const requested = useRef(false);
  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    mutate();
  }, [mutate]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const pairing = issue.data;
  // A contagem parte de quando o código chega, não de quando o diálogo abriu: o
  // servidor calcula a validade ao responder, e um `now` do momento da abertura
  // faria o primeiro quadro mostrar mais tempo do que existe (2:01 em vez de 2:00).
  useEffect(() => {
    if (pairing) setNow(Date.now());
  }, [pairing]);
  const seconds = pairing ? remaining(pairing.expiresAt, now) : 0;
  const expired = Boolean(pairing) && seconds === 0;

  return (
    <Dialog open onClose={close} fullWidth maxWidth="xs">
      <DialogTitle>Entrar no coletor como {user.username}</DialogTitle>
      <DialogContent>
        {issue.error ? (
          <ErrorState error={issue.error} />
        ) : !pairing ? (
          <Typography>Gerando código…</Typography>
        ) : (
          <>
            <Box
              sx={{
                display: 'flex',
                justifyContent: 'center',
                my: 2,
                // Expirado, o QR some da tela em vez de ficar legível sem valer nada.
                visibility: expired ? 'hidden' : 'visible',
              }}
              aria-hidden={expired}
            >
              <QRCodeSVG
                value={pairing.code}
                size={260}
                style={{ width: '100%', maxWidth: 260, height: 'auto' }}
                level="M"
                marginSize={2}
                title={`QR de acesso de ${user.username}`}
              />
            </Box>
            {expired ? (
              <Alert severity="warning">Este código expirou. Gere um novo.</Alert>
            ) : (
              <Typography align="center" variant="h6" aria-live="polite">
                Válido por {clock(seconds)}
              </Typography>
            )}
            <Typography variant="body2" sx={{ mt: 2 }}>
              No coletor, escolha <strong>Entrar com QR</strong> e aponte para este código. O leitor
              do aparelho também lê direto na tela de login.
            </Typography>
            <Alert severity="info" sx={{ mt: 2 }}>
              Vale uma vez só. Enquanto estiver na tela, quem fotografar este código entra como{' '}
              {user.username} — mostre apenas para o coletor.
            </Alert>
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={close}>Fechar</Button>
        {(expired || issue.error) && (
          <Button variant="contained" onClick={() => issue.mutate()} disabled={issue.isPending}>
            Gerar novo código
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
