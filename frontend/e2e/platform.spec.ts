import { test, expect, type Page } from '@playwright/test';

// Painel da plataforma de ponta a ponta: cadastra uma loja nova (fica no banco, com nome
// "E2E Plataforma …"), e nela o proprietário entra, a loja é suspensa e reativada e o acesso do
// proprietário é devolvido por link. As lojas existentes não são tocadas.
const platformUser = process.env.E2E_PLATFORM_USERNAME ?? 'superadmin';
const platformPassword = process.env.E2E_PLATFORM_PASSWORD;
const platformNewPassword = process.env.E2E_PLATFORM_NEW_PASSWORD;
const webUrl = process.env.E2E_WEB_URL ?? 'http://localhost:5174';

/** CNPJ numérico aleatório, com dígitos verificadores válidos. */
function randomCnpj() {
  const base = Array.from({ length: 12 }, () => Math.floor(Math.random() * 10)).join('');
  const digit = (value: string) => {
    let sum = 0,
      weight = 2;
    for (let i = value.length - 1; i >= 0; i--) {
      sum += Number(value[i]) * weight;
      weight = weight === 9 ? 2 : weight + 1;
    }
    return sum % 11 < 2 ? 0 : 11 - (sum % 11);
  };
  const first = digit(base);
  return `${base}${first}${digit(`${base}${first}`)}`;
}

