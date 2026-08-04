const loginView = document.querySelector("[data-login]");
const loginForm = loginView.querySelector("form");
const loginError = loginView.querySelector(".login-error");
const appView = document.querySelector("[data-app]");
const list = document.querySelector("[data-list]");
const previousList = document.querySelector("[data-previous-list]");
const detail = document.querySelector("[data-detail]");
const count = document.querySelector("[data-count]");
const logout = document.querySelector("[data-logout]");
const decisionDialog = document.querySelector("[data-decision-dialog]");
const decisionDialogTitle = decisionDialog.querySelector("[data-confirm-title]");
const decisionDialogCopy = decisionDialog.querySelector("[data-confirm-copy]");
const decisionConfirm = decisionDialog.querySelector("[data-confirm-decision]");
const customDepositField = decisionDialog.querySelector("[data-custom-deposit]");
const customDepositInput = decisionDialog.querySelector("[data-custom-deposit-input]");
const bookingDialog = document.querySelector("[data-booking-dialog]");
const bookingDialogTitle = bookingDialog.querySelector("[data-booking-title]");
const bookingDialogCopy = bookingDialog.querySelector("[data-booking-copy]");
const bookingOptions = bookingDialog.querySelector("[data-booking-options]");
const bookingReschedule = bookingDialog.querySelector("[data-booking-reschedule]");
const bookingMessage = bookingDialog.querySelector("[data-booking-message]");
const passcodeInput = loginForm.elements.password;
const views = [...document.querySelectorAll("[data-view]")];
const routeButtons = [...document.querySelectorAll("[data-route]")];
const dashboardStats = document.querySelector("[data-dashboard-stats]");
const recentActivity = document.querySelector("[data-recent]");
const artistList = document.querySelector("[data-artist-list]");
const artistDetail = document.querySelector("[data-artist-detail]");
const artistSearch = document.querySelector("[data-artist-search]");
const artistDialog = document.querySelector("[data-artist-dialog]");
const artistForm = document.querySelector("[data-artist-form]");
const artistFormError = document.querySelector("[data-artist-error]");
const artistDialogKicker = document.querySelector("[data-artist-dialog-kicker]");
const artistDialogTitle = document.querySelector("[data-artist-dialog-title]");
const calendarImportButton = document.querySelector("[data-import-calendar]");
const calendarImportStatus = document.querySelector("[data-import-calendar-status]");
const adminCalendar = document.querySelector("[data-admin-calendar]");
const adminCalendarLabel = document.querySelector("[data-admin-calendar-label]");
const adminCalendarSummary = document.querySelector("[data-admin-calendar-summary]");

let applications = [];
let artists = [];
let calendarSessions = [];
let selectedId = "";
let selectedArtistId = "";
let editingArtistId = "";
let currentArtist = null;
let currentApplication = null;
let activeView = "dashboard";
let pendingDecision = "";
let adminCalendarDate = new Date();
adminCalendarDate = new Date(adminCalendarDate.getFullYear(), adminCalendarDate.getMonth(), adminCalendarDate.getDate());
let adminCalendarMode = window.matchMedia("(max-width: 620px)").matches ? "day" : "month";
const mobileReview = window.matchMedia("(max-width: 900px)");

const escapeHtml = (value) => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

