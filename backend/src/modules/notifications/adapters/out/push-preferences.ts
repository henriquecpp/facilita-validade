import type { PrismaTx, PrismaDatabase } from '../../../../shared/infrastructure/prisma.js';
import {
  ApplicationError,
  requireRole,
  type TenantActor,
} from '../../../../shared/domain/context.js';
import { audit, command } from '../../../../shared/infrastructure/commands.js';
import type { PushPreferences, PushPreferencesInput } from '../../domain/schedules.js';

export async function readPushPreferences(tx: PrismaTx, storeId: string): Promise<PushPreferences> {
  const [settings] = await tx.$queryRaw<Omit<PushPreferences, 'levels'>[]>`
    SELECT COALESCE(p.version, 0) AS version,
           COALESCE(p.daily_digest_enabled, true) AS "dailyDigestEnabled",
           COALESCE(p.depleted_enabled, true) AS "depletedEnabled"
      FROM stores s LEFT JOIN push_preferences p ON p.store_id = s.id
     WHERE s.id = ${storeId}::uuid`;
  if (!settings) throw new ApplicationError('NOT_FOUND', 'Loja não encontrada.', 404);
  const levels = await tx.$queryRaw<PushPreferences['levels']>`
    SELECT l.id AS "levelId", COALESCE(p.immediate, true) AS immediate,
           p.interval_hours AS "intervalHours", p.daily_time AS "dailyTime"
      FROM expiry_levels l
      LEFT JOIN level_push_preferences p ON p.store_id = l.store_id AND p.level_id = l.id
     WHERE l.store_id = ${storeId}::uuid
     ORDER BY l.min_days NULLS FIRST, l.id`;
  return { ...settings, levels };
}

export function savePushPreferences(
  prisma: PrismaDatabase,
  actor: TenantActor,
  key: string,
  input: PushPreferencesInput,
) {
  requireRole(actor, ['OWNER']);
  const { storeId, userId } = actor;
  return prisma.tenant(storeId, (tx) =>
    command(tx, storeId, userId, 'push.preferences', key, input, async () => {
      // Mesmo lock dos níveis/settings: um nível removido concorrentemente não reaparece.
      await tx.$queryRaw`SELECT store_id FROM store_settings WHERE store_id = ${storeId}::uuid FOR UPDATE`;
      const current = await readPushPreferences(tx, storeId);
      if (current.version !== input.expectedVersion)
        throw new ApplicationError(
          'VERSION_CONFLICT',
          'As notificações foram alteradas. Recarregue antes de salvar.',
          409,
        );
      const ids = new Set(current.levels.map((level) => level.levelId));
      const supplied = new Set(input.levels.map((level) => level.levelId));
      if (
        supplied.size !== input.levels.length ||
        supplied.size !== ids.size ||
        [...supplied].some((id) => !ids.has(id))
      )
        throw new ApplicationError(
          'LEVELS_CHANGED',
          'A lista de níveis mudou. Recarregue antes de salvar.',
          409,
        );
      await tx.$executeRaw`
      INSERT INTO push_preferences(store_id, version, daily_digest_enabled, depleted_enabled)
      VALUES (${storeId}::uuid, ${current.version + 1}, ${input.dailyDigestEnabled}, ${input.depletedEnabled})
      ON CONFLICT (store_id) DO UPDATE SET version = excluded.version,
        daily_digest_enabled = excluded.daily_digest_enabled, depleted_enabled = excluded.depleted_enabled`;
      for (const level of input.levels)
        await tx.$executeRaw`
        INSERT INTO level_push_preferences(store_id, level_id, immediate, interval_hours, daily_time)
        VALUES (${storeId}::uuid, ${level.levelId}::uuid, ${level.immediate}, ${level.intervalHours ?? null}, ${level.dailyTime ?? null})
        ON CONFLICT (store_id, level_id) DO UPDATE SET immediate = excluded.immediate,
          interval_hours = excluded.interval_hours, daily_time = excluded.daily_time`;
      await audit(tx, storeId, userId, 'push.preferences', null, input);
      return readPushPreferences(tx, storeId);
    }),
  );
}
