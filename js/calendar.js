/**
 * calendar.js — DSM 2026 Schedule
 *
 * Renders a monthly calendar grid inside #monthly-calendar.
 * Session days are highlighted. Clicking a session day shows
 * the session detail in the right panel.
 *
 * Depends on: AppState, renderSessionDetail() (from schedule.js)
 */

'use strict';

// Current rendered month state
let calYear  = null;
let calMonth = null; // 0-indexed

/* ── Public: initial render ───────────────────────────────────
   Called from app.js after schedule is loaded.
──────────────────────────────────────────────────────────── */
function renderCalendar(schedule, timezone) {
  const now = new Date();
  calYear  = now.getFullYear();
  calMonth = now.getMonth();
  renderMonth(schedule, timezone, calYear, calMonth);
}

/* ── Internal: render a specific month ───────────────────────── */
function renderMonth(schedule, timezone, year, month) {
  calYear  = year;
  calMonth = month;

  const container = document.getElementById('monthly-calendar');
  if (!container) return;

  // Collect session dates (local to the user's timezone) for this month
  const sessionDateMap = buildSessionDateMap(schedule, timezone, year, month);

  // Month + year label
  const monthLabel = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' })
    .format(new Date(year, month, 1));

  // Today's YYYY-MM-DD in user timezone
  const todayStr = toLocalDateString(new Date(), timezone);

  // First weekday of month (0=Sun ... 6=Sat)
  const firstWeekday = new Date(year, month, 1).getDay();

  // Total days in month
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // Day-of-week headers
  const DAY_HEADERS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

  let html = `
    <div class="calendar-header">
      <button class="cal-nav-btn" id="cal-prev" aria-label="Previous month">&#8249;</button>
      <span>${monthLabel}</span>
      <button class="cal-nav-btn" id="cal-next" aria-label="Next month">&#8250;</button>
    </div>
    <div class="calendar-grid">
  `;

  // Day-of-week header row
  html += DAY_HEADERS.map(d => `<div class="calendar-day-header">${d}</div>`).join('');

  // Empty cells before the 1st
  for (let i = 0; i < firstWeekday; i++) {
    html += `<div class="calendar-day empty"></div>`;
  }

  // Day cells
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = toDateString(year, month + 1, d); // YYYY-MM-DD
    const hasSession = sessionDateMap.has(dateStr);
    const isToday    = dateStr === todayStr;

    const sessions   = sessionDateMap.get(dateStr) || [];
    const topicTitle = sessions.map(s => s.topic).join(' | ');

    // Determine if this day holds the currently displayed session
    const isSelected = AppState.currentSession &&
      toLocalDateString(AppState.currentSession.startUTC, timezone) === dateStr;

    const classes = [
      'calendar-day',
      isToday    ? 'today'          : '',
      hasSession ? 'has-session'    : '',
      isSelected ? 'selected-session' : '',
    ].filter(Boolean).join(' ');

    const title = topicTitle ? ` title="${escapeAttr(topicTitle)}"` : '';
    const dataDate = hasSession ? ` data-date="${dateStr}"` : '';

    html += `<div class="${classes}"${dataDate}${title}>${d}</div>`;
  }

  html += `</div>`; // .calendar-grid

  container.innerHTML = html;

  // Navigation
  container.querySelector('#cal-prev').addEventListener('click', () => {
    const prev = month === 0
      ? { y: year - 1, m: 11 }
      : { y: year,     m: month - 1 };
    renderMonth(AppState.schedule, AppState.timezone, prev.y, prev.m);
  });

  container.querySelector('#cal-next').addEventListener('click', () => {
    const next = month === 11
      ? { y: year + 1, m: 0 }
      : { y: year,     m: month + 1 };
    renderMonth(AppState.schedule, AppState.timezone, next.y, next.m);
  });

  // Click session day → show first session of that day in right panel
  container.querySelectorAll('.calendar-day.has-session').forEach(cell => {
    cell.addEventListener('click', () => {
      const dateStr = cell.dataset.date;
      const sessions = sessionDateMap.get(dateStr);
      if (sessions && sessions.length > 0) {
        renderSessionDetail(sessions[0]);
        // Re-render calendar to update selected-session highlight
        renderMonth(AppState.schedule, AppState.timezone, calYear, calMonth);
      }
    });
  });
}

/* ── Public: re-render after timezone change ─────────────────── */
function refreshCalendar() {
  if (calYear !== null && calMonth !== null) {
    renderMonth(AppState.schedule, AppState.timezone, calYear, calMonth);
  }
}

/* ── Build a Map of dateStr → [session, ...] for the given month ─ */
function buildSessionDateMap(schedule, timezone, year, month) {
  const map = new Map();

  schedule.forEach(session => {
    const localStr = toLocalDateString(session.startUTC, timezone);
    const [y, m] = localStr.split('-').map(Number);

    // Only include sessions in the target month
    if (y === year && m === month + 1) {
      if (!map.has(localStr)) map.set(localStr, []);
      map.get(localStr).push(session);
    }
  });

  return map;
}

/* ── Utility: convert a Date to YYYY-MM-DD in the given timezone ─
   Uses en-CA locale which reliably produces YYYY-MM-DD format.
──────────────────────────────────────────────────────────── */
function toLocalDateString(date, timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year:  'numeric',
    month: '2-digit',
    day:   '2-digit',
  }).format(date);
}

/* ── Utility: build YYYY-MM-DD from components ───────────────── */
function toDateString(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/* ── Utility: attribute-safe HTML escaping ───────────────────── */
function escapeAttr(str) {
  return String(str).replace(/"/g, '&quot;');
}
