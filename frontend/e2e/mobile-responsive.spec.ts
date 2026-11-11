import { test, expect, type Page } from '@playwright/test';

// Dados sintéticos extensos exercitam o layout sem acessar credenciais ou uma loja real.
const productName = 'Café especial torrado em grãos da fazenda com embalagem econômica de 1 kg';
const storeName = 'Supermercado de demonstração da unidade central com nome extenso';
const actor = 'operador_da_unidade_central_com_nome_extenso';
const note = 'Conferido na prateleira e separado para reposição. Referência: ' + 'A'.repeat(60);
const lotCode = 'LOTE' + '1234567890'.repeat(5);
const at = '2026-10-19T12:00:00Z';
const product = {
  id: 'produto',
  description: productName,
  active: true,
  barcodes: ['7891234567890'],
  photoUrl: null,
};
const levels = [
  {
    id: 'retirar',
    name: 'Retirar da venda e conferir com a equipe',
    minDays: null,
    maxDays: -1,
    notify: true,
    color: '#c62828',
  },
  { id: 'priorizar', name: 'Priorizar', minDays: 0, maxDays: 3, notify: true, color: '#ef6c00' },
  { id: 'planejar', name: 'Planejar', minDays: 4, maxDays: null, notify: false, color: '#2e7d32' },
];
const lot = {
  id: 'lote',
  expiresOn: '2026-10-18',
  quantity: 15,
  lotCode,
  note,
  version: 1,
  origin: 'APP_RECEIPT',
  launchedQuantity: 25,
  soldQuantity: 8,
  writtenOffQuantity: 2,
  status: 'AUTOMATIC',
  launchedAt: at,
  launchedBy: actor,
  daysToExpiry: -1,
  levelId: 'retirar',
  levelName: levels[0]!.name,
  levelColor: levels[0]!.color,
};
const levelSummary = levels.map(({ id, ...level }) => ({
  ...level,
  levelId: id,
  lots: 12345,
  units: 45678,
  value: 99999999.99,
}));
const list = (items: unknown[]) => ({ items, nextCursor: null });

