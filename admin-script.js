const loginView = document.querySelector("[data-login]");
const loginForm = loginView.querySelector("form");
const loginError = loginView.querySelector(".login-error");
const appView = document.querySelector("[data-app]");
const list = document.querySelector("[data-list]");
const detail = document.querySelector("[data-detail]");
const count = document.querySelector("[data-count]");
const logout = document.querySelector("[data-logout]");

let applications = [];
let selectedId = "";
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
};

const showApp = () => {
  loginView.hidden = true;
  appView.hidden = false;
};

const renderList = () => {
  count.textContent = `${applications.length} ${applications.length === 1 ? "request" : "requests"}`;
  list.innerHTML = applications.map((application) => {
    const name = application.artist_name || `${application.first_name} ${application.last_name}`;
    return `
      <button class="application-card ${application.id === selectedId ? "is-active" : ""}" type="button" data-id="${escapeHtml(application.id)}">
        <span>${escapeHtml(formatDate(application.created_at))} · ${escapeHtml(application.status)}</span>
        <h3>${escapeHtml(name)}</h3>
        <p>${escapeHtml(application.service)}</p>
        <footer><span>${escapeHtml(application.preferred_date ? formatDate(application.preferred_date) : "No calendar request")}</span><span>${Number(application.file_count) || 0} files</span></footer>
      </button>
    `;
  }).join("") || `<p class="review-message">No applications have been submitted yet.</p>`;
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

const socialEmbed = (url) => {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return `https://www.youtube-nocookie.com/embed/${parsed.pathname.slice(1)}`;
    if (host.endsWith("youtube.com")) return `https://www.youtube-nocookie.com/embed/${parsed.searchParams.get("v") || parsed.pathname.split("/").filter(Boolean).pop()}`;
    if (host.endsWith("spotify.com")) return `https://open.spotify.com/embed/${parsed.pathname.split("/").filter(Boolean).join("/")}`;
    if (host.endsWith("instagram.com")) {
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (["p", "reel", "tv"].includes(parts[0]) && parts[1]) return `https://www.instagram.com/${parts[0]}/${parts[1]}/embed`;
    }
    if (host.endsWith("tiktok.com")) {
      const id = parsed.pathname.match(/video\/(\d+)/)?.[1];
      if (id) return `https://www.tiktok.com/player/v1/${id}`;
    }
    if (host.endsWith("soundcloud.com")) return `https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}&color=%23f1ece4`;
    return url;
  } catch {
    return "";
  }
};

const renderSocial = (value) => {
  const urls = socialUrls(value);
  if (!urls.length) return `<div class="review-message">No social links were included.</div>`;
  return `<div class="social-grid">${urls.map((url) => `
    <article class="social-card">
      <iframe title="Social preview" src="${escapeHtml(socialEmbed(url))}" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-popups allow-forms"></iframe>
      <div class="social-info"><span>${escapeHtml(url)}</span><a href="${escapeHtml(url)}" target="_blank" rel="noopener">open ↗︎</a></div>
    </article>
  `).join("")}</div>`;
};

const renderDetail = ({ application, files }) => {
  const name = application.artist_name || `${application.first_name} ${application.last_name}`;
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
    <section class="review-section"><div class="review-section-head"><div><p>03 / Submitted material</p><h3>listen &amp; look.</h3></div></div>${renderFiles(files)}</section>
    <section class="review-section"><div class="review-section-head"><div><p>04 / Online presence</p><h3>social preview.</h3></div></div>${renderSocial(application.social_links)}</section>
  `;
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
  const payload = await request("/api/admin/applications");
  applications = payload.applications || [];
  const requestedId = new URLSearchParams(location.hash.replace(/^#/, "")).get("application");
  selectedId = mobileReview.matches ? "" : applications[0]?.id || "";
  renderList();
  if (mobileReview.matches && requestedId && applications.some((application) => application.id === requestedId)) {
    await selectApplication(requestedId, false);
  } else if (selectedId) {
    await selectApplication(selectedId, false);
  }
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

detail.addEventListener("click", (event) => {
  if (!event.target.closest("[data-back]")) return;
  if (location.hash.startsWith("#application=")) history.back();
  else showInbox();
});

window.addEventListener("popstate", () => {
  if (!mobileReview.matches) return;
  const id = new URLSearchParams(location.hash.replace(/^#/, "")).get("application");
  if (id && applications.some((application) => application.id === id)) selectApplication(id, false);
  else showInbox();
});

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
