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
import { groupByService, serviceStatus } from './logic/status.js';
import {
  CATEGORIES, INTERVALS, formatPrice, formValues, serviceFromForm,
  findNameConflict, groupServices, serviceBadges, canArchive, isWebUrl, setupProgress,
} from './logic/services.js';
import { starterRows } from './logic/starter.js';
import * as db from './db.js';

const state = {
  loaded: false,
  services: [],
  periodsByService: new Map(),
  showArchived: false,
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
  state.services = data.services;
  state.periodsByService = groupByService(data.periods);
  state.loaded = true;
  render();
}

function upsertLocal(row) {
  const i = state.services.findIndex((s) => s.id === row.id);
  if (i === -1) state.services.push(row);
  else state.services[i] = row;
}

function removeLocal(id) {
  state.services = state.services.filter((s) => s.id !== id);
  state.periodsByService.delete(id);
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
  const later = '<span class="later">arrives in step 4</span>';
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
          ${later}
        </li>
        <li>for rotators you've already cancelled (or cancel now), mark cancelled. ${later}</li>
        <li>optional: backfill earlier rotations this year, so the year view and averages cover the whole year. ${later}</li>
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
  const status = serviceStatus(state.periodsByService.get(service.id) ?? [], today);
  const badges = badgesHtml(service, today);
  const lead = service.cancel_lead_days;

  let actions;
  if (service.archived_at) {
    actions = `
      <button class="btn" data-action="restore" data-id="${esc(service.id)}">restore</button>
      <button class="btn btn-danger" data-action="delete" data-id="${esc(service.id)}">delete permanently…</button>`;
  } else {
    const allowed = canArchive(status.status);
    actions = `
      <button class="btn" data-action="edit" data-id="${esc(service.id)}">edit</button>
      <button class="btn" data-action="archive" data-id="${esc(service.id)}" ${allowed ? '' : 'disabled aria-describedby="archive-hint"'}>archive</button>
      ${allowed ? '' : `<p class="muted small" id="archive-hint">still renewing. mark it cancelled before archiving, so its charges can't continue unseen.</p>`}`;
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
    </article>`;
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

function showErrors(errors) {
  for (const el of form.querySelectorAll('.field-error')) {
    el.textContent = errors[el.dataset.for] ?? '';
  }
  for (const el of form.querySelectorAll('input, select, textarea')) {
    if (errors[el.name]) el.setAttribute('aria-invalid', 'true');
    else el.removeAttribute('aria-invalid');
  }
  $('#svc-error').textContent = '';
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
  delete: openDelete,
  reload: load,
};

document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-action]');
  if (el && !el.disabled && ACTIONS[el.dataset.action]) ACTIONS[el.dataset.action](el);
});

form.addEventListener('submit', saveForm);
$('#del-form').addEventListener('submit', confirmDelete);
$('#del-confirm').addEventListener('input', () => { $('#del-go').disabled = !deleteTyped(); });

window.addEventListener('hashchange', () => {
  // A dialog belongs to the view it was opened from. While its request is in
  // flight it stays open (dialogBusy) and closes itself when the request ends.
  closeForm();
  closeDelete();
  render();
  window.scrollTo(0, 0);
});

// Close a dialog on a click that starts and ends on its backdrop, so selecting
// text in a field and releasing outside the dialog doesn't throw the form away.
const CLOSERS = { 'svc-modal': closeForm, 'del-modal': closeDelete };
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