const formatDate = (value, options = {}) => {
  if (!value) return "Not provided";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T12:00:00`)
    : new Date(value);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...options,
  }).format(date);
};

const formatTime = (value) => {
  if (!value) return "Flexible";
  if (/^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(value)) return value;
  const [hours, minutes] = value.split(":").map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return value;
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(2026, 0, 1, hours, minutes));
};

const adminCalendarDateKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const adminCalendarStatus = (status) => status === "confirmed"
  ? "confirmed"
  : ["approved", "payment_pending"].includes(status) ? "approved" : "pending";
const adminStartOfWeek = (date) => {
  const start = new Date(date);
  start.setDate(date.getDate() - date.getDay());
  return start;
};

const adminCalendarEvent = (session) => {
  const assigned = session.assignment?.state === "accepted";
  const label = `${formatTime(session.preferredTime)} · ${session.artistName} · ${session.service}`;
  return `<button type="button" class="admin-calendar-event is-${adminCalendarStatus(session.status)} ${assigned ? "is-assigned" : ""}" data-admin-session="${escapeHtml(session.id)}" aria-label="${escapeHtml(label)}"><strong>${escapeHtml(formatTime(session.preferredTime))} · ${escapeHtml(session.artistName)}</strong><small>${escapeHtml(session.service)}${assigned ? " · Jake" : ""}</small></button>`;
};

const adminCalendarDay = (day, month = day.getMonth()) => {
  const key = adminCalendarDateKey(day);
  const daySessions = calendarSessions.filter((session) => session.preferredDate === key);
  const empty = adminCalendarMode === "day" && !daySessions.length ? `<p class="admin-calendar-empty">No sessions scheduled for this day.</p>` : "";
  return `<div class="admin-calendar-day ${day.getMonth() !== month ? "is-outside" : ""} ${key === adminCalendarDateKey(new Date()) ? "is-today" : ""} ${daySessions.length ? "has-events" : ""}"><span class="admin-day-number"><b>${day.toLocaleDateString("en-US", { weekday: "short" })}</b>${day.getDate()}</span><div class="admin-day-events">${daySessions.map(adminCalendarEvent).join("")}${empty}</div></div>`;
};

const renderAdminCalendar = () => {
  if (!adminCalendar) return;
  adminCalendar.dataset.mode = adminCalendarMode;
  document.querySelectorAll("[data-admin-calendar-mode]").forEach((button) => button.classList.toggle("is-active", button.dataset.adminCalendarMode === adminCalendarMode));
  let html = "";
  if (adminCalendarMode === "day") {
    adminCalendarLabel.textContent = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(adminCalendarDate);
    html = adminCalendarDay(adminCalendarDate);
  } else if (adminCalendarMode === "week") {
    const weekStart = adminStartOfWeek(adminCalendarDate);
    const weekEnd = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 6);
    adminCalendarLabel.textContent = `${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(weekStart)} — ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(weekEnd)}`;
    html = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((name) => `<div class="admin-calendar-weekday">${name}</div>`).join("");
    for (let index = 0; index < 7; index += 1) { const day = new Date(weekStart); day.setDate(weekStart.getDate() + index); html += adminCalendarDay(day); }
  } else {
    const year = adminCalendarDate.getFullYear();
    const month = adminCalendarDate.getMonth();
    const first = new Date(year, month, 1);
    const gridStart = new Date(year, month, 1 - first.getDay());
    adminCalendarLabel.textContent = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(first);
    html = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((name) => `<div class="admin-calendar-weekday">${name}</div>`).join("");
    for (let index = 0; index < 42; index += 1) { const day = new Date(gridStart); day.setDate(gridStart.getDate() + index); html += adminCalendarDay(day, month); }
  }
  adminCalendar.innerHTML = html;
  const confirmed = calendarSessions.filter((session) => session.status === "confirmed").length;
  const pending = calendarSessions.filter((session) => !["confirmed", "approved", "payment_pending"].includes(session.status)).length;
  const assigned = calendarSessions.filter((session) => session.assignment?.state === "accepted").length;
  adminCalendarSummary.innerHTML = [[calendarSessions.length, "active sessions"], [confirmed, "confirmed"], [pending, "pending"], [assigned, "Jake assigned"]].map(([value, label]) => `<article><span>${label}</span><strong>${value}</strong></article>`).join("");
};

const request = async (url, options) => {
  const response = await fetch(url, options);
  if (response.status === 401) {
    showLogin();
    throw new Error("Authentication required.");
  }
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Something went wrong.");
  return payload;
};

const showLogin = () => {
  appView.hidden = true;
  loginView.hidden = false;
  document.body.classList.add("is-login");
};

const showApp = () => {
  loginView.hidden = true;
  appView.hidden = false;
  document.body.classList.remove("is-login");
};

const setView = (view, updateHistory = true) => {
  activeView = ["dashboard", "calendar", "applications", "artists"].includes(view) ? view : "dashboard";
  views.forEach((section) => { section.hidden = section.dataset.view !== activeView; });
  routeButtons.forEach((button) => button.classList.toggle("is-active", button.dataset.route === activeView));
  appView.classList.remove("is-detail", "is-artist-detail");
  if (updateHistory) history.pushState({ view: activeView }, "", activeView === "dashboard" ? "#dashboard" : `#${activeView}`);
  if (activeView === "calendar") renderAdminCalendar();
  window.scrollTo(0, 0);
};

passcodeInput.addEventListener("input", () => {
  passcodeInput.value = passcodeInput.value.replace(/\D/g, "").slice(0, 4);
});

const renderList = () => {
  const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
  const completedStatuses = ["approved", "declined", "payment_pending", "confirmed", "cancelled"];
  const pending = applications.filter((application) => !completedStatuses.includes(application.status));
  const previous = applications.filter((application) => (
    completedStatuses.includes(application.status)
    && new Date(application.decided_at || application.updated_at || application.created_at).getTime() >= thirtyDaysAgo
  ));
  count.textContent = `${pending.length} pending`;

  const cards = (items, completed = false) => items.map((application) => {
    const name = application.artist_name || `${application.first_name} ${application.last_name}`;
    return `
      <button class="application-card ${application.id === selectedId ? "is-active" : ""}" type="button" data-id="${escapeHtml(application.id)}">
        <span>${escapeHtml(formatDate(application.created_at))} · ${escapeHtml(application.status)}</span>
        <h3>${escapeHtml(name)}</h3>
        <p>${escapeHtml(application.service)}</p>
        <footer>
          <span>${escapeHtml(application.preferred_date ? formatDate(application.preferred_date) : "No calendar request")}</span>
          ${completed
            ? `<span class="card-decision is-${escapeHtml(application.status)}">${escapeHtml(application.status === "confirmed" ? "deposit paid" : application.status === "payment_pending" ? "awaiting deposit" : application.status)}</span>`
            : `<span>${Number(application.file_count) || 0} files</span>`}
        </footer>
      </button>
    `;
  }).join("");

  list.innerHTML = cards(pending) || `<p class="review-message">No applications are waiting for review.</p>`;
  previousList.innerHTML = cards(previous, true) || `<p class="review-message">No applications have been completed in the past 30 days.</p>`;
};