async function mockApp(page: Page) {
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
    let body: unknown;
    switch (path) {
      case '/auth/web/refresh':
        body = {
          accessToken: 'synthetic-test',
          mustChangePassword: false,
          store: { id: 'loja', name: storeName, cnpj: '11222333000181' },
          user: { id: 'dono', username: actor, role: 'OWNER' },
        };
        break;
      case '/store/settings':
        body = {
          version: 1,
          timezone: 'America/Sao_Paulo',
          alertEmails: ['operador@exemplo.com'],
          digestHour: 7,
        };
        break;
      case '/store/expiry-levels':
        body = { version: 1, items: levels };
        break;
      case '/push/config':
        body = { allowed: true, webPushPublicKey: null };
        break;
      case '/push/preferences':
        body = {
          version: 1,
          dailyDigestEnabled: true,
          depletedEnabled: true,
          levels: levels.map((l) => ({
            levelId: l.id,
            immediate: true,
            intervalHours: null,
            dailyTime: null,
          })),
        };
        break;
      case '/dashboard/summary':
        body = {
          expiredRecords: 12345,
          atRiskRecords: 24690,
          trackedProducts: 98765,
          stockValue: 99999999.99,
          expiredValue: 99999.99,
          expiringValue: 123456.78,
          unpricedLots: 2,
          unreadNotifications: 1,
          pendingImports: 0,
          openIssues: 0,
          lastImportAt: at,
          salesThroughAt: at,
          salesDelayed: false,
          levels: levelSummary,
          upcomingWeeks: Array.from({ length: 6 }, (_, i) => ({
            fromDays: i * 7,
            toDays: i * 7 + 6,
            lots: 1234,
            units: 99999,
            value: 999999.99,
          })),
        };
        break;
      case '/inventory/expiries/summary':
        body = list(levelSummary);
        break;
      case '/inventory/expiries':
        body = list([{ ...lot, productId: product.id, productName, barcode: product.barcodes[0] }]);
        break;
      case '/products':
        body = list([product]);
        break;
      case '/products/categories':
        body = list([{ code: 'Bebidas e alimentos especiais', products: 1 }]);
        break;
      case '/products/produto':
        body = product;
        break;
      case '/inventory':
        body = list([
          {
            productId: product.id,
            productName,
            barcode: product.barcodes[0],
            trackingStatus: 'TRACKED',
            estimatedQuantity: 15,
            nearestExpiry: lot.expiresOn,
            stale: false,
            category: 'Bebidas e alimentos especiais',
            salePrice: 123.45,
          },
        ]);
        break;
      case '/inventory/products/produto':
        body = {
          product,
          trackingStatus: 'TRACKED',
          lastCountAt: at,
          projectedAt: at,
          inputRevision: 1,
          appliedInputRevision: 1,
          projectionRevision: 1,
          stale: false,
          countWindowQuantity: 25,
          records: [lot],
          totalQuantity: 15,
        };
        break;
      case '/inventory/products/produto/closed-records':
        body = list([{ ...lot, id: 'encerrado', quantity: 0, soldQuantity: 23 }]);
        break;
      case '/inventory/products/produto/history':
        body = list([
          {
            id: 'movimento',
            type: 'MANUAL_WRITE_OFF',
            quantity: 2,
            allocatedQuantity: 2,
            occurredAt: at,
            reason: note,
            actorName: actor,
          },
        ]);
        break;
      case '/count-sessions/encerrada':
      case '/count-sessions/aberta':
        body = {
          id: path.endsWith('aberta') ? 'aberta' : 'encerrada',
          productId: product.id,
          status: path.endsWith('aberta') ? 'COUNTING' : 'CONFIRMED',
          version: 1,
          productName,
          startedAt: at,
          createdAt: at,
          lines: [{ id: 'linha', expiresOn: lot.expiresOn, quantity: 15, lotCode, note }],
        };
        break;
      case '/notifications':
        body = list([
          {
            id: 'aviso',
            title: 'Lotes próximos ao vencimento precisam ser conferidos',
            type: 'EXPIRY',
            createdAt: at,
            message: note,
            productId: product.id,
            productName,
            levelId: levels[0]!.id,
            levelName: levels[0]!.name,
            levelColor: levels[0]!.color,
            expiresOn: lot.expiresOn,
            quantity: 15,
            readAt: null,
          },
        ]);
        break;
      case '/users':
        body = list([
          { id: 'dono', username: actor, role: 'OWNER', active: true, createdAt: at },
          {
            id: 'operador',
            username: 'operador_teste',
            role: 'OPERATOR',
            active: true,
            mustChangePassword: false,
            createdAt: at,
          },
        ]);
        break;
      case '/device-pairings':
        body = {
          code: 'codigo-sintetico-sem-validade-real',
          expiresAt: new Date(Date.now() + 120000).toISOString(),
        };
        break;
      case '/audit-events':
        body = list([
          {
            id: 'evento',
            actorId: 'dono',
            action: 'count.confirmed',
            entityId: 'encerrada',
            createdAt: at,
            details: { productName, quantity: 15 },
          },
        ]);
        break;
      case '/imports':
        body = list([
          {
            id: 'importacao',
            externalBatchId: 'importacao-sintetica-' + '1234567890'.repeat(5),
            type: 'SALES',
            status: 'PROCESSED',
            receivedAt: at,
            createdAt: at,
            processedCount: 12345,
            eventCount: 12345,
          },
        ]);
        break;
      case '/pagonet-source':
        body = {
          configured: true,
          available: true,
          active: true,
          cnpj: '11222333000181',
          catalogSyncedAt: at,
          catalogProducts: 12345,
          salesSyncedAt: at,
          salesThrough: at,
          salesDelayed: false,
        };
        break;
      case '/platform/me':
        body = { id: 'admin', username: actor, mustChangePassword: false };
        break;
      case '/platform/pagonet':
        body = { configured: true };
        break;
      case '/platform/stores':
        body = list([
          {
            id: 'loja',
            name: storeName,
            cnpj: '11222333000181',
            timezone: 'America/Sao_Paulo',
            active: true,
            createdAt: at,
            activeUsers: 12,
            owners: [actor],
            pagonet: { active: true, salesThrough: at, lastError: null },
            lastImportAt: at,
          },
        ]);
        break;
      default:
        body = list([]);
    }
    await route.fulfill({ json: body });
  });
}

async function fits(page: Page) {
  const overflow = await page.evaluate(() => {
    const result: string[] = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) {
      result.push(`página ${document.documentElement.scrollWidth}/${innerWidth}`);
      for (const el of document.querySelectorAll<HTMLElement>('body *')) {
        const rect = el.getBoundingClientRect();
        if (
          rect.width &&
          (rect.right > innerWidth + 1 ||
            (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === 'visible'))
        )
          result.push(
            `fora: ${el.tagName}.${el.className} (${Math.round(rect.right)}, conteúdo ${el.scrollWidth}/${el.clientWidth})`,
          );
      }
    }
    // Detecta conteúdo cortado dentro dos cartões, além da rolagem horizontal da página.
    for (const el of document.querySelectorAll<HTMLElement>(
      '.metric-card, .chart-card, .level-row, .count-line, .notification-body, .source-status, .responsive-table td, .MuiDialog-paper',
    )) {
      if (el.getBoundingClientRect().width && el.scrollWidth > el.clientWidth + 1)
        result.push(`${el.className}: ${el.scrollWidth}/${el.clientWidth}`);
    }
    return result;
  });
  expect(overflow).toEqual([]);
}