async function storeLogin(page: Page, cnpj: string, username: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('CNPJ da loja').fill(cnpj);
  await page.getByLabel('Usuário', { exact: true }).fill(username);
  await page.getByLabel('Senha', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Entrar no painel' }).click();
}

test('plataforma: cadastra, suspende, reativa e devolve o acesso de uma loja', async ({
  page,
  browser,
}) => {
  test.skip(
    !platformPassword,
    'Defina E2E_PLATFORM_PASSWORD (e E2E_PLATFORM_NEW_PASSWORD no primeiro acesso).',
  );
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/platform');
  await expect(page).toHaveURL(/\/platform\/login$/);
  await page.getByLabel('Usuário').fill(platformUser);
  await page.getByLabel('Senha').fill(platformPassword!);
  await page.getByRole('button', { name: 'Entrar na plataforma' }).click();
  await page.getByRole('heading', { name: /^(Lojas|Defina sua senha)$/ }).waitFor();
  if (page.url().endsWith('/platform/password')) {
    expect(
      platformNewPassword,
      'Defina E2E_PLATFORM_NEW_PASSWORD no primeiro acesso.',
    ).toBeTruthy();
    await page.getByLabel('Senha provisória').fill(platformPassword!);
    await page.getByLabel('Nova senha', { exact: true }).fill(platformNewPassword!);
    await page.getByLabel('Repita a nova senha').fill(platformNewPassword!);
    await page.getByRole('button', { name: 'Salvar senha' }).click();
    await expect(page.getByRole('heading', { name: 'Lojas' })).toBeVisible();
  }

  // Cadastro: a senha provisória aparece uma vez.
  const cnpj = randomCnpj();
  const name = `E2E Plataforma ${Date.now()}`;
  await page.getByRole('button', { name: 'Nova loja' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/Nome da loja/).fill(name);
  await dialog.getByLabel(/^CNPJ/).fill(cnpj);
  await dialog.getByLabel(/Usuário do proprietário/).fill('dono.e2e');
  await dialog.getByRole('button', { name: 'Cadastrar loja' }).click();
  const temporary = await dialog.getByLabel('Senha provisória').inputValue();
  expect(temporary).toMatch(/^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/);
  await dialog.getByRole('link', { name: 'Abrir a loja' }).click();
  await expect(page.getByRole('heading', { name: new RegExp(name) })).toBeVisible();

  // O proprietário entra com a senha provisória e define a dele.
  const storeContext = await browser.newContext({ baseURL: webUrl });
  const store = await storeContext.newPage();
  store.on('pageerror', (error) => errors.push(error.message));
  await storeLogin(store, cnpj, 'dono.e2e', temporary);
  await expect(store).toHaveURL(/\/password$/);
  const ownerPassword = 'DonoDaLojaE2E!2026';
  await store.getByLabel(/^Senha atual/).fill(temporary);
  await store.getByLabel(/^Nova senha/).fill(ownerPassword);
  await store.getByLabel(/^Confirmar nova senha/).fill(ownerPassword);
  await store.getByRole('button', { name: 'Salvar nova senha' }).click();
  await expect(store).toHaveURL(/\/login$/);
  await storeLogin(store, cnpj, 'dono.e2e', ownerPassword);
  await expect(store.getByRole('heading', { name: 'Sua loja, em dia' })).toBeVisible();

  // Suspensa: quem estava dentro sai na próxima ação, e o login é recusado.
  await page.getByRole('button', { name: 'Suspender loja' }).click();
  await page
    .getByRole('dialog')
    .getByLabel(/Motivo/)
    .fill('Teste de suspensão (e2e)');
  await page.getByRole('dialog').getByRole('button', { name: 'Suspender' }).click();
  await expect(page.getByText(/Loja suspensa: ninguém dela entra/)).toBeVisible();
  await store
    .getByRole('link', { name: /Estoque/ })
    .first()
    .click();
  await expect(store).toHaveURL(/\/login$/, { timeout: 30_000 });
  await storeLogin(store, cnpj, 'dono.e2e', ownerPassword);
  await expect(store.getByText(/Não foi possível entrar/)).toBeVisible();

  // Reativada: a sessão que ainda estava no prazo volta a valer, sem login.
  await page.getByRole('button', { name: 'Reativar loja' }).click();
  await page
    .getByRole('dialog')
    .getByLabel(/Motivo/)
    .fill('Fim do teste de suspensão (e2e)');
  await page.getByRole('dialog').getByRole('button', { name: 'Reativar' }).click();
  await expect(page.getByRole('button', { name: 'Suspender loja' })).toBeVisible();
  await store.goto('/');
  await expect(store.getByRole('heading', { name: 'Sua loja, em dia' })).toBeVisible();

  // Acesso novo: o link vale uma vez, e a senha anterior deixa de valer.
  await page.getByRole('button', { name: 'Gerar acesso' }).click();
  await page
    .getByRole('dialog')
    .getByLabel(/Motivo/)
    .fill('Proprietário perdeu a senha (e2e)');
  await page.getByRole('dialog').getByRole('button', { name: 'Gerar acesso' }).click();
  const link = await page.getByRole('dialog').getByLabel('Link para definir a senha').inputValue();
  expect(link).toContain('/reset-password#');
  await page.getByRole('dialog').getByRole('button', { name: 'Concluir' }).click();
  await storeLogin(store, cnpj, 'dono.e2e', ownerPassword);
  await expect(store.getByText(/Não foi possível entrar/)).toBeVisible();
  const recovered = 'NovaSenhaDoDonoE2E!2026';
  await store.goto(link);
  await store.getByLabel(/^Nova senha/).fill(recovered);
  await store.getByLabel(/^Confirmar nova senha/).fill(recovered);
  await store.getByRole('button', { name: 'Salvar nova senha' }).click();
  await storeLogin(store, cnpj, 'dono.e2e', recovered);
  await expect(store.getByRole('heading', { name: 'Sua loja, em dia' })).toBeVisible();

  // O histórico da plataforma registra tudo, com os motivos.
  await page.getByRole('link', { name: 'Histórico' }).click();
  // Cada execução cria uma loja: só as linhas da loja desta execução.
  const rows = page.getByRole('row').filter({ hasText: name });
  for (const text of [
    'Cadastrou a loja',
    'Motivo: Teste de suspensão (e2e)',
    'Motivo: Fim do teste de suspensão (e2e)',
    'Motivo: Proprietário perdeu a senha (e2e)',
  ])
    await expect(rows.filter({ hasText: text })).toHaveCount(1);
  await storeContext.close();
  expect(errors).toEqual([]);
});
