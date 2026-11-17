// Supabase calls for the subscription tracker (SPEC §6). Every function throws
// a DbError on failure, so the page shows the message instead of swallowing it.

export class DbError extends Error {
  constructor(message, code = null) {
    super(message);
    this.code = code;
  }
}

const UNIQUE_VIOLATION = '23505';
const NAME_TAKEN = { [UNIQUE_VIOLATION]: 'a service with that name already exists' };

// PostgREST can't find the function: subs/migrations/002-*.sql hasn't been run.
const MISSING_FUNCTION = 'PGRST202';
const NEEDS_MIGRATION = {
  [MISSING_FUNCTION]: 'the database is missing migration 002. run subs/migrations/002-subscribe-and-delete-period.sql in supabase, then reload.',
};

/**
 * The data, or a DbError. `known` maps an error code to the whole message to show
 * (e.g. a unique violation whose meaning depends on the table).
 */
function unwrap({ data, error }, what, known = {}) {
  if (!error) return data;
  console.error(what, error);
  throw new DbError(known[error.code] ?? `couldn't ${what}: ${error.message}`, error.code);
}

/**
 * The single row a write returned. A write that RLS blocks, or whose id no
 * longer exists, returns no error and no rows, so an empty result is a failure.
 */
function one(rows, what) {
  if (!rows?.length) throw new DbError(`couldn't ${what}: not found, or not yours`);
  return rows[0];
}

export async function loadAll() {
  const [services, periods, charges] = await Promise.all([
    window.sb.from('services').select('*'),
    window.sb.from('periods').select('*'),
    window.sb.from('charges').select('*'),
  ]);
  return {
    services: unwrap(services, 'load services'),
    periods: unwrap(periods, 'load periods'),
    charges: unwrap(charges, 'load charges'),
  };
}

export async function insertService(row) {
  const res = await window.sb.from('services').insert(row).select();
  return one(unwrap(res, 'add the service', NAME_TAKEN), 'add the service');
}

export async function updateService(id, row, what = 'save the service') {
  const res = await window.sb.from('services').update(row).eq('id', id).select();
  return one(unwrap(res, what, NAME_TAKEN), what);
}

/** Archive (SPEC §8.4): hides the service but keeps its history. */
export async function archiveService(id) {
  return updateService(id, { archived_at: new Date().toISOString() }, 'archive the service');
}

export async function restoreService(id) {
  return updateService(id, { archived_at: null }, 'restore the service');
}

/** Permanent delete. Foreign keys cascade to periods, charges and watchlist items. */
export async function deleteService(id) {
  const res = await window.sb.from('services').delete().eq('id', id).select('id');
  return one(unwrap(res, 'delete the service'), 'delete the service');
}

/** One bulk insert is one statement: all rows go in, or none do. */
export async function insertServices(rows) {
  const res = await window.sb.from('services').insert(rows).select();
  return unwrap(res, 'load the starter list', NAME_TAKEN);
}

// ── periods and charges (SPEC §7.3, §8.3) ───────────────────────────────────

/**
 * Mark subscribed: planSubscribe()'s period and charge, plus the price change when
 * setPrice, in one transaction (migrations/002). Resolves to { period, charge, service }.
 */
export async function markSubscribed({ period, charge }, setPrice) {
  const what = 'mark it subscribed';
  const res = await window.sb.rpc('mark_subscribed', {
    p_service_id: period.service_id,
    p_started_on: period.started_on,
    p_renews_on: period.renews_on,
    p_billing_interval: charge.billing_interval,
    p_amount_cents: charge.amount_cents,
    p_set_price: !!setPrice,
  });
  const data = unwrap(res, what, {
    ...NEEDS_MIGRATION,
    [UNIQUE_VIOLATION]: "it already has a period that isn't cancelled. reload the page.",
  });
  if (!data?.period || !data?.charge || !data?.service) throw new DbError(`couldn't ${what}: no rows came back`);
  return data;
}

/**
 * Delete period (SPEC §8.3): the period and all its charges, in one transaction
 * (migrations/002). Resolves to { period, charge_ids }.
 */
export async function deletePeriod(id) {
  const what = 'delete the period';
  const data = unwrap(await window.sb.rpc('delete_period', { p_period_id: id }), what, NEEDS_MIGRATION);
  if (!data?.period || !Array.isArray(data.charge_ids)) throw new DbError(`couldn't ${what}: no rows came back`);
  return data;
}

/**
 * Automatic renewal catch-up (SPEC §7.3) for planCatchUpAll()'s work.
 *
 * Charges go in first, then each period's renews_on advances. If the second step
 * fails, the next load plans the same charges again and the unique index on
 * (period_id, charged_on) skips the ones already stored. The other order could
 * lose charges for good. renews_on only advances from the value it was planned
 * from, so a second tab that got there first is left alone (acceptance 9).
 * Resolves to the charges actually inserted: [{ id, service_id }].
 */
export async function recordRenewals(work) {
  const what = 'record renewals';
  const charges = work.flatMap((w) => w.charges);
  const inserted = await window.sb
    .from('charges')
    .upsert(charges, { onConflict: 'period_id,charged_on', ignoreDuplicates: true })
    .select('id, service_id');
  const rows = unwrap(inserted, what) ?? [];
  const advanced = await Promise.all(work.map((w) => window.sb
    .from('periods')
    .update({ renews_on: w.renews_on })
    .eq('id', w.period_id)
    .eq('renews_on', w.from_renews_on)
    .select('id')));
  // Zero rows means another tab advanced it first: not an error.
  for (const res of advanced) unwrap(res, what);
  return rows;
}

/** Edit charge (SPEC §8.3): amount and/or date. */
export async function updateCharge(id, row) {
  const what = 'save the charge';
  const res = await window.sb.from('charges').update(row).eq('id', id).select();
  return one(unwrap(res, what, { [UNIQUE_VIOLATION]: 'this period already has a charge on that date' }), what);
}

/**
 * Mark cancelled: sets cancelled_on and access_ends_on. Only a period that is still
 * uncancelled matches, so a second tab can't overwrite the first one's dates.
 */
export async function cancelPeriod(id, row) {
  const what = 'mark it cancelled';
  const res = await window.sb.from('periods').update(row).eq('id', id).is('cancelled_on', null).select();
  const rows = unwrap(res, what);
  if (!rows?.length) throw new DbError(`couldn't ${what}: it's already cancelled, gone, or not yours. reload the page.`);
  return rows[0];
}
