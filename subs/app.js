// Subscription tracker page (SPEC §8). The rules live in ./logic and are unit-tested;
// this file only loads rows, renders what the logic returns, and wires up events.
//
// This is a module, so its functions aren't globals: markup uses data-action
// attributes and one delegated click listener instead of onclick="…".
//
// Views are picked by the URL hash, so the browser back button works:
//   #/        dashboard
//   #/s/{id}  service detail

import { todayLocal, formatDay } from './logic/dates.js';
import { groupByService, serviceStatus, openPeriod, accessEnd } from './logic/status.js';
import {
  CATEGORIES, INTERVALS, INTERVAL_SHORT, formatCents, formatPrice, formValues, serviceFromForm,
  findNameConflict, groupServices, serviceBadges, canArchive, isWebUrl, setupProgress, parseCents,
} from './logic/services.js';
import { periodHistory, chargeTotal } from './logic/history.js';
import {
  setPriceOption, subscribeDefaults, subscribeFromForm,
  renewalPending, cancelDefaults, cancelFromForm,
  chargeDefaults, chargeSetPriceOption, chargeFromForm,
} from './logic/entry.js';
import { starterRows } from './logic/starter.js';
import { planCatchUpAll } from './logic/periods.js';
import * as db from './db.js';

const state = {
  loaded: false,
  services: [],
  periodsByService: new Map(),
  chargesByService: new Map(),
  showArchived: false,
  /** Why the last catch-up failed, shown until a reload succeeds. */
  catchUpError: null,
};

/** The service open in the form, or null when adding a new one. */
let editing = null;
/** The service open in the delete dialog. */
let deleting = null;
/**
 * True while a dialog's save or delete request is in flight. The dialog stays
 * open until it finishes, so a failure is shown where the user can see it.
 */
let dialogBusy = false;

const $ = (sel) => document.querySelector(sel);

// ── helpers ─────────────────────────────────────────────────────────────────

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}

function toast(msg, { error = false } = {}) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', error);
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), error ? 4000 : 1800);
}

/** Disables the clicked button while `fn` runs, so a double click can't send twice. */
async function busy(button, fn) {
  if (button) button.disabled = true;
  try {
    await fn();
  } finally {
    if (button?.isConnected) button.disabled = false;
  }
}

// Per-device convenience only (SPEC §11): storage can be blocked, so never rely on it.
const CHECKLIST_KEY = 'subs.checklistDismissed';
function checklistDismissed() {
  try { return localStorage.getItem(CHECKLIST_KEY) === '1'; } catch { return false; }
}
function setChecklistDismissed(dismissed) {
  try {
    if (dismissed) localStorage.setItem(CHECKLIST_KEY, '1');
    else localStorage.removeItem(CHECKLIST_KEY);
  } catch { /* the checklist just reappears next visit */ }
}

const findService = (id) => state.services.find((s) => s.id === id) ?? null;
const periodsOf = (id) => state.periodsByService.get(id) ?? [];
const chargesOf = (id) => state.chargesByService.get(id) ?? [];
const detailHref = (id) => `#/s/${encodeURIComponent(id)}`;

/** Local calendar date of a timestamptz such as archived_at. */
const localDay = (timestamp) => todayLocal(new Date(timestamp));

// ── data ────────────────────────────────────────────────────────────────────

async function load() {
  let data;
  try {
    data = await db.loadAll();
  } catch (err) {
    $('#view').innerHTML = `
      <div class="load-error">
        <p>${esc(err.message)}</p>
        <button class="btn" data-action="reload">try again</button>
      </div>`;
    return;
  }
  data = await catchUp(data);
  state.services = data.services;
  state.periodsByService = groupByService(data.periods);
  state.chargesByService = groupByService(data.charges);
  state.loaded = true;
  render();
}

/**
 * Records renewals that came due since the last load (SPEC §7.3), then reloads so
 * the page shows exactly what's stored. On failure, keeps the rows it has and
 * shows why; the next load tries again and can't double-charge (acceptance 9).
 */
async function catchUp(data) {
  state.catchUpError = null;
  let inserted;
  try {
    const work = planCatchUpAll({ services: data.services, periods: data.periods, today: todayLocal() });
    if (!work.length) return data;
    inserted = await db.recordRenewals(work);
  } catch (err) {
    state.catchUpError = err.message;
    return data;
  }
  // Count what was stored, not what was planned: another tab may have stored some first.
  if (inserted.length) {
    const names = [...new Set(inserted.map((c) => data.services.find((s) => s.id === c.service_id)?.name ?? 'a deleted service'))];
    toast(`recorded ${inserted.length} renewal${inserted.length === 1 ? '' : 's'}: ${names.join(', ')}`);
  }
  try {
    return await db.loadAll();
  } catch (err) {
    state.catchUpError = `renewals were recorded, but ${err.message}`;
    return data;
  }
}

function upsertLocal(row) {
  const i = state.services.findIndex((s) => s.id === row.id);
  if (i === -1) state.services.push(row);
  else state.services[i] = row;
}

/** Adds or replaces a period or charge row in its service's list. */
function putRow(map, row) {
  const list = map.get(row.service_id);
  if (!list) map.set(row.service_id, [row]);
  else {
    const i = list.findIndex((r) => r.id === row.id);
    if (i === -1) list.push(row);
    else list[i] = row;
  }
}

