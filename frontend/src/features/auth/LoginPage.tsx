import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Alert, Button, CircularProgress, TextField, Typography } from '@mui/material';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { login } from '../../shared/api/session';
import { normalizeCnpj } from '../../shared/lib/format';
import { APP_NAME } from '../../shared/lib/app';
import { Wordmark } from '../../shared/ui/components';
import { useAuth } from './AuthProvider';
const schema = z.object({
  cnpj: z
    .string()
    .transform(normalizeCnpj)
    .pipe(z.string().regex(/^[A-Z0-9]{12}[0-9]{2}$/, 'Informe o CNPJ completo de 14 caracteres.')),
  username: z.string().trim().min(1, 'Informe seu usuário.'),
  password: z.string().min(1, 'Informe sua senha.'),
});
type Fields = z.input<typeof schema>;
export function LoginPage() {
  const { session, ready } = useAuth();
  const [error, setError] = useState('');
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Fields>({ resolver: zodResolver(schema) });
  if (ready && session) return <Navigate to="/" replace />;
  return (
    <main className="login-layout">
      <section className="login-story">
        <div className="wordmark" aria-label={APP_NAME}>
          <Wordmark />
        </div>
        <div>
          <span className="eyebrow light">CADA PRODUTO, NO TEMPO CERTO</span>
          <h1>
            Mais controle.
            <br />
            Menos perdas.
          </h1>
          <p>Do coletor à gestão, acompanhe o estoque e antecipe o que precisa de atenção.</p>
          <ul className="story-points">
            <li>Veja primeiro o que vence primeiro</li>
            <li>Conte o estoque com o coletor, por validade</li>
            <li>Receba todo dia o resumo por e-mail</li>
          </ul>
        </div>
        <small>CONTROLE DE ESTOQUE E VALIDADE</small>
      </section>
      <section className="login-form-area">
        <div className="login-card">
          <span className="eyebrow">PAINEL DA LOJA</span>
          <Typography variant="h4" sx={{ fontWeight: 700, mt: 1, mb: 1 }}>
            Bem-vindo de volta
          </Typography>
          <Typography color="text.secondary" sx={{ mb: 4 }}>
            Entre com o CNPJ da loja e seu acesso individual.
          </Typography>
          <form
            onSubmit={handleSubmit(async (values) => {
              setError('');
              try {
                await login(normalizeCnpj(values.cnpj), values.username.trim(), values.password);
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : 'Não foi possível entrar.');
              }
            })}
            noValidate
            className="form-stack"
          >
            {error && <Alert severity="error">{error}</Alert>}
            <TextField
              label="CNPJ da loja"
              autoComplete="organization"
              {...register('cnpj')}
              error={!!errors.cnpj}
              helperText={errors.cnpj?.message ?? 'Números e letras são aceitos.'}
              slotProps={{ htmlInput: { maxLength: 20, autoCapitalize: 'characters' } }}
            />
            <TextField
              label="Usuário"
              autoComplete="username"
              {...register('username')}
              error={!!errors.username}
              helperText={errors.username?.message}
            />
            <TextField
              label="Senha"
              type="password"
              autoComplete="current-password"
              {...register('password')}
              error={!!errors.password}
              helperText={errors.password?.message}
            />
            <Button
              type="submit"
              variant="contained"
              size="large"
              disabled={isSubmitting}
              sx={{ py: 1.6 }}
            >
              {isSubmitting ? (
                <>
                  <CircularProgress size={18} color="inherit" sx={{ mr: 1 }} />
                  Entrando…
                </>
              ) : (
                'Entrar no painel'
              )}
            </Button>
          </form>
          <p className="login-help">Precisa de acesso? Procure o responsável pela sua loja.</p>
        </div>
        <small className="login-footer">Sua loja. Sua equipe. Seu estoque.</small>
      </section>
    </main>
  );
}
