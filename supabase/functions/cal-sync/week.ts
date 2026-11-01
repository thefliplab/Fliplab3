// @ts-nocheck — generated copy of /week.js; do not edit here
// FlipLab 3.0 shared week logic — used by index.html AND the cal-sync edge function (supabase/functions/cal-sync/week.ts is a copy + exports).
// Change it here, then re-copy to the edge function (see supabase/functions/cal-sync/README.md).
const runsBetween = (l, from, to) => { const st = l.start_date && l.start_date > from ? l.start_date : from; return (!l.end_date || l.end_date > st) && (!to || !l.start_date || l.start_date <= to); };
const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
function timeVal(t) {
  const m = String(t || '').trim().match(/^(\d{1,2}):?(\d{2})?\s*([AaPp])?/); if (!m) return 9999;
  let h = +m[1] % 12; if (m[3] && /p/i.test(m[3])) h += 12; return h * 60 + (+m[2] || 0);
}
const PRICING = { Solo: { '30 min': '$40', '45 min': '$60', '60 min': '$80' }, Shared: { '30 min': '$30', '45 min': '$45', '60 min': '$60' } };
const priceFor = (dur, type) => (PRICING[type] || PRICING.Solo)[dur] || (PRICING[type] || PRICING.Solo)['30 min'];
const isSpecial = p => (p.extra || {}).SpecialPrice === 'Yes';
function applyExceptions(lessons, exs) {
  const map = {}, addRows = [], attached = {}, out = [];
  exs.forEach(e => { if (e.lesson_id) map[e.lesson_id] = e; if (e.type === 'Add') addRows.push(e); });
  lessons.forEach(src => {
    const p = { ...src, exType: '', bday: src.day, btime: src.time }, ex = map[p.id];
    if (!ex) return out.push(p);
    if (ex.type === 'Cancel') return out.push({ ...p, status: 'Cancelled', exType: 'Cancel' });
    if (ex.type === 'Move') {
      out.push({ ...p, status: 'Cancelled', exType: 'MoveOrigin' });
      attached[ex.id] = true;
      return out.push({ ...p, day: ex.new_day || p.day, time: ex.new_time || p.time, coach: ex.new_coach || p.coach, exType: 'Move' });
    }
    if (ex.type === 'PriceOverride') return out.push({ ...p, lesson_type: ex.lesson_type || 'Solo', price: priceFor(p.duration || '30 min', ex.lesson_type || 'Solo'), exType: 'PriceOverride' });
    if (ex.type === 'Add') {
      out.push(p); attached[ex.id] = true;
      return out.push({ ...p, id: p.id + '_EX_' + ex.id, day: ex.new_day || p.day, time: ex.new_time || p.time, coach: ex.new_coach || p.coach, exType: 'Add' });
    }
    out.push(p);
  });
  addRows.forEach(e => {
    if (attached[e.id]) return;
    out.push({ id: 'EX_ONLY_' + e.id, student_id: e.student_id, student_name: e.student_name, coach: e.new_coach || e.coach,
      day: e.new_day || '', time: e.new_time || '', bday: e.new_day || '', btime: e.new_time || '', duration: '30 min', status: 'Confirmed', lesson_type: e.lesson_type || 'Solo',
      notes: e.notes, pair_id: '', exType: 'Add', ...((e.extra || {}).Price ? { price: e.extra.Price, extra: { SpecialPrice: 'Yes' } } : {}) });
  });
  // Auto "Shared" when 2+ active lessons share a day+time with the same coach (unless a PriceOverride kept it Solo)
  const cnt = {};
  out.forEach(p => { if (p.status !== 'Cancelled') { const k = p.day + '|' + p.time + '|' + (p.coach || ''); cnt[k] = (cnt[k] || 0) + 1; } });
  // Same as 2.0 getPrivates: a shared slot always uses the Shared price (stored price is ignored)
  out.forEach(p => { if (p.status !== 'Cancelled' && p.exType !== 'PriceOverride' && cnt[p.day + '|' + p.time + '|' + (p.coach || '')] >= 2) { p.lesson_type = 'Shared'; if (!isSpecial(p)) p.price = priceFor(p.duration || '30 min', 'Shared'); } });
  return out;
}

// One week's lessons as they really are: weekly lessons running that week + that week's changes (Cancel / Move / Add / PriceOverride).
// lessons = private_lessons not Cancelled/Dropped; exs = schedule_exceptions for week_start ws not Deleted/Expired; we = Sunday of the week.
function buildWeek(lessons, exs, ws, we) {
  const base = lessons.filter(p => !(p.start_date && p.start_date > we) && !(p.end_date && p.end_date <= ws));
  return applyExceptions(base, exs);
}
export { applyExceptions, buildWeek, timeVal, DAYS, runsBetween, priceFor, isSpecial };