function removeLocal(id) {
  state.services = state.services.filter((s) => s.id !== id);
  state.periodsByService.delete(id);
  state.chargesByService.delete(id);
}

// ── routing ─────────────────────────────────────────────────────────────────

function currentRoute() {
  const match = /^#\/s\/([^/]+)$/.exec(location.hash);
  if (!match) return { view: 'dashboard' };
  try {
    return { view: 'detail', id: decodeURIComponent(match[1]) };
  } catch {
    return { view: 'detail', id: null }; // malformed escape, e.g. #/s/% → "doesn't exist"
  }
}

function render() {
  if (!state.loaded) return;
  const route = currentRoute();
  if (route.view === 'detail') renderDetail(route.id);
  else renderDashboard();
  if (state.catchUpError) {
    $('#view').insertAdjacentHTML('afterbegin', `
      <div class="banner-error" role="alert">
        <span>${esc(state.catchUpError)}</span>
        <button class="btn" data-action="reload">try again</button>
      </div>`);
  }
}

// ── dashboard (SPEC §8.1) ───────────────────────────────────────────────────

const GROUPS = [
  ['renewing', 'active'],
  ['ending', 'active until…'],
  ['inactive', 'inactive'],
];

const BADGES = {
  verify_link: { label: 'verify link', cls: 'badge-muted', title: () => 'the manage link is a best guess' },
  price_unknown: { label: 'price unknown', cls: 'badge-warn', title: () => 'enter the price from a statement' },
  check_price: {
    label: 'check price',
    cls: 'badge-warn',
    title: (a, today) => (a.checkedOn ? `last checked ${formatDay(a.checkedOn, today)}` : 'never checked'),
  },
};

function badgesHtml(service, today) {
  return serviceBadges(service, today)
    .map((a) => {
      const b = BADGES[a.type];
      return `<span class="badge ${b.cls}" title="${esc(b.title(a, today))}">${b.label}</span>`;
    })
    .join('');
}

function subline(service) {
  const role = `<span class="role-${esc(service.role)}">${esc(service.role)}</span>`;
  return service.category ? `${role} · ${esc(service.category)}` : role;
}

function renderDashboard() {
  const today = todayLocal();
  const groups = groupServices(state.services, state.periodsByService, today);
  const count = state.services.length - groups.archived.length;
  const header = `
    <div class="subs-header">
      <div class="subs-title">subscriptions <small>${count || ''}</small></div>
      <button class="btn btn-primary" data-action="add">+ add service</button>
    </div>`;

  if (!state.services.length) {
    $('#view').innerHTML = `${header}
      <div class="empty">
        <p>no services yet.</p>
        <p>the starter list adds 13 common services with their manage links. prices start blank.</p>
        <p class="empty-actions">
          <button class="btn btn-primary" data-action="load-starter">load starter list</button>
          <button class="btn" data-action="add">add one yourself</button>
        </p>
      </div>`;
    return;
  }

  const sections = GROUPS.filter(([key]) => groups[key].length)
    .map(([key, label]) => groupHtml(label, groups[key], today))
    .join('');
  const none = count ? '' : `<div class="empty"><p>every service is archived.</p></div>`;

  let archived = '';
  if (groups.archived.length) {
    archived = `
      <button class="link-btn" data-action="toggle-archived" aria-expanded="${state.showArchived}">
        ${state.showArchived ? 'hide' : 'show'} archived (${groups.archived.length})
      </button>
      ${state.showArchived ? groupHtml('archived', groups.archived, today, 'is-archived') : ''}`;
  }

  const dismissed = checklistDismissed();
  const checklist = dismissed ? '' : checklistHtml();
  const reopen = dismissed
    ? `<button class="link-btn" data-action="show-checklist">show setup checklist</button>`
    : '';

  $('#view').innerHTML = header + checklist + sections + none + archived + reopen;
}

// ── setup checklist (SPEC §11) ──────────────────────────────────────────────

function checklistHtml() {
  const { priced, total } = setupProgress(state.services);
  const pricesDone = total > 0 && priced === total;
  return `
    <section class="checklist" aria-labelledby="checklist-title">
      <div class="checklist-head">
        <h2 class="group-title" id="checklist-title">setup checklist</h2>
        <button class="link-btn" data-action="dismiss-checklist">hide</button>
      </div>
      <ol>
        <li class="${pricesDone ? 'done' : ''}">
          enter each service's price and confirm how it's billed. a statement is the best source.
          <span class="progress">${priced} of ${total} priced</span>
        </li>
        <li>
          for each service you pay for now, mark subscribed on the date of its most recent charge
          (spotify, uzzu, nintendo, claude, google one, paramount+, amazon prime, icloud+, netflix, ps plus).
          annual keepers (nintendo, google one, prime) may go back to 2025; that's what makes this year's spend right.
        </li>
        <li>for rotators you've already cancelled (or cancel now), mark cancelled.</li>
        <li>
          optional: backfill earlier rotations this year, so the year view and averages cover the whole year:
          mark subscribed on the day it started, then mark cancelled straight away.
        </li>
      </ol>
    </section>`;
}

async function loadStarter(button) {
  if (state.services.length) return; // SPEC §8.5: only offered with zero services
  await busy(button, async () => {
    button.textContent = 'loading…';
    try {
      state.services = await db.insertServices(starterRows());
      setChecklistDismissed(false);
      render();
      toast(`loaded ${state.services.length} services`);
    } catch (err) {
      if (err.code === '23505') {
        // Another tab (or a double submit) got there first. Show what's really there.
        await load();
        toast('the starter list was already loaded');
      } else {
        toast(err.message, { error: true });
        if (button.isConnected) button.textContent = 'load starter list';
      }
    }
  });
}

