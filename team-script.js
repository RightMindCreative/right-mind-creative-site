const login = document.querySelector('[data-login]');
const loginForm = login.querySelector('form');
const loginError = document.querySelector('[data-login-error]');
const app = document.querySelector('[data-app]');
const calendar = document.querySelector('[data-calendar]');
const monthLabel = document.querySelector('[data-month-label]');
const summary = document.querySelector('[data-summary]');
const requestList = document.querySelector('[data-request-list]');
const mineList = document.querySelector('[data-mine-list]');
const requestCount = document.querySelector('[data-request-count]');
const dialog = document.querySelector('[data-session-dialog]');
const dialogDetail = document.querySelector('[data-session-detail]');

let sessions = [];
let selectedId = '';
let activeView = 'calendar';
let visibleDate = new Date();
visibleDate = new Date(visibleDate.getFullYear(), visibleDate.getMonth(), visibleDate.getDate());
let calendarMode = window.matchMedia('(max-width: 620px)').matches ? 'day' : 'month';

const escapeHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const formatDate = (value, options = {}) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', ...options }).format(new Date(`${value}T12:00:00`));
const formatTime = (value) => {
  if (!value) return 'Flexible';
  if (/AM|PM/i.test(value)) return value;
  const [hour, minute] = value.split(':').map(Number);
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(2026, 0, 1, hour, minute));
};
const statusClass = (status) => status === 'confirmed' ? 'confirmed' : ['approved', 'payment_pending'].includes(status) ? 'approved' : 'pending';
const assignmentLabel = (assignment) => ({
  requested_owner: 'Ryan requested you', requested_employee: 'request sent to Ryan',
  accepted: 'assigned to you', declined: 'you declined', cancelled: 'cancelled',
}[assignment?.state] || 'open');
const dateKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const startOfWeek = (date) => {
  const start = new Date(date);
  start.setDate(date.getDate() - date.getDay());
  return start;
};

const request = async (url, options) => {
  const response = await fetch(url, options);
  const type = response.headers.get('content-type') || '';
  const payload = type.includes('application/json') ? await response.json() : { error: await response.text() };
  if (response.status === 401) { showLogin(); throw new Error('Please sign in again.'); }
  if (!response.ok) throw new Error(payload.error || 'Something went wrong.');
  return payload;
};

const showLogin = () => { document.body.classList.add('is-login'); login.hidden = false; app.hidden = true; };
const showApp = () => { document.body.classList.remove('is-login'); login.hidden = true; app.hidden = false; };

const renderSummary = () => {
  const pendingRequests = sessions.filter((item) => item.assignment?.state === 'requested_owner').length;
  const mine = sessions.filter((item) => item.assignment?.state === 'accepted').length;
  const confirmed = sessions.filter((item) => item.status === 'confirmed' && item.assignment?.state === 'accepted').length;
  summary.innerHTML = [
    [pendingRequests, 'need response'], [mine, 'my sessions'], [confirmed, 'confirmed'],
  ].map(([value, label]) => `<article class="summary-card"><span>${label}</span><strong>${value}</strong></article>`).join('');
  requestCount.textContent = pendingRequests;
};

const eventButton = (session) => `<button type="button" class="calendar-event is-${statusClass(session.status)} ${session.assignment?.state === 'accepted' ? 'is-mine' : ''}" data-session="${escapeHtml(session.id)}"><strong>${escapeHtml(formatTime(session.preferredTime))} · ${escapeHtml(session.artistName)}</strong><small>${escapeHtml(session.service)} · ${escapeHtml(assignmentLabel(session.assignment))}</small></button>`;

const calendarDay = (day, month = day.getMonth()) => {
  const key = dateKey(day);
  const todayKey = dateKey(new Date());
  const daySessions = sessions.filter((session) => session.preferredDate === key);
  const emptyMessage = calendarMode === 'day' && !daySessions.length ? '<p class="calendar-empty">No sessions scheduled for this day.</p>' : '';
  return `<div class="calendar-day ${day.getMonth() !== month ? 'is-outside' : ''} ${key === todayKey ? 'is-today' : ''} ${daySessions.length ? 'has-events' : ''}"><span class="day-number"><b>${day.toLocaleDateString('en-US', { weekday: 'short' })}</b>${day.getDate()}</span><div class="day-events">${daySessions.map(eventButton).join('')}${emptyMessage}</div></div>`;
};

