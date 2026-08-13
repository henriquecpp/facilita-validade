import { createApp } from './app.js';
const context = await createApp({ logging: true });
await context.jobs.start();
await context.app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
async function stop() {
  await context.app.close();
  await context.jobs.stop();
  // Clientes Prisma antes dos pools: eles usam os pools do Database.
  await context.prisma.close();
  await context.database.close();
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
