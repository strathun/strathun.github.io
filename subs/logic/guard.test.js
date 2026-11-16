// Enforces SPEC §7 rules that a code review could miss:
// logic modules never use UTC date strings, never read the clock outside dates.js,
// and never touch the DOM, storage, network or Supabase.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const dir = new URL('./', import.meta.url);
const modules = readdirSync(dir).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'));

function code(file) {
  const src = readFileSync(new URL(file, dir), 'utf8');
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('logic modules exist', () => {
  assert.ok(modules.includes('dates.js'));
});

for (const file of modules) {
  test(`${file}: no toISOString`, () => {
    assert.doesNotMatch(code(file), /toISOString/);
  });

  test(`${file}: no DOM, storage, network or Supabase`, () => {
    assert.doesNotMatch(code(file), /\b(document|window|localStorage|sessionStorage|fetch|sb)\s*[.(]/);
  });

  if (file !== 'dates.js') {
    test(`${file}: reads no clock (only dates.js may)`, () => {
      assert.doesNotMatch(code(file), /new Date\(|Date\.now\(/);
    });
  }
}