const renderCalendar = () => {
  calendar.dataset.mode = calendarMode;
  document.querySelectorAll('[data-calendar-mode]').forEach((button) => button.classList.toggle('is-active', button.dataset.calendarMode === calendarMode));
  let html = '';

  if (calendarMode === 'day') {
    monthLabel.textContent = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).format(visibleDate);
    html = calendarDay(visibleDate);
  } else if (calendarMode === 'week') {
    const weekStart = startOfWeek(visibleDate);
    const weekEnd = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 6);
    const startLabel = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(weekStart);
    const endLabel = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(weekEnd);
    monthLabel.textContent = `${startLabel} — ${endLabel}`;
    html = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => `<div class="calendar-weekday">${day}</div>`).join('');
    for (let index = 0; index < 7; index += 1) {
      const day = new Date(weekStart); day.setDate(weekStart.getDate() + index);
      html += calendarDay(day);
    }
  } else {
    const year = visibleDate.getFullYear();
    const month = visibleDate.getMonth();
    const first = new Date(year, month, 1);
    const gridStart = new Date(year, month, 1 - first.getDay());
    monthLabel.textContent = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(first);
    html = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => `<div class="calendar-weekday">${day}</div>`).join('');
    for (let index = 0; index < 42; index += 1) {
      const day = new Date(gridStart); day.setDate(gridStart.getDate() + index);
      html += calendarDay(day, month);
    }
  }
  calendar.innerHTML = html;
};

const listCard = (session) => `<button type="button" class="session-list-card" data-session="${escapeHtml(session.id)}"><span>${escapeHtml(formatDate(session.preferredDate))}<br>${escapeHtml(formatTime(session.preferredTime))}</span><div><strong>${escapeHtml(session.artistName)}</strong><p>${escapeHtml(session.service)} · ${escapeHtml(session.serviceOption || '')}</p></div><div><span>${escapeHtml(assignmentLabel(session.assignment))}</span>${session.assignment?.requestNote ? `<p>${escapeHtml(session.assignment.requestNote)}</p>` : ''}</div><b>view ↗︎</b></button>`;

const renderLists = () => {
  const requests = sessions.filter((item) => ['requested_owner', 'requested_employee'].includes(item.assignment?.state));
  const mine = sessions.filter((item) => item.assignment?.state === 'accepted');
  requestList.innerHTML = requests.length ? requests.map(listCard).join('') : '<p class="session-message">No scheduling requests are waiting right now.</p>';
  mineList.innerHTML = mine.length ? mine.map(listCard).join('') : '<p class="session-message">Accepted sessions will appear here.</p>';
};

const detailField = (label, value, link = '') => value ? `<div class="session-detail-field"><span>${label}</span>${link ? `<a href="${link}">${escapeHtml(value)}</a>` : `<p>${escapeHtml(value)}</p>`}</div>` : '';
const openSession = (id) => {
  const session = sessions.find((item) => item.id === id); if (!session) return;
  selectedId = id;
  const assignment = session.assignment;
  const accepted = assignment?.state === 'accepted';
  const ownerRequest = assignment?.state === 'requested_owner';
  const canRequest = !assignment || ['declined', 'cancelled'].includes(assignment.state);
  dialogDetail.innerHTML = `<button type="button" class="session-dialog-close" data-close aria-label="Close">×</button>
    <p class="team-kicker">${escapeHtml(formatDate(session.preferredDate))} · ${escapeHtml(formatTime(session.preferredTime))}</p>
    <h2>${escapeHtml(session.artistName)}<br><em>${escapeHtml(session.service)}</em></h2>
    <div class="session-pills"><span>${escapeHtml(session.status)}</span><span>${escapeHtml(session.serviceOption || 'length flexible')}</span><span>${escapeHtml(assignmentLabel(assignment))}</span></div>
    <div class="session-detail-grid">${detailField('Date', formatDate(session.preferredDate))}${detailField('Time', formatTime(session.preferredTime))}${detailField('Service', session.service)}${detailField('Length', session.serviceOption)}${accepted ? detailField('Email', session.contact?.email, `mailto:${session.contact?.email}`) : ''}${accepted ? detailField('Phone', session.contact?.phone, `tel:${session.contact?.phone}`) : ''}${accepted && session.notes ? `<div class="session-detail-field is-wide"><span>Application notes</span><p>${escapeHtml(session.notes)}</p></div>` : ''}${assignment?.requestNote ? `<div class="session-detail-field is-wide"><span>${assignment.requestedBy === 'owner' ? 'Ryan’s note' : 'Your request note'}</span><p>${escapeHtml(assignment.requestNote)}</p></div>` : ''}</div>
    ${ownerRequest || canRequest ? `<label class="assignment-note"><span>${ownerRequest ? 'Optional response note' : 'Why would you like to run it? (optional)'}</span><textarea data-action-note></textarea></label>` : ''}
    <div class="session-actions">${ownerRequest ? '<button class="session-action" data-action="accept">accept session <b>✓</b></button><button class="session-action is-secondary" data-action="decline">decline <b>×</b></button>' : ''}${canRequest ? '<button class="session-action" data-action="request">request to run <b>↗︎</b></button>' : ''}</div>
    <p class="session-message" data-dialog-message>${accepted ? 'You are responsible for this session. Contact details are now available above.' : assignment?.state === 'requested_employee' ? 'Ryan will see your request in the owner dashboard.' : 'Pending applications are not confirmed bookings until the deposit is paid.'}</p>`;
  dialog.showModal();
};

