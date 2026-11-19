import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readPreferences, resetPreferences, savePreferences } from '../src/preferences.mjs';

test('preferences opt in locally, merge updates, reject credential fields and reset', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongji-prefs-'));
  try {
    assert.equal((await readPreferences(directory)).loginMode, 'manual');
    assert.equal((await readPreferences(directory)).loanDueSoonDays, 3);
    await savePreferences(directory, { preferredCampus: '四平路', allowCrossCampus: false });
    const stored = await savePreferences(directory, { pickupLocation: '测试取书点', loginMode: 'browser', loanDueSoonDays: 7 });
    assert.equal(stored.preferredCampus, '四平路');
    assert.equal(stored.allowCrossCampus, false);
    assert.equal(stored.loanDueSoonDays, 7);
    assert.deepEqual(await readPreferences(directory), stored);
    if (process.platform !== 'win32') assert.equal((await stat(path.join(directory, 'preferences.json'))).mode & 0o777, 0o600);
    await assert.rejects(savePreferences(directory, { username: 'fixture', password: 'fixture' }));
    await assert.rejects(savePreferences(directory, { loanDueSoonDays: -1 }));
    assert.deepEqual(await readPreferences(directory), stored);
    await resetPreferences(directory);
    assert.equal((await readPreferences(directory)).preferredCampus, null);
    assert.equal((await readPreferences(directory)).loginMode, 'manual');
    assert.equal((await readPreferences(directory)).loanDueSoonDays, 3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
