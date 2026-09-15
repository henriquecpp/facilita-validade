import { Database } from '../shared/infrastructure/database.js';
import { PrismaDatabase } from '../shared/infrastructure/prisma.js';
import { Jobs } from '../shared/infrastructure/jobs.js';
import { PrismaInventory } from '../modules/inventory/adapters/out/prisma-inventory.js';
import { PrismaIntegration } from '../modules/integration/adapters/out/prisma-integration.js';
import { PagonetSync } from '../modules/integration/adapters/out/pagonet-sync.js';
import { PrismaNotifications } from '../modules/notifications/adapters/out/prisma-notifications.js';
import { createAlertDigestService, createPush } from '../modules/notifications/composition.js';
import { purgeExpiredRefreshTokens } from '../modules/identity/adapters/out/prisma-identity.js';
import { purgeDerivedHistory } from '../modules/inventory/adapters/out/retention.js';
const db = new Database();
const prisma = new PrismaDatabase(db);
const jobs = new Jobs();
const inventory = new PrismaInventory(prisma, jobs);
const integration = new PrismaIntegration(prisma, jobs, inventory);
const notifications = new PrismaNotifications(prisma);
const push = createPush(prisma);
const digests = createAlertDigestService(prisma, undefined, push);
const pagonet = new PagonetSync(prisma, jobs, integration);
if (!pagonet.token) console.warn('PAGONET_TOKEN ausente: importação pela Pagonet desligada.');
if (!digests.channelIds.includes('email'))
  console.warn('SMTP não configurado: resumo diário por e-mail desligado.');
if (!push.available) console.warn('Push não configurado: notificações push desligadas.');
await jobs.start();
type Payload = { storeId: string; productId?: string; batchId?: string };
await jobs.boss.work<Payload>('import.process', async (items) => {
  for (const j of items) {
    if (!j.data.batchId) throw new Error('Missing batchId');
    await integration.process(j.data.storeId, j.data.batchId);
  }
});
await jobs.boss.work<Payload>('inventory.rebuild', async (items) => {
  for (const j of items) {
    if (!j.data.productId) throw new Error('Missing productId');
    const { storeId, productId } = j.data;
    // A varredura enfileira produtos atrasados; se outro fluxo já os reconstruiu, nada a fazer.
    await prisma.tenant(storeId, (tx) => inventory.rebuildIfStale(tx, storeId, productId));
  }
});
// Em lotes: depois de uma leitura de vendas, centenas de produtos pedem reavaliação, e uma
// consulta para o grupo custa quase o mesmo que uma para um produto.
await jobs.boss.work<Payload>('notifications.evaluate', { batchSize: 100 }, async (items) => {
  const byStore = new Map<string, { all: boolean; products: string[] }>();
  for (const j of items) {
    const entry = byStore.get(j.data.storeId) ?? { all: false, products: [] };
    if (j.data.productId) entry.products.push(j.data.productId);
    else entry.all = true;
    byStore.set(j.data.storeId, entry);
  }
  for (const [storeId, entry] of byStore)
    await notifications.evaluate(storeId, entry.all ? undefined : entry.products);
});
// Uma volta da leitura: o catálogo e, logo depois, as vendas.
await jobs.boss.work<Payload>('pagonet.catalog', async (items) => {
  for (const j of items) await pagonet.cycle(j.data.storeId);
});
await jobs.boss.work<Payload>('pagonet.sales', async (items) => {
  for (const j of items) await pagonet.syncSales(j.data.storeId);
});
// Um dia do histórico da média de vendas, quando a rota de vendas está livre.
await jobs.boss.work<Payload>('pagonet.history', async (items) => {
  for (const j of items) await pagonet.syncHistory(j.data.storeId);
});
await jobs.boss.work<Payload>('maintenance.cleanup', async (items) => {
  for (const j of items)
    await prisma.tenant(j.data.storeId, async (tx) => {
      await purgeExpiredRefreshTokens(tx, j.data.storeId);
      await purgeDerivedHistory(tx, j.data.storeId);
    });
});
const message = (error: unknown) => (error instanceof Error ? error.message : 'unknown');
// A limpeza não precisa de cada minuto: de hora em hora, por loja, basta.
const CLEANUP_INTERVAL_MS = 3_600_000;
let lastCleanup = 0;
let sweeping = false;
async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    const stores = await prisma.auth.$queryRaw<
      { id: string }[]
    >`SELECT id FROM auth.active_store_ids()`;
    const cleanup = Date.now() - lastCleanup >= CLEANUP_INTERVAL_MS;
    let cleaned = true;
    for (const store of stores) {
      // Cada loja isolada: a falha de uma não tira das demais o trabalho deste minuto.
      try {
        await integration.recover(store.id);
        await notifications.evaluate(store.id);
        // Os alertas que mudaram neste minuto, num push só para o proprietário.
        const pushed = await push.flush(store.id);
        if (pushed?.targets)
          console.log(
            'push_alerts',
            JSON.stringify({ storeId: store.id, ...pushed, errors: pushed.errors.length }),
          );
        // A vez de cada leitura da Pagonet; o job respeita o limite de 5 minutos por rota.
        await pagonet.schedule(store.id);
        if (cleanup)
          await prisma.tenant(store.id, (tx) => jobs.send(tx, store.id, 'maintenance.cleanup', {}));
      } catch (error) {
        cleaned = false;
        console.error(
          'worker_recovery_failed',
          JSON.stringify({ storeId: store.id, error: message(error) }),
        );
      }
      try {
        for (const outcome of await digests.runDue(store.id))
          console.log('alert_digest', JSON.stringify({ storeId: store.id, ...outcome }));
      } catch (error) {
        console.error(
          'alert_digest_failed',
          JSON.stringify({ storeId: store.id, error: message(error) }),
        );
      }
    }
    if (cleanup && cleaned) lastCleanup = Date.now();
  } catch (error) {
    console.error('worker_recovery_failed', message(error));
  } finally {
    sweeping = false;
  }
}
await sweep();
const timer = setInterval(() => void sweep(), 60000);
timer.unref();
async function stop() {
  clearInterval(timer);
  await jobs.stop();
  // Clientes Prisma antes dos pools: eles usam os pools do Database.
  await prisma.close();
  await db.close();
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
console.log('Worker iniciado.');