const artistName = (artist) => artist.artist_name || `${artist.first_name || ""} ${artist.last_name || ""}`.trim() || artist.email;

const renderDashboard = () => {
  const completedStatuses = ["approved", "declined", "payment_pending", "confirmed", "cancelled"];
  const pending = applications.filter((item) => !completedStatuses.includes(item.status));
  const awaitingDeposits = applications.filter((item) => item.status === "approved" || item.status === "payment_pending");
  const confirmed = calendarSessions.filter((item) => item.status === "confirmed");
  dashboardStats.innerHTML = [
    ["Pending applications", pending.length, "applications"],
    ["Approved artists", artists.length, "artists"],
    ["Awaiting deposits", awaitingDeposits.length, "applications"],
    ["Confirmed sessions", confirmed.length, "calendar"],
  ].map(([label, value, route], index) => `<button type="button" class="stat-card" data-route="${route}"><span>0${index + 1}</span><strong>${value}</strong><p>${label}</p></button>`).join("");

  const recent = [...applications].sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at)).slice(0, 5);
  recentActivity.innerHTML = recent.length ? `<div class="recent-list">${recent.map((application) => `
    <button type="button" data-application-link="${escapeHtml(application.id)}">
      <span>${escapeHtml(formatDate(application.updated_at || application.created_at))}</span>
      <strong>${escapeHtml(application.artist_name || `${application.first_name} ${application.last_name}`)}</strong>
      <p>${escapeHtml(application.service)} · ${escapeHtml(application.status)}</p><b>↗︎</b>
    </button>`).join("")}</div>` : `<p class="review-message">Activity will appear here as applications arrive.</p>`;
};

const renderArtistList = (query = "") => {
  const term = query.trim().toLowerCase();
  const filtered = artists.filter((artist) => !term || [artistName(artist), artist.email, artist.phone].some((value) => String(value || "").toLowerCase().includes(term)));
  artistList.innerHTML = filtered.length ? filtered.map((artist) => `
    <button type="button" class="artist-card ${artist.id === selectedArtistId ? "is-active" : ""}" data-artist-id="${escapeHtml(artist.id)}">
      <span class="artist-monogram">${escapeHtml(artistName(artist).slice(0, 1).toUpperCase())}</span>
      <span><strong>${escapeHtml(artistName(artist))}</strong><small>${escapeHtml(artist.email)}</small></span>
      <b>${artist.application_count} project${artist.application_count === 1 ? "" : "s"}</b>
    </button>`).join("") : `<p class="review-message">No approved artists match this search.</p>`;
};

const renderArtistDetail = ({ artist, applications: artistApplications }) => {
  currentArtist = artist;
  const name = artistName(artist);
  artistDetail.innerHTML = `
    <button class="detail-back" type="button" data-artist-back>← back to artists</button>
    <div class="artist-profile-hero"><span class="artist-profile-monogram">${escapeHtml(name.slice(0, 1).toUpperCase())}</span><div><p class="detail-kicker">Approved artist · since ${escapeHtml(formatDate(artist.first_application))}</p><h2>${escapeHtml(name)}</h2><p>${artist.application_count} approved project${artist.application_count === 1 ? "" : "s"} · ${artist.confirmed_count} confirmed</p></div><button class="edit-artist-button" type="button" data-edit-artist>edit profile <b>↗︎</b></button></div>
    <div class="detail-grid artist-contact-grid">
      ${detailField("First name", artist.first_name)}${detailField("Last name", artist.last_name)}${detailField("Artist name", artist.artist_name)}
      ${detailField("Email", artist.email, false, `mailto:${artist.email}`)}${detailField("Phone", artist.phone, false, `tel:${artist.phone}`)}
      ${detailField("Latest activity", formatDate(artist.latest_activity))}${detailField("Social links", artist.social_links, true)}${detailField("Latest notes", artist.notes, true)}
    </div>
    <section class="review-section"><div class="review-section-head"><div><p>02 / Approved work</p><h3>project history.</h3></div></div>
      <div class="artist-projects">${artistApplications.map((application) => `<button type="button" data-application-link="${escapeHtml(application.id)}"><span>${escapeHtml(formatDate(application.created_at))}</span><strong>${escapeHtml(application.service)}</strong><p>${escapeHtml(application.status)} · ${Number(application.file_count) || 0} files</p><b>view application ↗︎</b></button>`).join("")}</div>
    </section>`;
};

const selectArtist = async (id, navigate = true) => {
  selectedArtistId = id;
  renderArtistList(artistSearch.value);
  if (mobileReview.matches) appView.classList.add("is-artist-detail");
  if (navigate) history.pushState({ artistId: id }, "", `#artist=${encodeURIComponent(id)}`);
  artistDetail.classList.add("review-loading");
  try { renderArtistDetail(await request(`/api/admin/artists/${encodeURIComponent(id)}`)); }
  catch (error) { artistDetail.innerHTML = `<p class="review-message">${escapeHtml(error.message)}</p>`; }
  finally { artistDetail.classList.remove("review-loading"); }
  window.scrollTo(0, 0);
};

