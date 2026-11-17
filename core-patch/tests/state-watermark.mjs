// Watermark bookkeeping for the multi-session patch: `main` keeps the legacy field,
// every other session id gets its own entry, and old state files still load.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const APP = 'D:/002Apps/Coopanion/resources/app';
await import(pathToFileURL(join(APP, 'build/cortico/src/extensions/runtime.ts')).href);
const { CoreState } = await import(pathToFileURL(join(APP, 'build/cortico/src/core/state.ts')).href);

const failures = [];
const check = (name, ok, detail = '') => {
  if (!ok) failures.push(`${name} ${detail}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
};

const dir = mkdtempSync(join(tmpdir(), 'awx-state-'));
try {
  const a = new CoreState(dir);
  a.load();
  check('fresh main watermark is 0', a.watermark('main') === 0);
  check('fresh unknown watermark is 0', a.watermark('wechat-abc') === 0);

  a.setWatermark('main', 7);
  a.setWatermark('wechat-abc', 12);
  a.setWatermark('wechat-xyz', 3);
  a.save();

  const onDisk = JSON.parse(readFileSync(join(dir, 'core-state.json'), 'utf8'));
  check('main stays in the legacy field', onDisk.lastDeliveredCursor === 7, String(onDisk.lastDeliveredCursor));
  check('others land in the map', onDisk.lastDeliveredCursorBySession?.['wechat-abc'] === 12);

  const b = new CoreState(dir);
  b.load();
  check('reload keeps main', b.watermark('main') === 7);
  check('reload keeps wechat-abc', b.watermark('wechat-abc') === 12);
  check('reload keeps wechat-xyz', b.watermark('wechat-xyz') === 3);

  b.clear();
  check('clear keeps main watermark', b.watermark('main') === 7);
  check('clear keeps per-session watermarks', b.watermark('wechat-abc') === 12);

  // A state file written before this patch: one global cursor, no map at all.
  const legacyDir = mkdtempSync(join(tmpdir(), 'awx-legacy-'));
  try {
    writeFileSync(join(legacyDir, 'core-state.json'), JSON.stringify({ lastDeliveredCursor: 42 }), 'utf8');
    const c = new CoreState(legacyDir);
    c.load();
    check('legacy file: main reads the old cursor', c.watermark('main') === 42);
    check('legacy file: unknown session starts at 0', c.watermark('wechat-abc') === 0);
    c.setWatermark('wechat-abc', 43);
    c.save();
    const migrated = JSON.parse(readFileSync(join(legacyDir, 'core-state.json'), 'utf8'));
    check('legacy file: main field untouched by other sessions', migrated.lastDeliveredCursor === 42);
  } finally {
    rmSync(legacyDir, { recursive: true, force: true });
  }

  // Bad map values must not become watermarks.
  const dirtyDir = mkdtempSync(join(tmpdir(), 'awx-dirty-'));
  try {
    writeFileSync(join(dirtyDir, 'core-state.json'), JSON.stringify({
      lastDeliveredCursor: 5,
      lastDeliveredCursorBySession: { good: 9, bad: 'x', negative: -2, float: 1.5 },
    }), 'utf8');
    const d = new CoreState(dirtyDir);
    d.load();
    check('dirty map: valid entry kept', d.watermark('good') === 9);
    check('dirty map: invalid entries dropped', d.watermark('bad') === 0 && d.watermark('negative') === 0 && d.watermark('float') === 0);
  } finally {
    rmSync(dirtyDir, { recursive: true, force: true });
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} failed`);
  process.exit(1);
}
console.log('\nall watermark tests passed');
