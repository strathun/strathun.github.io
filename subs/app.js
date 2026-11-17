// Subscription tracker page (SPEC §8). The rules live in ./logic and are unit-tested;
// this file only loads rows, renders what the logic returns, and wires up events.
//
// This is a module, so its functions aren't globals: markup uses data-action
// attributes and one delegated click listener instead of onclick="…".

import { todayLocal, formatDay } from './logic/dates.js';
import { groupByService } from './logic/status.js';
import {
  CATEGORIES, INTERVALS, formatPrice, formValues, serviceFromForm,
  findNameConflict, groupServices, serviceBadges,
} from './logic/services.js';
import * as db from './db.js';

const state = {
  services: [],
  periodsByService: new Map(),
};

/** The service open in the form, or null when adding a new one. */
let editing = null;

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

// ── data ────────────────────────────────────────────────────────────────────

async function load() {
  try {
    const { services, periods } = await db.loadAll();
    state.services = services;
    state.periodsByService = groupByService(periods);
    render();
  } catch (err) {
    $('#services').innerHTML = `
      <div class="load-error">
        <p>${esc(err.message)}</p>
        <button class="btn" data-action="reload">try again</button>
      </div>`;
  }
}

function upsertLocal(row) {
  const i = state.services.findIndex((s) => s.id === row.id);
  if (i === -1) state.services.push(row);
  else state.services[i] = row;
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

function render() {
  const today = todayLocal();
  const groups = groupServices(state.services, state.periodsByService, today);
  const shown = GROUPS.filter(([key]) => groups[key].length);
  const count = state.services.length - groups.archived.length;
  $('#service-count').textContent = count ? String(count) : '';

  if (!state.services.length) {
    $('#services').innerHTML = `
      <div class="empty">
        <p>no services yet.</p>
        <p><button class="btn btn-primary" data-action="add">+ add service</button></p>
      </div>`;
    return;
  }
  if (!shown.length) {
    $('#services').innerHTML = `<div class="empty"><p>every service is archived.</p></div>`;
    return;
  }

  $('#services').innerHTML = shown
    .map(([key, label]) => `
      <section class="group">
        <h2 class="group-title">${label}<small>${groups[key].length}</small></h2>
        <ul class="service-list">${groups[key].map((entry) => rowHtml(entry, today)).join('')}</ul>
      </section>`)
    .join('');
}

function rowHtml({ service, status, accessEndsOn }, today) {
  const badges = serviceBadges(service, today)
    .map((a) => {
      const b = BADGES[a.type];
      return `<span class="badge ${b.cls}" title="${esc(b.title(a, today))}">${b.label}</span>`;
    })
    .join('');
  const role = `<span class="role-${esc(service.role)}">${esc(service.role)}</span>`;
  const sub = service.category ? `${role} · ${esc(service.category)}` : role;
  const until = status === 'ending'
    ? `<span class="row-until">until ${esc(formatDay(accessEndsOn, today))}</span>`
    : '';

  return `
    <li>
      <button class="service-row" data-action="edit" data-id="${esc(service.id)}">
        <span class="row-main">
          <span class="row-name">${esc(service.name)}</span>
          <span class="row-sub">${sub}</span>
        </span>
        <span class="row-side">
          <span class="row-price">${esc(formatPrice(service))}</span>${until}
        </span>
        ${badges ? `<span class="row-badges">${badges}</span>` : ''}
      </button>
    </li>`;
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
  const wasEditing = !!editing;
  try {
    const saved = wasEditing ? await db.updateService(editing.id, row) : await db.insertService(row);
    upsertLocal(saved);
    closeForm();
    render();
    toast(wasEditing ? `saved ${saved.name}` : `added ${saved.name}`);
  } catch (err) {
    $('#svc-error').textContent = err.message;
  } finally {
    save.disabled = false;
    save.textContent = 'save';
  }
}

// ── events ──────────────────────────────────────────────────────────────────

const ACTIONS = {
  add: () => openForm(),
  edit: (el) => {
    const service = state.services.find((s) => s.id === el.dataset.id);
    if (service) openForm(service);
    else toast('that service is gone. reload the page.', { error: true });
  },
  'close-form': closeForm,
  reload: load,
};

document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-action]');
  if (el && ACTIONS[el.dataset.action]) ACTIONS[el.dataset.action](el);
});

form.addEventListener('submit', saveForm);

// Close on a click that starts and ends on the backdrop, so selecting text in
// a field and releasing outside the modal doesn't throw the form away.
let downOnBackdrop = false;
$('#svc-modal').addEventListener('mousedown', (e) => { downOnBackdrop = e.target.id === 'svc-modal'; });
$('#svc-modal').addEventListener('click', (e) => {
  if (downOnBackdrop && e.target.id === 'svc-modal') closeForm();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#svc-modal').classList.contains('open')) closeForm();
});

// ── boot ────────────────────────────────────────────────────────────────────

fillSelects();

window.renderAuthGate(async (user) => {
  $('#auth-gate').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#nav-email').textContent = user.email;
  await load();
});