const detailField = (label, value, wide = false, link = "") => {
  if (!value) return "";
  const content = link
    ? `<a href="${escapeHtml(link)}">${escapeHtml(value)}</a>`
    : `<p>${escapeHtml(value)}</p>`;
  return `<article class="detail-field ${wide ? "is-wide" : ""}"><span class="detail-label">${escapeHtml(label)}</span>${content}</article>`;
};

const filePreview = (file) => {
  const source = `/api/admin/files/${encodeURIComponent(file.id)}`;
  const type = file.content_type || "";
  if (type.startsWith("audio/")) return `<audio controls preload="metadata" src="${source}"></audio>`;
  if (type.startsWith("video/")) return `<video controls preload="metadata" src="${source}"></video>`;
  if (type.startsWith("image/")) return `<img src="${source}" alt="${escapeHtml(file.original_name)}" />`;
  if (type === "application/pdf" || type.startsWith("text/")) return `<iframe title="${escapeHtml(file.original_name)}" src="${source}"></iframe>`;
  return `<span class="detail-label">Preview unavailable<br />Download to review</span>`;
};

const renderFiles = (files) => {
  if (!files.length) return `<div class="review-message">No files were attached to this application.</div>`;
  return `<div class="file-grid">${files.map((file) => {
    const source = `/api/admin/files/${encodeURIComponent(file.id)}`;
    return `
      <article class="file-card">
        <div class="file-preview">${filePreview(file)}</div>
        <div class="file-info">
          <strong>${escapeHtml(file.original_name)}</strong>
          <span>${escapeHtml(file.content_type || "file")} · ${(Number(file.size_bytes) / 1024 / 1024).toFixed(2)} MB</span>
          <a class="file-download" href="${source}" download="${escapeHtml(file.original_name)}">download <b>↓</b></a>
        </div>
      </article>
    `;
  }).join("")}</div>`;
};

const socialUrls = (value) => String(value || "").split(/[\s,\n]+/).map((item) => item.trim()).filter((item) => /^https?:\/\//i.test(item));

const socialPreview = (url) => {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    const pathParts = parsed.pathname.split("/").filter(Boolean);
    const fallback = {
      embed: "",
      platform: host.split(".").slice(-2, -1)[0] || host,
      label: pathParts.at(-1)?.replace(/^@/, "") || host,
    };
    if (host === "youtu.be" && pathParts[0]) {
      return { ...fallback, embed: `https://www.youtube-nocookie.com/embed/${pathParts[0]}`, platform: "YouTube" };
    }
    if (host.endsWith("youtube.com")) {
      const videoId = parsed.searchParams.get("v")
        || (["shorts", "embed"].includes(pathParts[0]) ? pathParts[1] : "");
      return { ...fallback, embed: videoId ? `https://www.youtube-nocookie.com/embed/${videoId}` : "", platform: "YouTube" };
    }
    if (host.endsWith("spotify.com") && pathParts.length >= 2) {
      return { ...fallback, embed: `https://open.spotify.com/embed/${pathParts.join("/")}`, platform: "Spotify" };
    }
    if (host.endsWith("instagram.com")) {
      const embed = ["p", "reel", "tv"].includes(pathParts[0]) && pathParts[1]
        ? `https://www.instagram.com/${pathParts[0]}/${pathParts[1]}/embed`
        : "";
      return { ...fallback, embed, platform: "Instagram" };
    }
    if (host.endsWith("tiktok.com")) {
      const id = parsed.pathname.match(/video\/(\d+)/)?.[1];
      return { ...fallback, embed: id ? `https://www.tiktok.com/player/v1/${id}` : "", platform: "TikTok" };
    }
    if (host.endsWith("soundcloud.com")) {
      return { ...fallback, embed: `https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}&color=%23f1ece4`, platform: "SoundCloud" };
    }
    return fallback;
  } catch {
    return { embed: "", platform: "Social link", label: url };
  }
};