function groupHtml(label, entries, today, rowClass = '') {
  return `
    <section class="group">
      <h2 class="group-title">${label}<small>${entries.length}</small></h2>
      <ul class="service-list">${entries.map((e) => rowHtml(e, today, rowClass)).join('')}</ul>
    </section>`;
}

function rowHtml({ service, status, accessEndsOn }, today, rowClass) {
  const badges = badgesHtml(service, today);
  const until = status === 'ending' && !service.archived_at
    ? `<span class="row-until">until ${esc(formatDay(accessEndsOn, today))}</span>`
    : '';
  return `
    <li>
      <a class="service-row ${rowClass}" href="${detailHref(service.id)}">
        <span class="row-main">
          <span class="row-name">${esc(service.name)}</span>
          <span class="row-sub">${subline(service)}</span>
        </span>
        <span class="row-side">
          <span class="row-price">${esc(formatPrice(service))}</span>${until}
        </span>
        ${badges ? `<span class="row-badges">${badges}</span>` : ''}
      </a>
    </li>`;
}

// ── service detail (SPEC §8.3) ──────────────────────────────────────────────

function statusText({ status, period, accessEndsOn }, today) {
  if (status === 'renewing') {
    return period.renews_on ? `active · renews ${formatDay(period.renews_on, today)}` : 'active';
  }
  if (status === 'ending') return `active until ${formatDay(accessEndsOn, today)}`;
  return accessEndsOn ? `inactive · ended ${formatDay(accessEndsOn, today)}` : 'inactive';
}

function manageHtml(service) {
  const parts = [];
  if (isWebUrl(service.manage_url)) {
    parts.push(`<a class="btn btn-primary" href="${esc(service.manage_url)}" target="_blank" rel="noopener noreferrer">open manage page ↗</a>`);
  }
  if (isWebUrl(service.help_url)) {
    parts.push(`<a class="btn" href="${esc(service.help_url)}" target="_blank" rel="noopener noreferrer">how to cancel ↗</a>`);
  }
  const path = service.manage_path
    ? `<div class="manage-path"><span class="field-label">manage path</span>${esc(service.manage_path)}</div>`
    : '';
  const none = !parts.length && !path ? `<p class="muted">no manage link yet. edit to add one.</p>` : '';
  const verify = service.manage_url && !service.url_verified
    ? `<p class="muted small">this link is a best guess. once you've used it, edit the service and tick "link verified" (or paste where the browser really landed).</p>`
    : '';
  return `${parts.length ? `<div class="detail-links">${parts.join('')}</div>` : ''}${path}${none}${verify}`;
}

function priceText(service, today) {
  if (service.price_cents == null) return 'unknown';
  const checked = service.price_checked_on
    ? `checked ${formatDay(service.price_checked_on, today)}`
    : 'never checked';
  return `${formatPrice(service)} <span class="muted">· ${checked}</span>`;
}

function renderDetail(id) {
  const service = findService(id);
  const back = `<a class="back" href="#/">← all services</a>`;
  if (!service) {
    $('#view').innerHTML = `${back}<div class="empty"><p>that service doesn't exist (or was deleted).</p></div>`;
    return;
  }

  const today = todayLocal();
  const status = serviceStatus(periodsOf(service.id), today);
  const badges = badgesHtml(service, today);
  const lead = service.cancel_lead_days;

  let actions;
  if (service.archived_at) {
    actions = `
      <button class="btn" data-action="restore" data-id="${esc(service.id)}">restore</button>
      <button class="btn btn-danger" data-action="delete" data-id="${esc(service.id)}">delete permanently…</button>`;
  } else {
    // At most one uncancelled period (SPEC §6): while it exists, Mark subscribed is off (acceptance 7),
    // and the service is renewing (§7.1), so Archive is off too.
    const open = openPeriod(periodsOf(service.id));
    const allowed = canArchive(status.status);
    const id = esc(service.id);
    const hint = open
      ? "still renewing. mark it cancelled before subscribing again or archiving, so its charges can't continue unseen."
      : '';
    const off = 'disabled aria-describedby="actions-hint"';
    actions = `
      ${open ? `<button class="btn btn-primary" data-action="cancel" data-id="${id}">mark cancelled</button>` : ''}
      <button class="btn ${open ? '' : 'btn-primary'}" data-action="subscribe" data-id="${id}" ${open ? off : ''}>mark subscribed</button>
      <button class="btn" data-action="edit" data-id="${id}">edit</button>
      <button class="btn" data-action="archive" data-id="${id}" ${allowed ? '' : off}>archive</button>
      ${hint ? `<p class="muted small" id="actions-hint">${hint}</p>` : ''}`;
  }

  $('#view').innerHTML = `
    ${back}
    <article class="detail">
      <header class="detail-head">
        <h1 class="detail-name">${esc(service.name)}</h1>
        <div class="row-sub">${subline(service)}</div>
      </header>

      <div class="detail-status status-${service.archived_at ? 'archived' : status.status}">
        ${service.archived_at ? `archived ${esc(formatDay(localDay(service.archived_at), today))} · ` : ''}${esc(statusText(status, today))}
      </div>
      ${badges ? `<div class="row-badges">${badges}</div>` : ''}

      <section class="detail-section">${manageHtml(service)}</section>

      <dl class="kv">
        <dt>price</dt><dd>${priceText(service, today)}</dd>
        <dt>billed</dt><dd>${esc(service.billing_interval)}</dd>
        <dt>cancel by</dt><dd>${lead} day${lead === 1 ? '' : 's'} before renewal</dd>
        ${service.notes ? `<dt>notes</dt><dd class="notes">${esc(service.notes)}</dd>` : ''}
      </dl>

      <div class="detail-actions">${actions}</div>
    </article>
    ${historyHtml(service, today)}`;
}