const render = () => { renderSummary(); renderCalendar(); renderLists(); };
const load = async () => { const payload = await request('/api/employee/schedule'); sessions = payload.sessions || []; render(); };
const setView = (view) => {
  activeView = view;
  document.querySelectorAll('[data-view]').forEach((section) => { section.hidden = section.dataset.view !== view; });
  document.querySelectorAll('[data-view-button]').forEach((button) => button.classList.toggle('is-active', button.dataset.viewButton === view));
};

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault(); loginError.textContent = '';
  const button = loginForm.querySelector('button'); button.disabled = true; button.textContent = 'opening…';
  try { await request('/api/employee/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: loginForm.elements.password.value }) }); showApp(); setView('calendar'); await load(); }
  catch (error) { loginError.textContent = error.message; }
  finally { button.disabled = false; button.innerHTML = 'open schedule <b>↗︎</b>'; }
});

document.addEventListener('click', (event) => {
  const viewButton = event.target.closest('[data-view-button]'); if (viewButton) setView(viewButton.dataset.viewButton);
  const sessionButton = event.target.closest('[data-session]'); if (sessionButton) openSession(sessionButton.dataset.session);
  const modeButton = event.target.closest('[data-calendar-mode]'); if (modeButton) { calendarMode = modeButton.dataset.calendarMode; renderCalendar(); }
  const periodButton = event.target.closest('[data-period]');
  if (periodButton) {
    const direction = Number(periodButton.dataset.period);
    if (calendarMode === 'month') visibleDate = new Date(visibleDate.getFullYear(), visibleDate.getMonth() + direction, 1);
    else visibleDate.setDate(visibleDate.getDate() + direction * (calendarMode === 'week' ? 7 : 1));
    renderCalendar();
  }
  if (event.target.closest('[data-today]')) { const now = new Date(); visibleDate = new Date(now.getFullYear(), now.getMonth(), now.getDate()); renderCalendar(); }
  if (event.target.closest('[data-close]')) dialog.close();
});

dialog.addEventListener('click', async (event) => {
  if (event.target === dialog) { dialog.close(); return; }
  const actionButton = event.target.closest('[data-action]'); if (!actionButton || !selectedId) return;
  const message = dialog.querySelector('[data-dialog-message]');
  const note = dialog.querySelector('[data-action-note]')?.value || '';
  dialog.querySelectorAll('[data-action]').forEach((button) => { button.disabled = true; });
  message.textContent = 'saving response…';
  try { await request('/api/employee/assignments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ applicationId: selectedId, action: actionButton.dataset.action, note }) }); await load(); dialog.close(); }
  catch (error) { message.textContent = error.message; dialog.querySelectorAll('[data-action]').forEach((button) => { button.disabled = false; }); }
});

document.querySelector('[data-logout]').addEventListener('click', async () => { await fetch('/api/employee/session', { method: 'DELETE' }); showLogin(); });

window.setInterval(() => {
  if (!document.hidden && !app.hidden && !dialog.open) load().catch(() => {});
}, 60000);

(async () => { const session = await fetch('/api/employee/session').then((response) => response.json()).catch(() => ({ authenticated: false })); if (!session.authenticated) return showLogin(); showApp(); setView(activeView); load().catch(() => showLogin()); })();