const renderSocial = (value) => {
  const urls = socialUrls(value);
  if (!urls.length) return `<div class="review-message">No social links were included.</div>`;
  return `<div class="social-grid">${urls.map((url) => {
    const preview = socialPreview(url);
    const media = preview.embed
      ? `<iframe title="${escapeHtml(preview.platform)} preview" src="${escapeHtml(preview.embed)}" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-popups allow-forms"></iframe>`
      : `<a class="social-placeholder" data-social-url="${escapeHtml(url)}" href="${escapeHtml(url)}" target="_blank" rel="noopener">
          <span>${escapeHtml(preview.platform)}</span>
          <strong>${escapeHtml(preview.label)}</strong>
          <small>This profile protects its preview. Open it directly to view the latest work.</small>
          <b>↗︎</b>
        </a>`;
    return `
    <article class="social-card">
      ${media}
      <div class="social-info"><span>${escapeHtml(url)}</span><a href="${escapeHtml(url)}" target="_blank" rel="noopener">open ↗︎</a></div>
    </article>
  `;
  }).join("")}</div>`;
};

const hydrateSocialPreviews = async (container) => {
  const placeholders = [...container.querySelectorAll("[data-social-url]")];
  await Promise.all(placeholders.map(async (placeholder) => {
    try {
      const payload = await request(`/api/admin/social-preview?url=${encodeURIComponent(placeholder.dataset.socialUrl)}`);
      if (!payload.image) return;
      const image = document.createElement("img");
      image.className = "social-placeholder-cover";
      image.src = payload.image;
      image.alt = "";
      image.loading = "lazy";
      image.referrerPolicy = "no-referrer";
      image.addEventListener("load", () => placeholder.classList.add("has-cover"), { once: true });
      image.addEventListener("error", () => image.remove(), { once: true });
      placeholder.prepend(image);
      const title = placeholder.querySelector("strong");
      if (payload.title && title) title.textContent = payload.title;
    } catch {
      // The branded card is the intentional fallback when a platform withholds metadata.
    }
  }));
};

const renderDecision = (application) => {
  const decided = ["approved", "declined", "payment_pending", "confirmed", "cancelled"].includes(application.status);
  const emailFailed = decided && application.decision_email_status === "failed";
  return `
    <section class="decision-card" data-decision-card>
      <div class="decision-actions">
        ${emailFailed ? `
          <button class="decision-button is-approve" type="button" data-decision="${escapeHtml(application.status)}">retry applicant email <b>↗︎</b></button>
        ` : `
          <button class="decision-button is-approve" type="button" data-decision="approved" ${decided ? "disabled" : ""}>approve application <b>✓</b></button>
          <button class="decision-button is-decline" type="button" data-decision="declined" ${decided ? "disabled" : ""}>decline application <b>×</b></button>
        `}
      </div>
      ${decided ? `<p class="decision-result">Application ${escapeHtml(application.status)}${application.deposit_status === "paid" ? " · deposit paid" : application.decision_email_status === "sent" ? " · applicant notified" : " · email delivery failed"}</p>` : ""}
      ${["approved", "payment_pending", "confirmed"].includes(application.status) ? `<button class="manage-booking-button" type="button" data-manage-booking>${application.deposit_status === "paid" ? "manage confirmed booking" : "cancel approved application"} <b>↗︎</b></button>` : ""}
    </section>
  `;
};

const renderAssignment = (application, assignment) => {
  const usesCalendar = application.category !== "mixing" && application.service !== "Custom Project";
  if (!usesCalendar || ["declined", "cancelled"].includes(application.status)) return "";
  const state = assignment?.state || "unassigned";
  const labels = {
    requested_owner: "awaiting Jake’s response",
    requested_employee: "Jake requested this session",
    accepted: "Jake is running this session",
    declined: "Jake declined this session",
    cancelled: "assignment cancelled",
    unassigned: "no engineer assigned",
  };
  const active = ["requested_owner", "requested_employee", "accepted"].includes(state);
  return `<section class="employee-handoff" data-employee-handoff>
    <div><p class="detail-kicker">Engineer handoff</p><h3>${escapeHtml(labels[state] || state)}</h3>
      ${assignment?.request_note ? `<p>${escapeHtml(assignment.request_note)}</p>` : ""}
      ${assignment?.response_note ? `<small>Jake: ${escapeHtml(assignment.response_note)}</small>` : ""}
    </div>
    <div class="employee-handoff-actions">
      ${!active ? `<button type="button" data-assignment-action="request">request Jake <b>↗︎</b></button>` : ""}
      ${state === "requested_employee" ? `<button type="button" data-assignment-action="accept">approve Jake <b>✓</b></button><button type="button" class="is-secondary" data-assignment-action="decline">decline request</button>` : ""}
      ${state === "requested_owner" || state === "accepted" ? `<button type="button" class="is-secondary" data-assignment-action="cancel">cancel handoff</button>` : ""}
    </div>
  </section>`;
};

const renderDetail = ({ application, files, assignment }) => {
  currentApplication = application;
  const name = application.artist_name || `${application.first_name} ${application.last_name}`;
  const usesCalendar = application.category !== "mixing" && application.service !== "Custom Project";
  const calendarStatus = application.calendar_sync_status || "not synced";
  detail.innerHTML = `
    <button class="detail-back" type="button" data-back>← back to applications</button>
    <div class="detail-hero">
      <div>
        <p class="detail-kicker">02 / Application review · ${escapeHtml(formatDate(application.created_at))}</p>
        <h2 class="detail-title">${escapeHtml(name)}<br /><em>${escapeHtml(application.service)}</em></h2>
        <div class="detail-meta"><span class="status-pill status-${escapeHtml(application.status)}">${escapeHtml(application.status)}</span><span class="status-pill">${escapeHtml(application.category)}</span><span class="status-pill">${files.length} files</span></div>
      </div>
    </div>
    <div class="detail-grid">
      ${detailField("First name", application.first_name)}
      ${detailField("Last name", application.last_name)}
      ${detailField("Artist name", application.artist_name)}
      ${detailField("Email", application.email, false, `mailto:${application.email}`)}
      ${detailField("Phone", application.phone, false, `tel:${application.phone}`)}
      ${detailField("Service option", application.service_option)}
      ${detailField("Preferred date", application.preferred_date ? formatDate(application.preferred_date) : "")}
      ${detailField("Preferred time", application.preferred_time ? formatTime(application.preferred_time) : "")}
      ${detailField("Stems / trackouts", application.stem_count)}
      ${detailField("Additional information", application.notes, true)}
    </div>
    ${usesCalendar ? `<section class="calendar-sync-card">
      <div><p class="detail-kicker">Calendar sync</p><strong>${escapeHtml(calendarStatus)}</strong>${application.calendar_sync_error ? `<small>${escapeHtml(application.calendar_sync_error)}</small>` : ""}</div>
      <button type="button" data-retry-calendar>repair calendar sync <b>↗︎</b></button>
    </section>` : ""}
    ${renderAssignment(application, assignment)}
    <section class="review-section"><div class="review-section-head"><div><p>03 / Submitted material</p><h3>listen &amp; look.</h3></div></div>${renderFiles(files)}</section>
    <section class="review-section"><div class="review-section-head"><div><p>04 / Online presence</p><h3>social preview.</h3></div></div>${renderSocial(application.social_links)}</section>
    ${renderDecision(application)}
  `;
  hydrateSocialPreviews(detail);
};

const showInbox = () => {
  appView.classList.remove("is-detail");
  selectedId = "";
  renderList();
};

const selectApplication = async (id, navigate = true) => {
  selectedId = id;
  renderList();
  if (mobileReview.matches) {
    appView.classList.add("is-detail");
    if (navigate) history.pushState({ applicationId: id }, "", `#application=${encodeURIComponent(id)}`);
    window.scrollTo(0, 0);
  }
  detail.classList.add("review-loading");
  try {
    renderDetail(await request(`/api/admin/applications/${encodeURIComponent(id)}`));
  } catch (error) {
    detail.innerHTML = `<p class="review-message">${escapeHtml(error.message)}</p>`;
  } finally {
    detail.classList.remove("review-loading");
  }
};

