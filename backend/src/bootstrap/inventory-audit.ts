/**
 * Conferência dos números do estoque, só leitura: refaz os lotes de cada produto controlado com
 * o motor de estoque e compara com o que as telas mostram, e soma de novo os totais do Início e
 * das Validades (ver InventoryAudit).
 *
 * Uso: pnpm inventory:audit, com DATABASE_URL e AUTH_DATABASE_URL (os papéis da aplicação, com a
 * segurança por loja). INVENTORY_AUDIT_STORE=<id da loja> confere só uma loja. Sai com código 1
 * quando algum número diverge.
 */
import { InventoryAudit } from '../modules/inventory/adapters/out/inventory-audit.js';
import { PrismaInventory } from '../modules/inventory/adapters/out/prisma-inventory.js';
import { PrismaStore } from '../modules/tenancy/adapters/out/prisma-store.js';
import { Database } from '../shared/infrastructure/database.js';
import { Jobs } from '../shared/infrastructure/jobs.js';
import { PrismaDatabase } from '../shared/infrastructure/prisma.js';

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Defina ${name} para conferir o estoque.`);
  return value;
}

async function main() {
  const database = new Database(required('DATABASE_URL'), required('AUTH_DATABASE_URL'));
  const prisma = new PrismaDatabase(database);
  // Só leitura: a fila nunca é iniciada nem usada.
  const jobs = new Jobs();
  const audit = new InventoryAudit(
    prisma,
    new PrismaInventory(prisma, jobs),
    new PrismaStore(prisma, jobs),
  );
  try {
    const only = process.env.INVENTORY_AUDIT_STORE;
    const stores = only
      ? [{ id: only }]
      : await prisma.auth.$queryRaw<{ id: string }[]>`SELECT id FROM auth.active_store_ids()`;
    let differences = 0;
    for (const { id } of stores) {
      const report = await audit.check(id);
      differences += report.differences.length;
      console.log(
        `${report.storeName} (${id}): ${report.products} produtos controlados, ${report.lots} lotes com saldo — ` +
          (report.differences.length
            ? `${report.differences.length} diferença(s).`
            : 'os números conferem.'),
      );
      if (report.pending.length)
        console.log(`  Aguardando reconstrução (vendas recebidas): ${report.pending.join(', ')}`);
      for (const item of report.differences)
        console.log(`  - ${item.where}: esperado ${item.expected}, na tela ${item.shown}`);
    }
    process.exitCode = differences ? 1 : 0;
  } finally {
    await prisma.close();
    await database.close();
  }
}

await main();