for (const width of [320, 390, 768, 901, 1280]) {
  test(`telas com conteúdo e textos extensos cabem em ${width}px`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 844 });
    await mockApp(page);
    for (const [path, ready] of [
      ['/', '.chart-legend li'],
      ['/products', '.product-name'],
      ['/products/produto', '.lots-table tbody tr'],
      ['/products/produto/movements?recordId=lote', '.responsive-table tbody tr'],
      ['/expiries?nivel=retirar', '.expiry-row'],
      ['/counts/encerrada', '.responsive-table tbody tr'],
      ['/counts/aberta', '.count-line'],
      ['/alerts', '.notification-row'],
      ['/imports', '.source-status'],
      ['/audit', '.responsive-table tbody tr'],
      ['/users', '.responsive-table tbody tr'],
      ['/settings', '.level-row'],
      ['/platform', '.responsive-table tbody tr'],
    ]) {
      await test.step(path!, async () => {
        await page.goto(path!);
        await expect(page.locator(ready!).first()).toBeVisible();
        await fits(page);
        if (path === '/products/produto') {
          const activeLots = page.locator('.lots-table').first();
          await expect(activeLots.locator('td[data-label="Baixa manual"]')).toHaveText('2');
          await expect(activeLots.getByText(note, { exact: true })).toBeVisible();
          await expect(
            activeLots.getByRole('button', { name: 'Dar baixa', exact: true }),
          ).toBeEnabled();
        }
        if (path === '/counts/encerrada')
          await expect(page.getByText(note, { exact: true })).toBeVisible();
        if (
          width === 320 &&
          ['/', '/products/produto', '/counts/aberta', '/settings'].includes(path!)
        ) {
          await page.screenshot({
            path: testInfo.outputPath(`${path!.replaceAll('/', '_') || 'inicio'}.png`),
            fullPage: true,
          });
        }
      });
    }
    expect(errors).toEqual([]);
  });
}

test('menu mobile abre pelo botão, fecha de todas as formas e não vaza foco ou rolagem', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApp(page);
  await page.goto('/');
  const trigger = page.locator('button[aria-controls="store-mobile-menu"]');
  const drawer = page.getByRole('dialog', { name: 'Menu principal' });
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('navigation', { name: 'Navegação principal' })).not.toBeVisible();
  await trigger.click();
  await expect(drawer).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
  await expect(drawer.getByRole('button', { name: 'Fechar menu' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  expect(await drawer.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Tab');
  expect(await drawer.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('menu-390.png') });
  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
  await trigger.click();
  await drawer.getByRole('button', { name: 'Fechar menu' }).click();
  await expect(drawer).not.toBeVisible();
  await trigger.click();
  await page.mouse.click(380, 400);
  await expect(drawer).not.toBeVisible();
  await trigger.click();
  await drawer.getByRole('link', { name: 'Início', exact: true }).click();
  await expect(drawer).not.toBeVisible();
  await trigger.click();
  await drawer.getByRole('link', { name: 'Produtos', exact: true }).click();
  await expect(page).toHaveURL(/\/products$/);
  await expect(drawer).not.toBeVisible();
  await trigger.click();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(drawer).not.toBeVisible();
  await expect(page.locator('.sidebar')).toBeVisible();
  await expect(trigger).not.toBeVisible();
  await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
  await fits(page);
  await page.setViewportSize({ width: 900, height: 700 });
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.sidebar')).not.toBeVisible();
});

test('diálogos de entrada, baixa e notificações cabem em 320px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await mockApp(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Nova entrada', exact: true }).click();
  await page.getByLabel('Produto', { exact: true }).fill('café');
  await page.getByRole('button', { name: new RegExp(productName) }).click();
  await expect(page.getByLabel('Quantidade em unidades')).toBeEnabled();
  await fits(page);
  await page.getByRole('button', { name: 'Voltar', exact: true }).click();
  await page.goto('/products/produto');
  await page.getByRole('button', { name: 'Dar baixa', exact: true }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await fits(page);
  await page.keyboard.press('Escape');
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Notificações do nível Priorizar' }).click();
  await page.getByLabel('Repetir enquanto houver lotes neste nível').check();
  await page.getByLabel('Avisar diariamente neste horário').check();
  await fits(page);
});

test('plataforma usa o mesmo menu recolhido no celular', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await mockApp(page);
  await page.goto('/platform');
  await expect(page.getByRole('navigation', { name: 'Plataforma' })).not.toBeVisible();
  await page.getByRole('button', { name: 'Abrir menu' }).click();
  const drawer = page.getByRole('dialog', { name: 'Menu da plataforma' });
  await expect(drawer).toBeVisible();
  await drawer.getByRole('link', { name: 'Histórico' }).click();
  await expect(page).toHaveURL(/\/platform\/history$/);
  await expect(drawer).not.toBeVisible();
  await page.getByRole('button', { name: 'Abrir menu' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Abrir menu' })).toBeFocused();
});

test('QR do coletor e cadastro de loja aproveitam a largura do celular', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await mockApp(page);
  await page.goto('/users');
  await page.getByRole('button', { name: 'QR do coletor', exact: true }).click();
  await expect(page.getByText('Válido por', { exact: false })).toBeVisible();
  await expect(page.getByRole('dialog').locator('svg').first()).toBeVisible();
  await fits(page);
  await page.getByRole('button', { name: 'Fechar', exact: true }).click();
  await page.goto('/platform');
  await page.getByRole('button', { name: 'Nova loja', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await fits(page);
});
