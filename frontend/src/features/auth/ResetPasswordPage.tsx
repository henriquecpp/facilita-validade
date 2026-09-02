import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, TextField, Typography } from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import { api } from '../../shared/api/client';

export function ResetPasswordPage() {
  const [token] = useState(() => {
    try {
      return decodeURIComponent(window.location.hash.slice(1));
    } catch {
      return '';
    }
  });
  useEffect(() => {
    window.history.replaceState(null, '', window.location.pathname);
  }, []);
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const mutation = useMutation({
    mutationFn: () =>
      api(
        '/auth/complete-password-reset',
        { method: 'POST', body: JSON.stringify({ token, newPassword }) },
        false,
      ),
  });
  return (
    <main className="login-form-area" style={{ minHeight: '100vh' }}>
      <section className="login-card">
        <Typography variant="h4" component="h1" sx={{ mb: 2 }}>
          Definir nova senha
        </Typography>
        {!token ? (
          <Alert severity="error">
            O link está incompleto. Peça um novo link ao responsável pela loja.
          </Alert>
        ) : mutation.isSuccess ? (
          <Alert severity="success">
            Sua senha foi redefinida. Entre com o CNPJ da loja e a nova senha.
          </Alert>
        ) : (
          <form
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              if (newPassword.length >= 12 && newPassword === confirmation) mutation.mutate();
            }}
          >
            <Typography color="text.secondary">
              Use pelo menos 12 caracteres para proteger seu acesso.
            </Typography>
            {mutation.error && <Alert severity="error">{mutation.error.message}</Alert>}
            <TextField
              label="Nova senha"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              required
              slotProps={{ htmlInput: { minLength: 12, maxLength: 128 } }}
            />
            <TextField
              label="Confirmar nova senha"
              type="password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              required
              error={!!confirmation && confirmation !== newPassword}
              helperText={
                confirmation && confirmation !== newPassword
                  ? 'As senhas precisam ser iguais.'
                  : undefined
              }
            />
            <Button
              type="submit"
              variant="contained"
              disabled={
                mutation.isPending || newPassword.length < 12 || newPassword !== confirmation
              }
            >
              Salvar nova senha
            </Button>
          </form>
        )}
        <Button component={Link} to="/login" sx={{ mt: 3 }}>
          Voltar para o login
        </Button>
      </section>
    </main>
  );
}
