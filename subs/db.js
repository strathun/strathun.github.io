// Supabase calls for the subscription tracker (SPEC §6). Every function throws
// a DbError on failure, so the page shows the message instead of swallowing it.

export class DbError extends Error {
  constructor(message, code = null) {
    super(message);
    this.code = code;
  }
}

const UNIQUE_VIOLATION = '23505';

function unwrap({ data, error }, what) {
  if (!error) return data;
  console.error(what, error);
  if (error.code === UNIQUE_VIOLATION) {
    throw new DbError('a service with that name already exists', error.code);
  }
  throw new DbError(`couldn't ${what}: ${error.message}`, error.code);
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
  const [services, periods] = await Promise.all([
    window.sb.from('services').select('*'),
    window.sb.from('periods').select('*'),
  ]);
  return {
    services: unwrap(services, 'load services'),
    periods: unwrap(periods, 'load periods'),
  };
}

export async function insertService(row) {
  const res = await window.sb.from('services').insert(row).select();
  return one(unwrap(res, 'add the service'), 'add the service');
}

export async function updateService(id, row, what = 'save the service') {
  const res = await window.sb.from('services').update(row).eq('id', id).select();
  return one(unwrap(res, what), what);
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
  return unwrap(res, 'load the starter list');
}