// ── period history and charges (SPEC §8.3) ──────────────────────────────────

/** 'nov 1 → renewing' or 'mar 1 → mar 31', the way the history and dialogs name a period. */
function periodLabel({ period, open, accessEndsOn }, today) {
  const start = formatDay(period.started_on, today);
  return open ? `${start} → renewing` : `${start} → ${formatDay(accessEndsOn, today)}`;
}

function periodHeadHtml(entry, today) {
  const { period, open, accessEndsOn } = entry;
  const start = esc(formatDay(period.started_on, today));
  const del = `<button class="link-btn period-delete" data-action="delete-period" data-id="${esc(period.id)}" data-service="${esc(period.service_id)}" aria-label="delete the ${esc(periodLabel(entry, today))} period">delete…</button>`;
  if (open) {
    const next = period.renews_on
      ? `<span class="period-meta">next charge ${esc(formatDay(period.renews_on, today))}</span>`
      : '';
    return `<span class="period-when"><span class="period-dates">${start} → <span class="status-renewing">renewing</span></span> ${next}</span> ${del}`;
  }
  return `<span class="period-when">
      <span class="period-dates">${start} → ${esc(formatDay(accessEndsOn, today))}</span>
      <span class="period-meta">cancelled ${esc(formatDay(period.cancelled_on, today))}</span>
    </span> ${del}`;
}

function chargeHtml(charge, today, { editable = false } = {}) {
  const amount = charge.amount_cents == null
    ? `<span class="charge-amount unknown">amount unknown</span>`
    : `<span class="charge-amount">${esc(formatCents(charge.amount_cents))}</span>`;
  const interval = INTERVAL_SHORT[charge.billing_interval] ?? charge.billing_interval;
  const auto = charge.source === 'auto'
    ? `<span class="badge badge-muted" title="recorded automatically on the renewal date">auto</span>`
    : '';
  const edit = editable
    ? ` <button class="link-btn charge-edit" data-action="edit-charge" data-id="${esc(charge.id)}" data-service="${esc(charge.service_id)}" aria-label="edit the ${esc(formatDay(charge.charged_on, today))} charge">edit</button>`
    : '';
  return `
    <li class="charge">
      <span class="charge-date">${esc(formatDay(charge.charged_on, today))}</span>
      <span class="charge-what">${amount}<span class="muted"> / ${esc(interval)}</span> ${auto}</span>${edit}
    </li>`;
}

function chargeListHtml(charges, today) {
  if (!charges.length) return `<p class="muted small charge-none">no charges</p>`;
  return `<ul class="charge-list">${charges.map((c) => chargeHtml(c, today, { editable: true })).join('')}</ul>`;
}

function historyHtml(service, today) {
  const { periods, loose } = periodHistory(periodsOf(service.id), chargesOf(service.id));
  let body;
  if (!periods.length && !loose.length) {
    body = `<p class="muted small">no periods yet.</p>`;
  } else {
    body = `<ol class="period-list">${periods.map((entry) => `
      <li class="period ${entry.open ? 'is-open' : ''}">
        <div class="period-head">${periodHeadHtml(entry, today)}</div>
        ${chargeListHtml(entry.charges, today)}
      </li>`).join('')}</ol>`;
    if (loose.length) {
      body += `
        <div class="period loose">
          <div class="period-head"><span class="period-dates">charges in no period</span></div>
          ${chargeListHtml(loose, today)}
        </div>`;
    }
  }
  return `
    <section class="history" aria-labelledby="history-title">
      <h2 class="group-title" id="history-title">periods and charges</h2>
      ${body}
    </section>`;
}

// ── add / edit form (SPEC §8.4) ─────────────────────────────────────────────

const form = $('#svc-form');
const field = (name) => form.elements.namedItem(name);

function fillSelects() {
  field('category').innerHTML = ['<option value="">—</option>']
    .concat(CATEGORIES.map((c) => `<option value="${c}">${c}</option>`))
    .join('');
  field('billing_interval').innerHTML = INTERVALS
    .map((i) => `<option value="${i}">${i}</option>`)
    .join('');
}

function openForm(service = null) {
  editing = service;
  const values = formValues(service ?? undefined);
  for (const [name, value] of Object.entries(values)) {
    const el = field(name);
    if (el.type === 'checkbox') el.checked = value;
    else el.value = value; // also sets the checked radio for `role`
  }
  showErrors({});
  $('#svc-title').textContent = service ? `edit ${service.name}` : 'new service';
  $('#svc-modal').classList.add('open');
  field('name').focus();
}

function closeForm() {
  if (dialogBusy) return;
  $('#svc-modal').classList.remove('open');
  editing = null;
}

