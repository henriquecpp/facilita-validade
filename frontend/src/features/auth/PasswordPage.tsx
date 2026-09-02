import { useState } from 'react';
import { Alert, Button, TextField } from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import { api } from '../../shared/api/client';
import { setSession } from '../../shared/api/session';
import { PageTitle } from '../../shared/ui/components';
export function PasswordPage() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const mismatch = !!confirmation && confirmation !== newPassword;
  const mutation = useMutation({
    mutationFn: () =>
      api('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      }),
    onSuccess: () => setSession(null),
  });
  return (
    <>
      <PageTitle
        title="Trocar senha"
        description="Depois da troca, todos os seus acessos são encerrados e você entra de novo com a nova senha."
      />
      <section className="surface narrow">
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (!mismatch) mutation.mutate();
          }}
        >
          {mutation.error && <Alert severity="error">{mutation.error.message}</Alert>}
          <TextField
            label="Senha atual"
            type="password"
            required
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
          <TextField
            label="Nova senha"
            type="password"
            required
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            helperText="Pelo menos 12 caracteres. Uma frase curta é fácil de lembrar."
            slotProps={{ htmlInput: { minLength: 12, maxLength: 128 } }}
          />
          <TextField
            label="Confirmar nova senha"
            type="password"
            required
            autoComplete="new-password"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            error={mismatch}
            helperText={
              mismatch ? 'As senhas precisam ser iguais.' : 'Digite a nova senha de novo.'
            }
          />
          <Button
            type="submit"
            variant="contained"
            size="large"
            disabled={mutation.isPending || newPassword.length < 12 || confirmation !== newPassword}
          >
            Salvar nova senha
          </Button>
        </form>
      </section>
    </>
  );
}
