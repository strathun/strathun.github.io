// "Next up" suggestion (SPEC §7.7): which inactive rotator to bring back next.

import { groupByService, serviceStatus } from './status.js';

/** Blank available_from means "available now", so it sorts before any date. */
function earliest(items) {
  let best;
  for (const { available_from } of items) {
    const v = available_from ?? '';
    if (best === undefined || v < best) best = v;
  }
  return best;
}

function better(a, b) {
  if (a.openCount !== b.openCount) return a.openCount > b.openCount;
  if (a.sortDate !== b.sortDate) return a.sortDate < b.sortDate;
  return a.service.name.localeCompare(b.service.name, 'en', { sensitivity: 'base' }) < 0;
}

/** { service, openCount, earliestAvailableFrom } or null when nothing qualifies. */
export function nextUp({ services, periods, watchlist, today }) {
  const periodsByService = groupByService(periods);
  const openByService = groupByService(watchlist.filter((w) => w.done_at == null));

  let best = null;
  for (const service of services) {
    if (service.archived_at || service.role !== 'rotator') continue;
    const open = openByService.get(service.id);
    if (!open) continue;
    if (serviceStatus(periodsByService.get(service.id) ?? [], today).status !== 'inactive') continue;

    const candidate = { service, openCount: open.length, sortDate: earliest(open) };
    if (!best || better(candidate, best)) best = candidate;
  }

  if (!best) return null;
  return { service: best.service, openCount: best.openCount, earliestAvailableFrom: best.sortDate || null };
}
