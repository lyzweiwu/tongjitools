import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const preferenceFields = {
  preferredCampus: z.enum(['四平路', '嘉定', '沪西', '沪北']).nullable().optional(),
  pickupLocation: z.string().trim().min(1).max(120).nullable().optional(),
  allowCrossCampus: z.boolean().optional(),
  loginMode: z.enum(['manual', 'browser']).optional(),
};
const preferenceSchema = z.strictObject(preferenceFields);
const defaults = { preferredCampus: null, pickupLocation: null, allowCrossCampus: true, loginMode: 'manual' };

export async function readPreferences(dataDir) {
  try {
    const contents = await readFile(path.join(dataDir, 'preferences.json'), 'utf8');
    return { ...defaults, ...preferenceSchema.parse(JSON.parse(contents)) };
  } catch (error) {
    if (error.code === 'ENOENT') return { ...defaults };
    throw new Error('本机借书偏好读取失败，请检查偏好文件。');
  }
}

export async function savePreferences(dataDir, changes) {
  const updates = preferenceSchema.parse(changes);
  const preferences = { ...await readPreferences(dataDir), ...updates };
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);
  const filename = path.join(dataDir, 'preferences.json');
  const temporary = path.join(dataDir, `.preferences-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(preferences, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, filename);
  } finally { await rm(temporary, { force: true }); }
  return preferences;
}

export function resetPreferences(dataDir) {
  return rm(path.join(dataDir, 'preferences.json'), { force: true });
}