function readForm() {
  const values = {};
  for (const name of Object.keys(formValues())) {
    const el = field(name);
    values[name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return values;
}

/** Shows `errors` (field → message, 'form' for the whole form) in a dialog's form. */
function markErrors(formEl, errors) {
  for (const el of formEl.querySelectorAll('.field-error')) {
    el.textContent = errors[el.dataset.for] ?? '';
  }
  for (const el of formEl.querySelectorAll('input, select, textarea')) {
    if (errors[el.name]) el.setAttribute('aria-invalid', 'true');
    else el.removeAttribute('aria-invalid');
  }
  formEl.querySelector('.modal-error').textContent = errors.form ?? '';
}

function showErrors(errors) {
  markErrors(form, errors);
}

async function saveForm(event) {
  event.preventDefault();
  const { row, errors } = serviceFromForm(readForm(), { today: todayLocal(), previous: editing });
  if (row) {
    const clash = findNameConflict(state.services, row.name, editing?.id ?? null);
    if (clash) {
      errors.name = clash.archived_at
        ? `an archived service is named "${clash.name}". restore it instead.`
        : `you already have "${clash.name}".`;
    }
  }
  showErrors(errors);
  const firstBad = Object.keys(errors)[0];
  if (firstBad) {
    (firstBad === 'role' ? form.querySelector('[name="role"]') : field(firstBad)).focus();
    return;
  }

  const save = $('#svc-save');
  save.disabled = true;
  save.textContent = 'saving…';
  const previous = editing;
  dialogBusy = true;
  try {
    const saved = previous ? await db.updateService(previous.id, row) : await db.insertService(row);
    upsertLocal(saved);
    dialogBusy = false;
    closeForm();
    render();
    toast(previous ? `saved ${saved.name}` : `added ${saved.name}`);
  } catch (err) {
    $('#svc-error').textContent = err.message;
  } finally {
    dialogBusy = false;
    save.disabled = false;
    save.textContent = 'save';
  }
}

// ── archive / restore / delete (SPEC §8.4) ──────────────────────────────────

/** Archive (archived = true) or restore (false) the button's service. */
async function setArchived(button, archived) {
  const service = findService(button.dataset.id);
  if (!service) return;
  if (archived) {
    const { status } = serviceStatus(state.periodsByService.get(service.id) ?? [], todayLocal());
    if (!canArchive(status)) {
      toast('still renewing. mark it cancelled first.', { error: true });
      return;
    }
  }
  await busy(button, async () => {
    try {
      const saved = archived ? await db.archiveService(service.id) : await db.restoreService(service.id);
      upsertLocal(saved);
      render();
      toast(`${archived ? 'archived' : 'restored'} ${service.name}`);
    } catch (err) {
      toast(err.message, { error: true });
    }
  });
}

function openDelete(button) {
  const service = findService(button.dataset.id);
  if (!service?.archived_at) {
    toast('archive a service before deleting it.', { error: true });
    return;
  }
  deleting = service;
  $('#del-name').textContent = service.name;
  $('#del-confirm').value = '';
  $('#del-go').disabled = true;
  $('#del-error').textContent = '';
  $('#del-modal').classList.add('open');
  $('#del-confirm').focus();
}

function closeDelete() {
  if (dialogBusy) return;
  $('#del-modal').classList.remove('open');
  deleting = null;
}

// Both sides trimmed: a name saved with outer spaces (outside the form) must still be deletable.
const deleteTyped = () => deleting && $('#del-confirm').value.trim() === deleting.name.trim();

async function confirmDelete(event) {
  event.preventDefault();
  if (!deleteTyped()) return;
  const service = deleting;
  const go = $('#del-go');
  go.disabled = true;
  go.textContent = 'deleting…';
  dialogBusy = true;
  try {
    await db.deleteService(service.id);
    removeLocal(service.id);
    dialogBusy = false;
    closeDelete();
    if (location.hash !== '#/') location.hash = '#/';
    else render();
    toast(`deleted ${service.name}`);
  } catch (err) {
    $('#del-error').textContent = err.message;
    go.disabled = !deleteTyped();
  } finally {
    dialogBusy = false;
    go.textContent = 'delete forever';
  }
}

// ── dialogs for periods and charges ─────────────────────────────────────────

/**
 * Runs a dialog's save. The dialog stays open (dialogBusy) until the request ends,
 * so a failure is shown inside it. `fn` returns what to do once it has closed.
 */
async function submitDialog(modalId, button, busyLabel, fn) {
  const label = button.textContent;
  const errorEl = $(`#${modalId} .modal-error`);
  button.disabled = true;
  button.textContent = busyLabel;
  errorEl.textContent = '';
  dialogBusy = true;
  let after;
  try {
    after = await fn();
  } catch (err) {
    errorEl.textContent = err.message;
    return;
  } finally {
    dialogBusy = false;
    button.disabled = false;
    button.textContent = label;
  }
  CLOSERS[modalId]();
  after?.();
}

function openModal(id) {
  document.getElementById(id).classList.add('open');
}

/** False while a request is in flight: the dialog stays open to show how it ends. */
function closeModal(id) {
  if (dialogBusy) return false;
  document.getElementById(id).classList.remove('open');
  return true;
}

// ── mark subscribed (SPEC §7.3) ─────────────────────────────────────────────

const subForm = $('#sub-form');
const subField = (name) => subForm.elements.namedItem(name);
/** The service in the Mark subscribed dialog. */
let subscribing = null;
/** Once the user ticks or unticks "also set as current price", stop changing it for them. */
let setPriceTouched = false;

function openSubscribe(button) {
  const service = findService(button.dataset.id);
  if (!service) {
    toast('that service is gone. reload the page.', { error: true });
    return;
  }
  subscribing = service;
  setPriceTouched = false;
  const today = todayLocal();
  const values = subscribeDefaults(service, today);
  subField('date').value = values.date;
  subField('date').max = today;
  subField('amount').value = values.amount;
  subField('set_price').checked = values.set_price;
  $('#sub-title').textContent = `mark ${service.name} subscribed`;
  $('#sub-interval').textContent = service.billing_interval;
  markErrors(subForm, {});
  updateSubscribeHints();
  openModal('sub-modal');
  subField('date').focus();
}

function closeSubscribe() {
  if (closeModal('sub-modal')) subscribing = null;
}

function readSubscribe() {
  return { date: subField('date').value, amount: subField('amount').value, set_price: subField('set_price').checked };
}

function renewalHint({ period }, missed, today) {
  const renews = formatDay(period.renews_on, today);
  if (!missed.length) return `renews ${renews}.`;
  const n = missed.length;
  const span = n === 1 ? renews : `${renews} to ${formatDay(missed[n - 1], today)}`;
  return `${n} renewal${n === 1 ? '' : 's'} since (${span}). the app records ${n === 1 ? 'it' : 'them'} the next time it loads, unless you mark this period cancelled first.`;
}

/** Keeps the price option and the renewal hint in step with what's typed. */
function updateSubscribeHints() {
  const service = subscribing;
  if (!service) return;
  const today = todayLocal();
  const values = readSubscribe();
  const amount = parseCents(values.amount);
  const option = setPriceOption(service, amount.error ? null : amount.value);
  $('#sub-setprice').hidden = !option.show;
  if (!setPriceTouched) subField('set_price').checked = option.checked;
  $('#sub-price-now').textContent = service.price_cents == null ? 'unknown' : formatPrice(service);

  const { plan, missed } = subscribeFromForm(values, { service, periods: periodsOf(service.id), today });
  $('#sub-hint').textContent = plan ? renewalHint(plan, missed, today) : '';
}

function onSubscribeInput(event) {
  if (event.target.name === 'set_price') setPriceTouched = true;
  updateSubscribeHints();
}

async function saveSubscribe(event) {
  event.preventDefault();
  const service = subscribing;
  if (!service || dialogBusy) return;
  const { plan, setPrice, errors } = subscribeFromForm(readSubscribe(), {
    service, periods: periodsOf(service.id), today: todayLocal(),
  });
  markErrors(subForm, errors);
  const firstBad = Object.keys(errors).find((k) => k !== 'form');
  if (firstBad) subField(firstBad).focus();
  if (!plan) return;

  await submitDialog('sub-modal', $('#sub-save'), 'saving…', async () => {
    const saved = await db.markSubscribed(plan, setPrice);
    putRow(state.periodsByService, saved.period);
    putRow(state.chargesByService, saved.charge);
    upsertLocal(saved.service);
    return () => {
      render();
      toast(`marked ${service.name} subscribed`);
      // SPEC §9 rotate-in step 3: prompt to cancel auto-renew straight away.
      const prompt = cancelPrompt(service, saved.period, todayLocal());
      if (prompt) openCancel(findService(service.id) ?? service, { prompt });
    };
  });
}

// ── mark cancelled (SPEC §7.3) ──────────────────────────────────────────────

const cancelForm = $('#cancel-form');
const cancelField = (name) => cancelForm.elements.namedItem(name);
/** { service, period } in the Mark cancelled dialog. */
let cancelling = null;

/**
 * What to ask right after Mark subscribed, or null: a backfill with a pending
 * renewal (did it end back then?), or any rotator (cancel on day one, SPEC §9).
 */
function cancelPrompt(service, period, today) {
  if (renewalPending(period, today)) {
    return `did this period end? if you cancelled back then, record it now. otherwise the next load adds its renewals since ${formatDay(period.renews_on, today)}.`;
  }
  if (service.role === 'rotator') {
    return 'cancel auto-renew now? rotators get cancelled on day one: access runs to the end of the paid period.';
  }
  return null;
}

function promptManageHtml(service) {
  if (isWebUrl(service.manage_url)) {
    return `<a class="btn" href="${esc(service.manage_url)}" target="_blank" rel="noopener noreferrer">open manage page ↗</a>`;
  }
  if (service.manage_path) {
    return `<div class="manage-path"><span class="field-label">manage path</span>${esc(service.manage_path)}</div>`;
  }
  return '';
}

function openCancel(service, { prompt = null } = {}) {
  const period = openPeriod(periodsOf(service.id));
  if (!period) {
    toast('nothing to cancel: no period is renewing.', { error: true });
    return;
  }
  cancelling = { service, period };
  const today = todayLocal();
  const values = cancelDefaults(period, today);
  for (const name of ['cancelled_on', 'access_ends_on']) {
    cancelField(name).value = values[name];
    cancelField(name).min = period.started_on;
  }
  cancelField('cancelled_on').max = today;
  $('#cancel-title').textContent = `mark ${service.name} cancelled`;
  $('#cancel-prompt').hidden = !prompt;
  $('#cancel-prompt-text').textContent = prompt ?? '';
  $('#cancel-manage').innerHTML = prompt ? promptManageHtml(service) : '';
  $('#cancel-ends-hint').textContent = period.renews_on
    ? `the last day you can use it. the service's confirmation screen says; left blank, it's the day before the ${formatDay(period.renews_on, today)} charge.`
    : "the last day you can use it. the service's confirmation screen says.";
  markErrors(cancelForm, {});
  openModal('cancel-modal');
  cancelField('cancelled_on').focus();
}

function closeCancel() {
  if (closeModal('cancel-modal')) cancelling = null;
}

async function saveCancel(event) {
  event.preventDefault();
  if (!cancelling || dialogBusy) return;
  const { service, period } = cancelling;
  const today = todayLocal();
  const values = { cancelled_on: cancelField('cancelled_on').value, access_ends_on: cancelField('access_ends_on').value };
  const { row, errors } = cancelFromForm(values, { period, today });
  markErrors(cancelForm, errors);
  const firstBad = Object.keys(errors).find((k) => k !== 'form');
  if (firstBad) cancelField(firstBad).focus();
  if (!row) return;

  await submitDialog('cancel-modal', $('#cancel-save'), 'saving…', async () => {
    const saved = await db.cancelPeriod(period.id, row);
    putRow(state.periodsByService, saved);
    return () => {
      render();
      const ends = accessEnd(saved);
      toast(ends >= today ? `cancelled ${service.name} · active until ${formatDay(ends, today)}` : `cancelled ${service.name}`);
    };
  });
}

// ── edit charge (SPEC §8.3, §9 keeper renewal) ──────────────────────────────

const chgForm = $('#chg-form');
const chgField = (name) => chgForm.elements.namedItem(name);
/** { service, charge } in the Edit charge dialog. */
let editingCharge = null;
let chgSetPriceTouched = false;

function openEditCharge(button) {
  const service = findService(button.dataset.service);
  const charge = chargesOf(button.dataset.service).find((c) => c.id === button.dataset.id);
  if (!service || !charge) {
    toast('that charge is gone. reload the page.', { error: true });
    return;
  }
  editingCharge = { service, charge };
  chgSetPriceTouched = false;
  const today = todayLocal();
  const values = chargeDefaults(charge);
  chgField('charged_on').value = values.charged_on;
  chgField('charged_on').max = today;
  chgField('amount').value = values.amount;
  chgField('set_price').checked = values.set_price;
  $('#chg-title').textContent = `${service.name} charge, ${formatDay(charge.charged_on, today)}`;
  $('#chg-lead').textContent = charge.source === 'auto'
    ? 'recorded automatically on the renewal date, at the price on file. make it match your statement.'
    : 'make it match your statement.';
  markErrors(chgForm, {});
  updateChargeHints();
  openModal('chg-modal');
  chgField('amount').focus();
}

function closeEditCharge() {
  if (closeModal('chg-modal')) editingCharge = null;
}

function readCharge() {
  return { charged_on: chgField('charged_on').value, amount: chgField('amount').value, set_price: chgField('set_price').checked };
}

function updateChargeHints() {
  if (!editingCharge) return;
  const { service, charge } = editingCharge;
  const amount = parseCents(chgField('amount').value);
  const option = chargeSetPriceOption(charge, service, amount.error ? null : amount.value);
  $('#chg-setprice').hidden = !option.show;
  if (!chgSetPriceTouched) chgField('set_price').checked = option.checked;
  $('#chg-price-now').textContent = service.price_cents == null ? 'unknown' : formatPrice(service);
}

function onChargeInput(event) {
  if (event.target.name === 'set_price') chgSetPriceTouched = true;
  updateChargeHints();
}

/**
 * Saves the price first, then the charge. They aren't one transaction (SPEC §6
 * names only Mark subscribed and Delete period), so the order keeps a retry clean:
 * if the charge fails, saving again finds the price already set and only retries
 * the charge. A new price with an old charge amount is harmless meanwhile.
 */
async function saveCharge(event) {
  event.preventDefault();
  if (!editingCharge || dialogBusy) return;
  const { service, charge } = editingCharge;
  const { row, price, errors } = chargeFromForm(readCharge(), {
    charge, service, siblings: chargesOf(service.id), today: todayLocal(),
  });
  markErrors(chgForm, errors);
  const firstBad = Object.keys(errors).find((k) => k !== 'form');
  if (firstBad) {
    chgField(firstBad).focus();
    return;
  }
  if (!row && !price) {
    closeEditCharge();
    return;
  }

  await submitDialog('chg-modal', $('#chg-save'), 'saving…', async () => {
    if (price) {
      upsertLocal(await db.updateService(service.id, price, 'update the price'));
      editingCharge.service = findService(service.id);
    }
    if (row) {
      try {
        const saved = await db.updateCharge(charge.id, row);
        putRow(state.chargesByService, saved);
      } catch (err) {
        if (price) {
          render(); // show the new price behind the dialog
          updateChargeHints(); // the price is saved: a retry only needs the charge
          err.message = `price updated, but ${err.message}`;
        }
        throw err;
      }
    }
    return () => {
      render();
      toast(price ? `saved the charge and set ${service.name}'s price` : 'saved the charge');
    };
  });
}

// ── delete period (SPEC §8.3) ───────────────────────────────────────────────

/** { service, entry } in the Delete period dialog; entry is a periodHistory() entry. */
let deletingPeriod = null;

function totalText(charges) {
  const { cents, unknown } = chargeTotal(charges);
  const known = formatCents(cents);
  return unknown ? `${known} plus ${unknown} unknown` : known;
}

function openDeletePeriod(button) {
  const service = findService(button.dataset.service);
  const { periods } = periodHistory(periodsOf(button.dataset.service), chargesOf(button.dataset.service));
  const entry = periods.find((e) => e.period.id === button.dataset.id);
  if (!service || !entry) {
    toast('that period is gone. reload the page.', { error: true });
    return;
  }
  deletingPeriod = { service, entry };
  const today = todayLocal();
  const n = entry.charges.length;
  $('#delp-title').textContent = `delete ${service.name} period`;
  $('#delp-period').textContent = periodLabel(entry, today);
  $('#delp-count').textContent = n ? `and its ${n} charge${n === 1 ? '' : 's'} (${totalText(entry.charges)})` : '(it has no charges)';
  $('#delp-charges').innerHTML = entry.charges.map((c) => chargeHtml(c, today)).join('');
  $('#delp-error').textContent = '';
  openModal('delp-modal');
  $('#delp-go').focus();
}

function closeDeletePeriod() {
  if (closeModal('delp-modal')) deletingPeriod = null;
}

async function confirmDeletePeriod(event) {
  event.preventDefault();
  if (!deletingPeriod || dialogBusy) return;
  const { service, entry } = deletingPeriod;
  await submitDialog('delp-modal', $('#delp-go'), 'deleting…', async () => {
    const { period, charge_ids: gone } = await db.deletePeriod(entry.period.id);
    const removed = new Set(gone);
    state.periodsByService.set(service.id, periodsOf(service.id).filter((p) => p.id !== period.id));
    state.chargesByService.set(service.id, chargesOf(service.id).filter((c) => !removed.has(c.id) && c.period_id !== period.id));
    return () => {
      render();
      const n = gone.length;
      toast(n ? `deleted the period and its ${n} charge${n === 1 ? '' : 's'}` : 'deleted the period');
    };
  });
}

// ── events ──────────────────────────────────────────────────────────────────

const ACTIONS = {
  add: () => openForm(),
  edit: (el) => {
    const service = findService(el.dataset.id);
    if (service) openForm(service);
    else toast('that service is gone. reload the page.', { error: true });
  },
  'close-form': closeForm,
  'close-delete': closeDelete,
  'toggle-archived': () => {
    state.showArchived = !state.showArchived;
    render();
  },
  'load-starter': loadStarter,
  'dismiss-checklist': () => {
    setChecklistDismissed(true);
    render();
  },
  'show-checklist': () => {
    setChecklistDismissed(false);
    render();
  },
  archive: (el) => setArchived(el, true),
  restore: (el) => setArchived(el, false),
  subscribe: openSubscribe,
  'close-sub': closeSubscribe,
  cancel: (el) => {
    const service = findService(el.dataset.id);
    if (service) openCancel(service);
    else toast('that service is gone. reload the page.', { error: true });
  },
  'close-cancel': closeCancel,
  'delete-period': openDeletePeriod,
  'close-delp': closeDeletePeriod,
  'edit-charge': openEditCharge,
  'close-chg': closeEditCharge,
  delete: openDelete,
  reload: load,
};

document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-action]');
  if (el && !el.disabled && ACTIONS[el.dataset.action]) ACTIONS[el.dataset.action](el);
});

