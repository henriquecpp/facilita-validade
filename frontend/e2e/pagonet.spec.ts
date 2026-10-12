import { test, expect, type Page } from '@playwright/test';

// Contra a Pagonet de verdade: catálogo e vendas reais da loja do CNPJ informado. Altera a
// loja (liga a leitura, importa e conta), então só roda com E2E_PAGONET=1. O servidor precisa
// do token da aplicação (PAGONET_TOKEN), e a loja, do CNPJ cadastrado na Pagonet.
const enabled = process.env.E2E_PAGONET === '1';
const cnpj = process.env.E2E_CNPJ ?? '37466214000168';
const username = process.env.E2E_USERNAME ?? 'admin';
const initialPassword = process.env.E2E_PASSWORD;
const nextPassword = process.env.E2E_NEW_PASSWORD;
// DANONE IOGURTE 1250G MORANGO, um dos iogurtes mais vendidos da loja-piloto.
const barcode = process.env.E2E_PAGONET_BARCODE ?? '7891025121923';

async function login(page: Page, password: string) {
  await page.goto('/login');
  await page.getByLabel('CNPJ da loja').fill(cnpj);
  await page.getByLabel('Usuário', { exact: true }).fill(username);
  await page.getByLabel('Senha', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Entrar no painel' }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}

const inDays = (days: number) => {
  const date = new Date(Date.now() + days * 86_400_000);
  return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
};

test('Pagonet real: catálogo, vendas, leitura de código e contagem', async ({ page }) => {
  test.skip(
    !enabled || !initialPassword,
    'Defina E2E_PAGONET=1 e E2E_PASSWORD; o servidor precisa de PAGONET_TOKEN.',
  );
  // A primeira leitura traz o catálogo inteiro da loja (dezenas de milhares de produtos).
  test.setTimeout(1_200_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page, initialPassword!);
  // O redirecionamento para a troca de senha acontece depois de carregar o usuário.
  await page.getByRole('heading', { name: /Sua loja, em dia|Trocar senha/ }).waitFor();
  if (page.url().endsWith('/password')) {
    expect(nextPassword, 'Defina E2E_NEW_PASSWORD para o primeiro acesso.').toBeTruthy();
    await page.getByLabel(/^Senha atual/).fill(initialPassword!);
    await page.getByLabel(/^Nova senha/).fill(nextPassword!);
    await page.getByLabel(/^Confirmar nova senha/).fill(nextPassword!);
    await page.getByRole('button', { name: 'Salvar nova senha' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await login(page, nextPassword!);
  }

  await page.getByRole('link', { name: 'Importações', exact: true }).click();
  // Pelo título: o nome também aparece na conexão listada em "Integração por API".
  const section = page.locator('section').filter({
    has: page.getByRole('heading', { name: 'Pagonet — Facilita Validade' }),
  });
  // Configurada, a seção mostra a situação e o botão Alterar; senão, já vem o formulário.
  await section
    .getByText(/Catálogo:|Ler catálogo e vendas/)
    .first()
    .waitFor();
  if (await section.getByRole('button', { name: 'Alterar' }).isVisible())
    await section.getByRole('button', { name: 'Alterar' }).click();
  // Token e CNPJ não se digitam: o token é da aplicação, e o CNPJ, o da própria loja.
  await expect(section.getByText(/usa o CNPJ da loja/)).toBeVisible();
  await expect(section.getByLabel(/Token/)).toHaveCount(0);
  await section.getByRole('checkbox', { name: /Ler catálogo e vendas/ }).check();
  await section.getByRole('button', { name: 'Salvar' }).click();
  await expect(section.getByText(/CNPJ da loja: \d{2}\.\d{3}\.\d{3}/)).toBeVisible();

  // O worker lê o catálogo inteiro na volta seguinte (até um minuto) e as vendas logo depois.
  const shows = async (text: RegExp) => {
    await page.reload();
    await section.getByText(/Catálogo:/).waitFor({ timeout: 30_000 });
    return section.getByText(text).isVisible();
  };
  await expect
    .poll(() => shows(/\d+ produtos, lido em/), { timeout: 600_000, intervals: [10_000] })
    .toBeTruthy();
  await expect
    .poll(() => shows(/Vendas: até \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/), {
      timeout: 360_000,
      intervals: [10_000],
    })
    .toBeTruthy();
  // O catálogo grava direto nos produtos, sem lote de importação; as vendas só entram para
  // produtos já contados, então uma loja sem contagem não tem lote de vendas para mostrar.

  // Produto real, achado no módulo Produtos pelo código de barras que está na embalagem.
  await page.getByRole('link', { name: 'Produtos', exact: true }).click();
  await page.getByLabel('Buscar produto').fill(barcode);
  await page
    .getByRole('link', { name: /IOGURTE/ })
    .first()
    .click();
  // Primeira vez é a contagem inicial; já controlado, é uma recontagem.
  await page.getByRole('button', { name: /^(Contagem inicial|Contar estoque)$/ }).click();
  await page.getByRole('button', { name: 'Iniciar contagem', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Lotes e validades encontrados' })).toBeVisible();
  const lines: [number, string][] = [
    [6, inDays(3)],
    [24, inDays(25)],
  ];
  for (const [index, [quantity, date]] of lines.entries()) {
    await page.getByRole('button', { name: '+ Adicionar validade' }).click();
    await page.getByLabel(`Validade ${index + 1}`, { exact: true }).fill(date);
    await page.getByLabel('Quantidade', { exact: true }).nth(index).fill(String(quantity));
  }
  await page.getByRole('button', { name: 'Salvar quantidades' }).click();
  await expect(page.getByRole('button', { name: 'Salvar quantidades' })).toBeDisabled();
  await page.getByLabel(/Conferi todos os lotes/).check();
  await page.getByRole('button', { name: 'Confirmar contagem completa' }).click();
  await expect(page).toHaveURL(/\/products\/[a-f0-9-]+$/);
  await expect(page.getByText('30 unidades', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/pagonet-produto.png', fullPage: true });
  expect(errors).toEqual([]);
});