const loadApplications = async () => {
  const [applicationPayload, artistPayload, schedulePayload] = await Promise.all([
    request("/api/admin/applications"), request("/api/admin/artists"), request("/api/admin/schedule"),
  ]);
  applications = applicationPayload.applications || [];
  artists = artistPayload.artists || [];
  calendarSessions = schedulePayload.sessions || [];
  renderList();
  renderArtistList();
  renderDashboard();
  renderAdminCalendar();
  await routeFromHash();
};

const routeFromHash = async () => {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const applicationId = params.get("application");
  const artistId = params.get("artist");
  if (applicationId) {
    setView("applications", false); await selectApplication(applicationId, false); return;
  }
  if (artistId && artists.some((artist) => artist.id === artistId)) {
    setView("artists", false); await selectArtist(artistId, false); return;
  }
  const hashView = location.hash.slice(1);
  setView(["calendar", "applications", "artists"].includes(hashView) ? hashView : "dashboard", false);
};

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";
  const button = loginForm.querySelector("button");
  button.disabled = true;
  try {
    await request("/api/admin/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: new FormData(loginForm).get("password") }),
    });
    loginForm.reset();
    showApp();
    await loadApplications();
  } catch (error) {
    loginError.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

list.addEventListener("click", (event) => {
  const card = event.target.closest("[data-id]");
  if (card) selectApplication(card.dataset.id);
});
previousList.addEventListener("click", (event) => {
  const card = event.target.closest("[data-id]");
  if (card) selectApplication(card.dataset.id);
});
artistList.addEventListener("click", (event) => { const card = event.target.closest("[data-artist-id]"); if (card) selectArtist(card.dataset.artistId); });
artistSearch.addEventListener("input", () => renderArtistList(artistSearch.value));

document.querySelector("[data-add-artist]").addEventListener("click", () => {
  editingArtistId = "";
  artistForm.reset();
  artistFormError.textContent = "";
  artistDialogKicker.textContent = "New directory profile";
  artistDialogTitle.innerHTML = "add an<br><em>artist.</em>";
  artistForm.querySelector("[data-artist-submit]").innerHTML = "save artist <b>↗︎</b>";
  artistDialog.showModal();
});

calendarImportButton.addEventListener("click", async () => {
  calendarImportButton.disabled = true;
  calendarImportStatus.textContent = "Checking Google Calendar…";
  try {
    const result = await request("/api/admin/calendar-import", { method: "POST" });
    const [refreshed, refreshedSchedule] = await Promise.all([request("/api/admin/artists"), request("/api/admin/schedule")]);
    artists = refreshed.artists || [];
    calendarSessions = refreshedSchedule.sessions || [];
    renderArtistList(artistSearch.value);
    renderDashboard();
    renderAdminCalendar();
    const imported = result.imported?.length || 0;
    const skipped = result.skipped?.length || 0;
    calendarImportStatus.textContent = `${imported} session${imported === 1 ? "" : "s"} imported${skipped ? ` · ${skipped} already linked` : ""}.`;
  } catch (error) {
    calendarImportStatus.textContent = error.message;
  } finally {
    calendarImportButton.disabled = false;
  }
});

artistDialog.addEventListener("click", (event) => {
  if (event.target === artistDialog || event.target.closest("[data-close-artist]")) artistDialog.close();
});

artistForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  artistFormError.textContent = "";
  const submit = artistForm.querySelector("[type=submit]");
  submit.disabled = true;
  submit.innerHTML = "saving…";
  try {
    const fields = Object.fromEntries(new FormData(artistForm));
    const endpoint = editingArtistId ? `/api/admin/artists/${encodeURIComponent(editingArtistId)}` : "/api/admin/artists";
    const payload = await request(endpoint, {
      method: editingArtistId ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fields),
    });
    const refreshed = await request("/api/admin/artists");
    artists = refreshed.artists || [];
    renderArtistList();
    renderDashboard();
    artistDialog.close();
    await selectArtist(payload.artist.id);
  } catch (error) {
    artistFormError.textContent = error.message;
  } finally {
    submit.disabled = false;
    submit.innerHTML = editingArtistId ? "save changes <b>↗︎</b>" : "save artist <b>↗︎</b>";
  }
});

