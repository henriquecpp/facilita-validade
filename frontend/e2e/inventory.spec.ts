import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
const apiUrl = process.env.E2E_API_URL ?? 'http://127.0.0.1:3001';
const initialPassword = process.env.E2E_PASSWORD;
const username = process.env.E2E_USERNAME ?? 'admin';
const cnpj = process.env.E2E_CNPJ ?? '11222333000181';
const nextPassword = process.env.E2E_NEW_PASSWORD;
async function login(page: Page, password: string) {
  await page.goto('/login');
  await page.getByLabel('CNPJ da loja').fill(cnpj);
  await page.getByLabel('Usuário', { exact: true }).fill(username);
  await page.getByLabel('Senha', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Entrar no painel' }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}
/** Data relativa a hoje, como o painel espera (DD/MM/AAAA): o teste não envelhece. */
const inDays = (days: number) => {
  const date = new Date(Date.now() + days * 86_400_000);
  return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
};
async function batch(
  request: APIRequestContext,
  key: string,
  kind: 'catalog' | 'movement',
  data: object,
) {
  const headers = { Authorization: `Bearer ${key}` };
  const response = await request.post(`${apiUrl}/api/v1/integrations/${kind}-batches`, {
    headers,
    data,
  });
  expect(response.status(), await response.text()).toBe(202);
  const result = await response.json();
  const id = result.id ?? result.batchId;
  expect(id).toBeTruthy();
  await expect
    .poll(
      async () => {
        const status = await request.get(`${apiUrl}/api/v1/integrations/batches/${id}`, {
          headers,
        });
        const payload = await status.json();
        return payload.status;
      },
      { timeout: 30000, intervals: [100, 500, 1000] },
    )
    .toMatch(/^COMPLETED/);
}
async function count(page: Page, quantities: number[], lots: string[], dates: string[]) {
  // A contagem abre pela página do produto; abrir já a inicia, sem etapa de preparo.
  await page.getByRole('button', { name: 'Iniciar contagem', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Lotes e validades encontrados' })).toBeVisible();
  for (let index = 0; index < quantities.length; index++) {
    await page.getByRole('button', { name: '+ Adicionar validade' }).click();
    await page.getByLabel(`Validade ${index + 1}`, { exact: true }).fill(dates[index]!);
    await page.getByLabel('Quantidade', { exact: true }).nth(index).fill(String(quantities[index]));
    await page.getByLabel('Lote (opcional)', { exact: true }).nth(index).fill(lots[index]!);
  }
  await page.getByRole('button', { name: 'Salvar quantidades' }).click();
  await expect(page.getByRole('button', { name: 'Salvar quantidades' })).toBeDisabled();
  await page.getByLabel(/Conferi todos os lotes/).check();
  await page.getByRole('button', { name: 'Confirmar contagem completa' }).click();
  await expect(page).toHaveURL(/\/products\/[a-f0-9-]+$/);
}

test('fluxo real: login, ERP, contagem, FEFO, classificação e repetição após resposta perdida', async ({
  page,
  request,
}) => {
  test.skip(!initialPassword, 'Defina E2E_PASSWORD para executar contra uma API e banco locais.');
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
  await expect(page.getByRole('heading', { name: 'Sua loja, em dia' })).toBeVisible();
  const suffix = `${Date.now()}`;
  const productName = `Iogurte E2E ${suffix}`;
  const barcode = `789${suffix}`;
  const externalProductId = `E2E-${suffix}`;
  await page.getByRole('link', { name: 'Importações', exact: true }).click();
  await page.getByRole('button', { name: '+ Nova conexão' }).click();
  await page.getByLabel('Nome da conexão').fill(`E2E ${suffix}`);
  await page.getByRole('button', { name: 'Criar conexão' }).click();
  const connection = page.locator('.connection-row').filter({ hasText: `E2E ${suffix}` });
  await connection.getByRole('button', { name: 'Gerar chave' }).click();
  const key = await page.getByLabel('Chave', { exact: true }).inputValue();
  expect(key.length).toBeGreaterThan(10);
  await page.getByRole('button', { name: 'Já copiei, fechar' }).click();
  await batch(request, key, 'catalog', {
    externalBatchId: `catalog-${suffix}`,
    products: [{ externalProductId, description: productName, barcodes: [barcode], active: true }],
  });
  // Módulo Produtos (AV14): busca pelo código, abre o produto e faz a contagem inicial ali.
  await page.getByRole('link', { name: 'Produtos', exact: true }).click();
  await page.getByLabel('Buscar produto').fill(barcode);
  await page.getByRole('link', { name: productName }).click();
  await page.getByRole('button', { name: 'Contagem inicial', exact: true }).click();
  await count(page, [5, 7], ['A', 'B'], [inDays(3), inDays(18)]);
  const productUrl = page.url();
  await expect(page.getByText('12 unidades', { exact: true })).toBeVisible();
  const saleTime = new Date().toISOString();
  await batch(request, key, 'movement', {
    externalBatchId: `sale-${suffix}`,
    events: [
      {
        externalEventId: `sale-${suffix}`,
        externalProductId,
        type: 'SALE',
        quantity: 6,
        occurredAt: saleTime,
      },
    ],
  });
  await page.reload();
  await expect
    .poll(
      async () => {
        await page.getByRole('button', { name: 'Atualizar', exact: true }).click();
        return page.getByText('6 unidades', { exact: true }).isVisible();
      },
      { timeout: 30000, intervals: [500, 1000] },
    )
    .toBeTruthy();
  // O lote A, zerado pela venda, sai dos ativos e vai para o histórico (AV10).
  const history = page.locator('section').filter({ hasText: 'Histórico de lotes' });
  await expect(
    history
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: 'A', exact: true }) })
      .getByText('Baixado automático'),
  ).toBeVisible();
  await expect(
    page
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: 'B', exact: true }) })
      .getByRole('cell', { name: '6', exact: true })
      .first(),
  ).toBeVisible();
  await batch(request, key, 'movement', {
    externalBatchId: `scrap-${suffix}`,
    events: [
      {
        externalEventId: `scrap-${suffix}`,
        externalProductId,
        type: 'SCRAP',
        quantity: 1,
        occurredAt: new Date().toISOString(),
      },
    ],
  });
  // Divergências saiu do menu (AV15), mas a tela continua no endereço.
  await page.goto('/issues');
  await expect
    .poll(
      async () => {
        await page.getByRole('button', { name: 'Atualizar', exact: true }).click();
        return page
          .getByRole('row')
          .filter({ hasText: productName })
          .getByRole('button', { name: 'Identificar lote' })
          .isVisible();
      },
      { timeout: 30000, intervals: [500, 1000] },
    )
    .toBeTruthy();
  await page
    .getByRole('row')
    .filter({ hasText: productName })
    .getByRole('button', { name: 'Identificar lote' })
    .click();
  await page.getByRole('combobox', { name: 'Lote que foi descartado' }).click();
  await page.getByRole('option', { name: /Lote B/ }).click();
  await page
    .getByLabel('Motivo e conferência realizada')
    .fill('Conferência física do descarte no teste local.');
  await page.getByRole('button', { name: 'Confirmar classificação' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.goto(productUrl);
  await expect(page.getByText('5 unidades', { exact: true })).toBeVisible();
  // Baixa manual de um lote (AV05), separada das vendas.
  await page.getByRole('button', { name: 'Dar baixa' }).first().click();
  await page.getByLabel('Quantidade a baixar').fill('1');
  await page.getByLabel('Motivo (opcional)').fill('Embalagem danificada');
  await page.getByRole('button', { name: 'Dar baixa de 1 unidade' }).click();
  await expect(page.getByText('4 unidades', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Contar estoque', exact: true }).click();
  await count(page, [4], ['B'], [inDays(18)]);
  await expect(page.getByText('4 unidades', { exact: true })).toBeVisible();
  // Nova entrada em modal (AV13): o lote novo aparece na página de baixo.
  await page.getByRole('button', { name: 'Nova entrada', exact: true }).click();
  await page.getByLabel('Quantidade em unidades').fill('2');
  await page.getByLabel('Validade', { exact: true }).fill('31/04/2027');
  await page.getByLabel('Lote (opcional)').fill('C');
  await page.getByRole('button', { name: 'Confirmar entrada' }).click();
  await expect(page.getByText('Informe uma data válida em DD/MM/AAAA.')).toBeVisible();
  // Teclado do coletor: só números, a máscara completa a data.
  await page.getByLabel('Validade', { exact: true }).clear();
  await page
    .getByLabel('Validade', { exact: true })
    .pressSequentially(inDays(8).replaceAll('/', ''));
  await expect(page.getByLabel('Validade', { exact: true })).toHaveValue(inDays(8));
  const keys: string[] = [];
  let dropped = false;
  await page.route('**/api/v1/inventory/receipts', async (route) => {
    keys.push(route.request().headers()['idempotency-key']!);
    if (!dropped) {
      dropped = true;
      const result = await route.fetch();
      expect(result.ok(), await result.text()).toBeTruthy();
      await route.abort('failed');
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'Confirmar entrada' }).click();
  await expect(page.getByText(/clique de novo em Confirmar entrada/)).toBeVisible();
  await expect(page.getByLabel('Quantidade em unidades')).toHaveValue('2');
  await expect(page.getByLabel('Quantidade em unidades')).toBeDisabled();
  await page.getByRole('button', { name: 'Confirmar entrada' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page).toHaveURL(productUrl);
  await expect(page.getByText('6 unidades', { exact: true })).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  await page.unroute('**/api/v1/inventory/receipts');
  await page.screenshot({ path: 'test-results/estoque-validado.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Abrir menu' })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  await page.screenshot({ path: 'test-results/estoque-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Sair', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(errors).toEqual([]);
});
