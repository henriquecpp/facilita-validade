export interface LevelPushPreference {
  levelId: string;
  immediate: boolean;
  intervalHours: number | null;
  dailyTime: string | null;
}
export interface PushPreferences {
  version: number;
  dailyDigestEnabled: boolean;
  depletedEnabled: boolean;
  levels: LevelPushPreference[];
}
export type PushPreferencesInput = Omit<PushPreferences, 'version'> & { expectedVersion: number };

/** Horários civis já calculados no fuso da loja; nenhuma dependência do fuso do worker. */
export function dueScheduleKeys(
  preference: Pick<LevelPushPreference, 'intervalHours' | 'dailyTime'>,
  localDate: string,
  localTime: string,
): string[] {
  const hour = Number(localTime.slice(0, 2));
  const keys: string[] = [];
  if (preference.intervalHours)
    keys.push(
      `hours:${preference.intervalHours}:${localDate}:${Math.floor(hour / preference.intervalHours)}`,
    );
  if (preference.dailyTime && localTime >= preference.dailyTime) keys.push(`daily:${localDate}`);
  return keys;
}
