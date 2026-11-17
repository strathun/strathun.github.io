import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STARTER_SERVICES, starterRows } from './starter.js';
import { serviceFromForm, formValues, findNameConflict, SERVICE_FIELDS } from './services.js';
import { TODAY } from './fixtures.js';

function specStarterList() {
  const spec = readFileSync(new URL('../SPEC.md', import.meta.url), 'utf8');
  const section = spec.slice(spec.indexOf('## 11.'), spec.indexOf('## 12.'));
  const block = /```json\n([\s\S]*?)\n```/.exec(section);
  assert.ok(block, 'SPEC §11 has a ```json block');
  return JSON.parse(block[1]);
}

test('starter list matches SPEC §11 exactly', () => {
  assert.deepEqual(STARTER_SERVICES, specStarterList());
});

test('starter list has 13 services with unique names (acceptance 2)', () => {
  assert.equal(STARTER_SERVICES.length, 13);
  STARTER_SERVICES.forEach((row, i) => {
    const others = STARTER_SERVICES.filter((_, j) => j !== i).map((r, j) => ({ ...r, id: j }));
    assert.equal(findNameConflict(others, row.name), null, row.name);
  });
});

test('starter rows only use real services columns', () => {
  for (const row of STARTER_SERVICES) {
    for (const key of Object.keys(row)) assert.ok(SERVICE_FIELDS.includes(key), `${row.name}: ${key}`);
  }
});

test('every starter row passes form validation unchanged', () => {
  for (const row of starterRows()) {
    const out = serviceFromForm(formValues(row), { today: TODAY, previous: row });
    assert.deepEqual(out.errors, {}, row.name);
    assert.deepEqual(out.row, row, row.name);
  }
});

test('starterRows fills every column, keeping column defaults', () => {
  const rows = starterRows();
  for (const row of rows) assert.deepEqual(Object.keys(row).sort(), [...SERVICE_FIELDS].sort());
  const icloud = rows.find((r) => r.name === 'iCloud+');
  assert.equal(icloud.manage_url, null);
  assert.match(icloud.manage_path, /^iPhone Settings/);
  const spotify = rows.find((r) => r.name === 'Spotify');
  assert.equal(spotify.price_cents, null);
  assert.equal(spotify.manage_path, null);
  assert.equal(rows.find((r) => r.name === 'Google One').price_cents, 5000);
});
