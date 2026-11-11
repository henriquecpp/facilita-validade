import { test, expect, type Page } from '@playwright/test';
import type {
  PushPreferences,
  PushPreferencesInput,
} from '../src/features/administration/push-preferences';

// Navegador real com respostas sintéticas: não acessa lojas, credenciais ou dados de produção.
const product = {
  id: 'produto',
  description: 'Café de teste',
  active: true,
  barcodes: ['1234'],
  photoUrl: null,
};
const levels = [
  { id: 'retirar', name: 'Retirar', minDays: null, maxDays: -1, notify: true, color: '#c62828' },
  { id: 'priorizar', name: 'Priorizar', minDays: 0, maxDays: 3, notify: true, color: '#ef6c00' },
  { id: 'planejar', name: 'Planejar', minDays: 4, maxDays: null, notify: false, color: '#2e7d32' },
];

async function mockStore(page: Page) {
  let preferences: PushPreferences = {
    version: 1,
    dailyDigestEnabled: true,
    depletedEnabled: true,
    levels: levels.map((level) => ({
      levelId: level.id,
      immediate: true,
      intervalHours: null,
      dailyTime: null,
    })),
  };
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
    let body: unknown;
    switch (path) {
      case '/auth/web/refresh':
        body = {
          accessToken: 'test',
          mustChangePassword: false,
          store: { id: 'loja', name: 'Loja de teste', cnpj: '11222333000181' },
          user: { id: 'dono', username: 'Dono', role: 'OWNER' },
        };
        break;
      case '/store/settings':
        body = { version: 1, timezone: 'America/Sao_Paulo', alertEmails: [], digestHour: 7 };
        break;
      case '/store/expiry-levels':
        body = { version: 1, items: levels };
        break;
      case '/push/config':
        body = { allowed: true, webPushPublicKey: null };
        break;
      case '/push/preferences':
        if (route.request().method() === 'PUT') {
          const { expectedVersion, ...next } = route
            .request()
            .postDataJSON() as PushPreferencesInput;
          preferences = { ...next, version: expectedVersion + 1 };
        }
        body = preferences;
        break;
      case '/dashboard/summary':
        body = {
          expiredRecords: 0,
          atRiskRecords: 0,
          trackedProducts: 1,
          stockValue: 0,
          unpricedLots: 0,
          unreadNotifications: 0,
          pendingImports: 0,
          levels: [],
          upcomingWeeks: [],
          salesDelayed: false,
        };
        break;
      case '/inventory/expiries/summary':
        body = {
          items: levels.map(({ id, ...level }) => ({
            ...level,
            levelId: id,
            lots: 0,
            units: 0,
            value: 0,
          })),
        };
        break;
      case '/products':
        body = { items: [product], nextCursor: null };
        break;
      case '/products/produto':
        body = product;
        break;
      case '/inventory/products/produto':
        body = {
          product,
          trackingStatus: 'TRACKED',
          estimatedQuantity: 0,
          records: [],
          stale: false,
        };
        break;
      default:
        body = { items: [], nextCursor: null };
    }
    await route.fulfill({ json: body });
  });
}

test('painel no celular: menu recolhido e card usa nível cadastrado mesmo vazio', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockStore(page);
  await page.goto('/');
  const menu = page.locator('button[aria-controls="store-mobile-menu"]');
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  const card = page.locator('a').filter({ hasText: /^A vencer/ });
  await expect(card).toHaveAttribute('href', '/expiries?nivel=priorizar');
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('link', { name: 'Produtos', exact: true }).click();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await page.goto('/');
  await card.click();
  await expect(page.getByRole('tab', { name: /Priorizar/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('painel: seleção de produto e explicação de Controlado com saldo zero', async ({ page }) => {
  await mockStore(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Nova entrada', exact: true }).click();
  await page.getByLabel('Produto', { exact: true }).fill('café');
  await page.getByRole('button', { name: /Café de teste/ }).click();
  await expect(page.getByRole('dialog')).toContainText('Café de teste');
  await expect(page.getByLabel('Quantidade em unidades')).toBeEnabled();
  await page.getByRole('button', { name: 'Voltar', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/products/produto');
  await page.getByRole('button', { name: 'Controlado: entender esta situação' }).click();
  await expect(page.getByRole('tooltip')).toContainText('saldo chega a zero');
});

test('configurações no celular: combina frequências pelo sino e preserva as outras escolhas', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockStore(page);
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Notificações do nível Priorizar' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Repetir enquanto houver lotes neste nível').check();
  await dialog.getByLabel('Intervalo em horas').fill('2');
  await dialog.getByLabel('Avisar diariamente neste horário').check();
  await dialog.getByLabel('Horário', { exact: true }).fill('09:30');
  await expect(dialog.getByLabel('Quando um lote entrar neste nível')).toBeChecked();
  const saved = page.waitForRequest(
    (request) => request.method() === 'PUT' && request.url().endsWith('/push/preferences'),
  );
  await dialog.getByRole('button', { name: 'Salvar', exact: true }).click();
  expect((await saved).postDataJSON()).toMatchObject({
    expectedVersion: 1,
    dailyDigestEnabled: true,
    depletedEnabled: true,
    levels: [
      { levelId: 'retirar', intervalHours: null, dailyTime: null },
      { levelId: 'priorizar', immediate: true, intervalHours: 2, dailyTime: '09:30' },
      { levelId: 'planejar', intervalHours: null, dailyTime: null },
    ],
  });
  await expect(dialog).not.toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
