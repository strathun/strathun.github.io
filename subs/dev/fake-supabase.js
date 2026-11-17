// Fake supabase-js for the browser checks (see README.md). Served in place of the CDN
// script, so pages run with no network and no real database.
//
// - Signed in as tester@example.com.
// - Tables live in memory. Seed them by putting JSON { services: [...], periods: [...], charges: [...] }
//   in localStorage '__seed' before the page loads.
// - Enforces unique lower(name) on services (Postgres error 23505), like the real index.
//   Nothing else is enforced: no RLS, no foreign keys, no other constraints.
// - rpc() runs JS copies of the migrations/002 functions (see RPC below): same checks,
//   same error codes, and all-or-nothing writes.
// - window.__fake hooks: tables, calls (every query made), blockWrites (updates and
//   deletes return zero rows, like an RLS block), delay (ms before each response),
//   rpcError ({ code, message }: the next rpc fails with it and writes nothing).
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
      is(col, val) { filters.push([col, val]); return b; },
      order() { return b; },
      then(resolve, reject) {
        const go = () => Promise.resolve(run()).then(resolve, reject);
        return fake.delay ? new Promise((r) => setTimeout(r, fake.delay)).then(go) : go();
      },
    };
    const proxy = new Proxy(b, { get: (t, k) => (k in t ? t[k] : () => proxy) });
    for (const k of Object.keys(b)) if (k !== 'then') { const f = b[k]; b[k] = (...a) => { f(...a); return proxy; }; }
    const match = (r) => filters.every(([c, v]) => (v === null ? r[c] == null : r[c] === v));
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

  // ── rpc: JS copies of subs/migrations/002-*.sql ──────────────────────────
  const fail = (code, message) => ({ data: null, error: { code, message } });
  const copy = (r) => ({ ...r });
  const RPC = {
    mark_subscribed(a) {
      const s = tables.services.find((x) => x.id === a.p_service_id);
      if (!s) return fail('P0002', 'service not found, or not yours');
      if (s.archived_at) return fail('22023', 'restore the service before marking it subscribed');
      if (s.billing_interval !== a.p_billing_interval) return fail('22023', 'its billing interval changed since the page loaded. reload and try again');
      if (a.p_set_price && a.p_amount_cents == null) return fail('22023', 'enter the amount to save it as the price');
      if (tables.periods.some((p) => p.service_id === s.id && p.cancelled_on == null)) {
        return fail('23505', 'duplicate key value violates unique constraint "periods_one_open_per_service"');
      }
      const period = { id: `periods-${++seq}`, service_id: s.id, started_on: a.p_started_on, renews_on: a.p_renews_on, cancelled_on: null, access_ends_on: null };
      const charge = { id: `charges-${++seq}`, service_id: s.id, period_id: period.id, charged_on: a.p_started_on, amount_cents: a.p_amount_cents, billing_interval: a.p_billing_interval, source: 'manual' };
      tables.periods.push(period);
      tables.charges.push(charge);
      if (a.p_set_price) Object.assign(s, { price_cents: a.p_amount_cents, price_checked_on: a.p_started_on });
      return { data: { period: copy(period), charge: copy(charge), service: copy(s) }, error: null };
    },
  };

  function rpc(name, args) {
    return {
      then(resolve, reject) {
        const go = () => {
          fake.calls.push({ table: null, op: 'rpc', name, payload: args, filters: [] });
          if (fake.rpcError) {
            const { code, message } = fake.rpcError;
            fake.rpcError = null;
            return fail(code, message);
          }
          if (!RPC[name]) return fail('PGRST202', `Could not find the function public.${name} in the schema cache`);
          return RPC[name](args);
        };
        const run = () => Promise.resolve().then(go).then(resolve, reject);
        return fake.delay ? new Promise((r) => setTimeout(r, fake.delay)).then(run) : run();
      },
    };
  }

  window.supabase = {
    createClient() {
      return {
        auth: {
          getSession: async () => ({ data: { session: { user: { id: 'u1', email: 'tester@example.com' } } } }),
          signOut: async () => ({}),
        },
        from: builder,
        rpc,
      };
    },
  };
})();