form.addEventListener('submit', saveForm);
$('#del-form').addEventListener('submit', confirmDelete);
subForm.addEventListener('submit', saveSubscribe);
subForm.addEventListener('input', onSubscribeInput);
subForm.addEventListener('change', onSubscribeInput);
cancelForm.addEventListener('submit', saveCancel);
$('#delp-form').addEventListener('submit', confirmDeletePeriod);
chgForm.addEventListener('submit', saveCharge);
chgForm.addEventListener('input', onChargeInput);
chgForm.addEventListener('change', onChargeInput);
$('#del-confirm').addEventListener('input', () => { $('#del-go').disabled = !deleteTyped(); });

window.addEventListener('hashchange', () => {
  // A dialog belongs to the view it was opened from. While its request is in
  // flight it stays open (dialogBusy) and closes itself when the request ends.
  for (const close of Object.values(CLOSERS)) close();
  render();
  window.scrollTo(0, 0);
});

// Close a dialog on a click that starts and ends on its backdrop, so selecting
// text in a field and releasing outside the dialog doesn't throw the form away.
const CLOSERS = {
  'svc-modal': closeForm, 'del-modal': closeDelete, 'sub-modal': closeSubscribe, 'cancel-modal': closeCancel,
  'delp-modal': closeDeletePeriod, 'chg-modal': closeEditCharge,
};
for (const [id, close] of Object.entries(CLOSERS)) {
  const overlay = document.getElementById(id);
  let downOnBackdrop = false;
  overlay.addEventListener('mousedown', (e) => { downOnBackdrop = e.target === overlay; });
  overlay.addEventListener('click', (e) => {
    if (downOnBackdrop && e.target === overlay) close();
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  for (const [id, close] of Object.entries(CLOSERS)) {
    if (document.getElementById(id).classList.contains('open')) close();
  }
});

// ── boot ────────────────────────────────────────────────────────────────────

fillSelects();

window.renderAuthGate(async (user) => {
  $('#auth-gate').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#nav-email').textContent = user.email;
  await load();
});