appView.addEventListener("click", (event) => {
  const calendarSession = event.target.closest("[data-admin-session]");
  if (calendarSession) {
    setView("applications", false);
    history.pushState({ applicationId: calendarSession.dataset.adminSession }, "", `#application=${encodeURIComponent(calendarSession.dataset.adminSession)}`);
    selectApplication(calendarSession.dataset.adminSession, false);
    return;
  }
  const calendarModeButton = event.target.closest("[data-admin-calendar-mode]");
  if (calendarModeButton) { adminCalendarMode = calendarModeButton.dataset.adminCalendarMode; renderAdminCalendar(); return; }
  const calendarPeriodButton = event.target.closest("[data-admin-period]");
  if (calendarPeriodButton) {
    const direction = Number(calendarPeriodButton.dataset.adminPeriod);
    if (adminCalendarMode === "month") adminCalendarDate = new Date(adminCalendarDate.getFullYear(), adminCalendarDate.getMonth() + direction, 1);
    else adminCalendarDate.setDate(adminCalendarDate.getDate() + direction * (adminCalendarMode === "week" ? 7 : 1));
    renderAdminCalendar();
    return;
  }
  const route = event.target.closest("[data-route]");
  if (route) { setView(route.dataset.route); return; }
  const applicationLink = event.target.closest("[data-application-link]");
  if (applicationLink) { setView("applications", false); selectApplication(applicationLink.dataset.applicationLink); }
});

artistDetail.addEventListener("click", (event) => {
  if (event.target.closest("[data-artist-back]")) { appView.classList.remove("is-artist-detail"); history.pushState({}, "", "#artists"); }
  if (event.target.closest("[data-edit-artist]") && currentArtist) {
    editingArtistId = currentArtist.id;
    artistForm.reset();
    ["first_name", "last_name", "artist_name", "email", "phone", "social_links", "notes"].forEach((field) => {
      artistForm.elements[field].value = currentArtist[field] || "";
    });
    artistFormError.textContent = "";
    artistDialogKicker.textContent = "Update directory profile";
    artistDialogTitle.innerHTML = "edit the<br><em>artist.</em>";
    artistForm.querySelector("[data-artist-submit]").innerHTML = "save changes <b>↗︎</b>";
    artistDialog.showModal();
  }
});

