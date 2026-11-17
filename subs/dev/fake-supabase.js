// Fake supabase-js for the browser checks (see README.md). Served in place of the CDN
// script, so pages run with no network and no real database.
//
// - Signed in as tester@example.com.
// - Tables live in memory. Seed them by putting JSON { services: [...], periods: [...], charges: [...] }
//   in localStorage '__seed' before the page loads.
// - Enforces unique lower(name) on services (Postgres error 23505), like the real index.
//   Nothing else is enforced: no RLS, no foreign keys, no other constraints.
// - window.__fake hooks: tables, calls (every query made), blockWrites (updates and
//   deletes return zero rows, like an RLS block), delay (ms before each response).
// - Unknown query methods (gte, in, limit, …) are accepted and ignored, so other pages load.
(function () {
  const tables = { services: [], periods: [], charges: [], watchlist_items: [] };
  let seq = 0;
  const fake = (window.__fake = { tables, blockWrites: false, calls: [] });
  const seed = JSON.parse(localStorage.getItem('__seed') || 'null');
  if (seed) Object.assign(tables, seed);

  function builder(table) {
    let op = 'select', payload = null, filters = [], wantRows = false;
    const b = {
      select() { if (op === 'select') op = 'select'; else wantRows = true; return b; },
      insert(rows) { op = 'insert'; payload = Array.isArray(rows) ? rows : [rows]; return b; },
      update(row) { op = 'update'; payload = row; return b; },
      delete() { op = 'delete'; return b; },
      eq(col, val) { filters.push([col, val]); return b; },
      order() { return b; },
      then(resolve, reject) {
        const go = () => Promise.resolve(run()).then(resolve, reject);
        return fake.delay ? new Promise((r) => setTimeout(r, fake.delay)).then(go) : go();
      },
    };
    const proxy = new Proxy(b, { get: (t, k) => (k in t ? t[k] : () => proxy) });
    for (const k of Object.keys(b)) if (k !== 'then') { const f = b[k]; b[k] = (...a) => { f(...a); return proxy; }; }
    const match = (r) => filters.every(([c, v]) => r[c] === v);
    function run() {
      fake.calls.push({ table, op, payload, filters });
      const rows = (tables[table] ??= []);
      if (op === 'select') return { data: rows.map((r) => ({ ...r })), error: null };
      if (op === 'insert') {
        for (const r of payload) {
          if (table === 'services' && rows.some((x) => x.name.toLowerCase() === r.name.toLowerCase()))
            return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "services_user_name_uq"' } };
        }
        const out = payload.map((r) => ({ id: `${table}-${++seq}`, archived_at: null, created_at: new Date().toISOString(), ...r }));
        rows.push(...out);
        return { data: out.map((r) => ({ ...r })), error: null };
      }
      if (op === 'update') {
        if (fake.blockWrites) return { data: [], error: null };
        const hit = rows.filter(match);
        if (table === 'services' && payload.name && rows.some((x) => !match(x) && x.name.toLowerCase() === payload.name.toLowerCase()))
          return { data: null, error: { code: '23505', message: 'duplicate key' } };
        hit.forEach((r) => Object.assign(r, payload));
        return { data: hit.map((r) => ({ ...r })), error: null };
      }
      if (op === 'delete') {
        if (fake.blockWrites) return { data: [], error: null };
        const hit = rows.filter(match);
        tables[table] = rows.filter((r) => !match(r));
        return { data: hit, error: null };
      }
    }
    return proxy;
  }

  window.supabase = {
    createClient() {
      return {
        auth: {
          getSession: async () => ({ data: { session: { user: { id: 'u1', email: 'tester@example.com' } } } }),
          signOut: async () => ({}),
        },
        from: builder,
      };
    },
  };
})();