detail.addEventListener("click", (event) => {
  const back = event.target.closest("[data-back]");
  if (back) {
    if (location.hash.startsWith("#application=")) history.back();
    else showInbox();
    return;
  }
  const retryCalendar = event.target.closest("[data-retry-calendar]");
  if (retryCalendar && selectedId) {
    retryCalendar.disabled = true;
    retryCalendar.textContent = "syncing…";
    request("/api/admin/retry-calendar", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: selectedId }),
    }).then(() => selectApplication(selectedId, false)).catch((error) => {
      retryCalendar.textContent = error.message;
      retryCalendar.disabled = false;
    });
    return;
  }
  const assignmentButton = event.target.closest("[data-assignment-action]");
  if (assignmentButton && selectedId) {
    const action = assignmentButton.dataset.assignmentAction;
    const note = ["request", "accept", "decline"].includes(action) ? window.prompt(action === "request" ? "Optional note for Jake:" : "Optional response note:", "") : null;
    if (["request", "accept", "decline"].includes(action) && note === null) return;
    assignmentButton.disabled = true;
    assignmentButton.textContent = "saving…";
    request(`/api/admin/applications/${encodeURIComponent(selectedId)}/assignment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, note }),
    }).then(() => selectApplication(selectedId, false)).catch((error) => {
      assignmentButton.textContent = error.message;
      assignmentButton.disabled = false;
    });
    return;
  }
  if (event.target.closest("[data-manage-booking]") && selectedId) {
    const application = currentApplication;
    const paid = application?.deposit_status === "paid";
    bookingDialogTitle.textContent = paid ? "change this booking?" : "cancel this application?";
    bookingDialogCopy.textContent = paid
      ? "The deposit has been paid. Choose whether to move the confirmed session or refund the full deposit and cancel it."
      : "This will cancel the approved application and remove its pending calendar event. No payment has been collected.";
    bookingOptions.innerHTML = paid
      ? `<button type="button" data-booking-action="reschedule">reschedule booking <b>↗︎</b></button><button type="button" class="is-refund" data-booking-action="refund">refund deposit &amp; cancel <b>×</b></button>`
      : `<button type="button" class="is-refund" data-booking-action="cancel">confirm cancellation <b>×</b></button>`;
    bookingReschedule.hidden = true;
    bookingReschedule.reset();
    bookingReschedule.elements.date.value = application?.preferred_date || "";
    bookingReschedule.elements.time.value = /^\d{2}:\d{2}$/.test(application?.preferred_time || "") ? application.preferred_time : "";
    bookingMessage.textContent = "";
    bookingDialog.showModal();
    return;
  }
  const decisionButton = event.target.closest("[data-decision]");
  if (!decisionButton || !selectedId) return;
  pendingDecision = decisionButton.dataset.decision;
  const approving = pendingDecision === "approved";
  const application = applications.find((item) => item.id === selectedId);
  const isPackage = approving && application?.category === "packages";
  decisionDialogTitle.textContent = approving ? "approve this application?" : "decline this application?";
  const fixedDeposits = { recording: "$70", production: "$90", mixing: "$150" };
  decisionDialogCopy.textContent = approving
    ? `This approval will request a ${isPackage ? "custom" : fixedDeposits[application?.category] || "required"} deposit and immediately email the applicant.`
    : "This decision will be recorded and a decline email will immediately be sent to the applicant.";
  customDepositField.hidden = !isPackage;
  customDepositInput.required = isPackage;
  customDepositInput.value = "";
  decisionConfirm.textContent = approving ? "yes, approve & send" : "yes, decline & send";
  decisionConfirm.classList.toggle("is-decline", !approving);
  decisionDialog.showModal();
});

const completeBookingAction = async (action, fields = {}) => {
  bookingMessage.textContent = action === "refund" ? "Refunding through Stripe…" : action === "reschedule" ? "Updating the calendar…" : "Cancelling…";
  bookingDialog.querySelectorAll("button,input").forEach((control) => { control.disabled = true; });
  try {
    await request(`/api/admin/applications/${encodeURIComponent(selectedId)}/booking`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...fields }),
    });
    const [applicationPayload, schedulePayload] = await Promise.all([request("/api/admin/applications"), request("/api/admin/schedule")]);
    applications = applicationPayload.applications || [];
    calendarSessions = schedulePayload.sessions || [];
    renderList(); renderDashboard(); renderAdminCalendar();
    bookingDialog.close();
    await selectApplication(selectedId, false);
  } catch (error) {
    bookingMessage.textContent = error.message;
  } finally {
    bookingDialog.querySelectorAll("button,input").forEach((control) => { control.disabled = false; });
  }
};

bookingDialog.addEventListener("click", (event) => {
  if (event.target === bookingDialog || event.target.closest("[data-close-booking]")) { bookingDialog.close(); return; }
  const actionButton = event.target.closest("[data-booking-action]");
  if (!actionButton) return;
  const action = actionButton.dataset.bookingAction;
  if (action === "reschedule") {
    bookingOptions.hidden = true;
    bookingReschedule.hidden = false;
    bookingDialogTitle.textContent = "choose a new time.";
    bookingDialogCopy.textContent = "The confirmed Google Calendar event will move to this date and time.";
    return;
  }
  completeBookingAction(action);
});

bookingDialog.addEventListener("close", () => { bookingOptions.hidden = false; bookingReschedule.hidden = true; });
bookingReschedule.addEventListener("submit", (event) => {
  event.preventDefault();
  const fields = Object.fromEntries(new FormData(bookingReschedule));
  completeBookingAction("reschedule", fields);
});

decisionDialog.addEventListener("click", (event) => {
  if (event.target === decisionDialog || event.target.closest("[data-cancel-decision]")) {
    pendingDecision = "";
    decisionDialog.close();
  }
});

decisionConfirm.addEventListener("click", async () => {
  if (!pendingDecision || !selectedId) return;
  const decision = pendingDecision;
  const customDeposit = customDepositField.hidden ? null : Number(customDepositInput.value);
  if (!customDepositField.hidden && (!Number.isFinite(customDeposit) || customDeposit < 1)) {
    customDepositInput.reportValidity();
    return;
  }
  const card = detail.querySelector("[data-decision-card]");
  const buttons = card.querySelectorAll("[data-decision]");
  buttons.forEach((button) => { button.disabled = true; });
  decisionConfirm.disabled = true;
  decisionConfirm.textContent = "saving & sending…";
  fetch(`/api/admin/applications/${encodeURIComponent(selectedId)}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision, customDeposit }),
  }).then(async (response) => {
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "The decision could not be completed.");
    const listItem = applications.find((application) => application.id === selectedId);
    if (listItem) {
      listItem.status = decision;
      listItem.decided_at = payload.application.decided_at;
      listItem.decision_email_status = payload.application.decision_email_status;
    }
    renderList();
    pendingDecision = "";
    decisionDialog.close();
    await selectApplication(selectedId, false);
  }).catch((error) => {
    decisionDialogCopy.textContent = error.message;
    buttons.forEach((button) => { button.disabled = false; });
    decisionConfirm.textContent = decision === "approved"
      ? "retry approval email"
      : "retry decline email";
  }).finally(() => {
    decisionConfirm.disabled = false;
  });
});

window.addEventListener("popstate", () => routeFromHash());

logout.addEventListener("click", async () => {
  await fetch("/api/admin/session", { method: "DELETE" });
  showLogin();
});

(async () => {
  const session = await fetch("/api/admin/session").then((response) => response.json()).catch(() => ({ authenticated: false }));
  if (!session.authenticated) return showLogin();
  showApp();
  loadApplications().catch(() => showLogin());
})();
