const shell = document.querySelector("[data-status-shell]");
const accessView = document.querySelector("[data-access]");
const accessForm = document.querySelector("[data-access-form]");
const accessError = document.querySelector("[data-access-error]");
const errorView = document.querySelector("[data-error]");
const portal = document.querySelector("[data-portal]");
let verifiedLastFour = "";

const escapeHtml = (value) => String(value ?? "").replace(/&/g, "&amp;")
  .replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const titleCase = (value) => String(value || "").replace(/[_-]+/g, " ")
  .replace(/\b\w/g, (letter) => letter.toUpperCase());
const slug = (value) => String(value || "").toLowerCase().normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const date = (value) => value
  ? new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric" })
    .format(new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value))
  : "Not required";

const stateContent = {
  new: {
    hero: "under review.",
    summary: "Your application made it to us. We’re taking a thoughtful look at the project and the session you requested.",
    nextTitle: "we’ll be in touch.",
    nextCopy: "No action is needed from you right now. Once the application is reviewed, this private page will update with your decision and next steps.",
    activeStep: 1,
  },
  reviewing: {
    hero: "in review.",
    summary: "Your project is actively being reviewed by Right Mind Creative.",
    nextTitle: "we’re looking it over.",
    nextCopy: "We’re reviewing the details, requested timing, and project fit. This page will update as soon as a decision is made.",
    activeStep: 1,
  },
  approved: {
    hero: "approved.",
    summary: "We’d love to move forward with your project. Your application has been approved.",
    nextTitle: "let’s make something.",
    nextCopy: "Your session deposit is ready. Once it is paid securely through Stripe, this page will confirm your booking.",
    activeStep: 3,
  },
  payment_pending: {
    hero: "deposit ready.",
    summary: "Your application is approved. Complete the deposit below to confirm the session.",
    nextTitle: "secure your session.",
    nextCopy: "Your requested time is confirmed after the deposit is successfully received.",
    activeStep: 3,
  },
  confirmed: {
    hero: "confirmed.",
    summary: "Your deposit has been received and your session is confirmed.",
    nextTitle: "you’re on the books.",
    nextCopy: "We have your session and project details. The studio will be in touch if anything else is needed before you arrive.",
    activeStep: 4,
  },
  declined: {
    hero: "reviewed.",
    summary: "Thank you for sharing your work with us. We’re unable to move forward with this application.",
    nextTitle: "thank you for trusting us.",
    nextCopy: "Every project is considered carefully. This decision only reflects the current application and studio fit.",
    activeStep: 2,
  },
  cancelled: {
    hero: "cancelled.",
    summary: "This booking has been cancelled. If a deposit was collected, its refund is being returned through the original payment method.",
    nextTitle: "need another date?",
    nextCopy: "Submit a new application whenever you’re ready to request another session.",
    activeStep: 4,
  },
};

const detail = (label, value) => value ? `
  <article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>
` : "";

const render = (application) => {
  const identity = application.artist_name || `${application.first_name} ${application.last_name}`.trim();
  const baseState = stateContent[application.status] || stateContent.new;
  const state = application.status === "confirmed" && application.deposit_status === "waived"
    ? {
        ...baseState,
        summary: "Your application is approved, your deposit has been waived, and your session is confirmed.",
        nextCopy: "We have your session and project details. No deposit is required.",
      }
    : baseState;
  document.title = `${identity} — Application Status`;
  document.querySelector("[data-artist-route]").textContent = `rightmindcreative.co / ${slug(identity)}`;
  document.querySelector("[data-greeting]").textContent = application.first_name
    ? `${application.first_name}, your application is`
    : "your application is";
  document.querySelector("[data-hero-state]").textContent = state.hero;
  const pill = document.querySelector("[data-status-pill]");
  pill.textContent = application.status === "new" ? "received" : application.status;
  pill.className = `public-status-pill is-${application.status}`;
  document.querySelector("[data-status-summary]").textContent = state.summary;
  document.querySelector("[data-details]").innerHTML = [
    detail("Artist / applicant", identity),
    detail("Service", application.service),
    detail("Session length / option", application.service_option),
    detail("Requested date", application.preferred_date ? date(application.preferred_date) : "Flexible / not required"),
    detail("Requested time", application.preferred_time),
    detail("Application received", date(application.created_at)),
    application.decided_at ? detail("Reviewed", date(application.decided_at)) : "",
    detail("Application reference", application.id.slice(0, 8).toUpperCase()),
  ].join("");

  const steps = [
    ["Application received", date(application.created_at)],
    ["Studio review", state.activeStep >= 1 ? (application.decided_at ? "Complete" : "In progress") : "Up next"],
    ["Decision", application.decided_at ? titleCase(application.status) : "Pending"],
    ["Scheduling & next steps", application.status === "approved" ? "Coming next" : "Not started"],
  ];
  document.querySelector("[data-timeline]").innerHTML = steps.map(([label, meta], index) => {
    const complete = index === 0 || (index === 1 && application.decided_at)
      || (index === 2 && application.decided_at);
    const active = (index === 1 && !application.decided_at)
      || (index === 2 && application.decided_at)
      || (index === 3 && application.status === "approved");
    return `<li class="${complete ? "is-complete" : ""} ${active ? "is-active" : ""}">
      <span>${String(index + 1).padStart(2, "0")}</span><div><strong>${escapeHtml(label)}</strong><p>${escapeHtml(meta)}</p></div>
    </li>`;
  }).join("");
  document.querySelector("[data-next-title]").textContent = state.nextTitle;
  document.querySelector("[data-next-copy]").textContent = state.nextCopy;
  const depositAction = document.querySelector("[data-deposit-action]");
  const canPay = ["approved", "payment_pending"].includes(application.status)
    && application.deposit_status === "pending";
  depositAction.hidden = !canPay;
  if (canPay) {
    document.querySelector("[data-deposit-amount]").textContent = new Intl.NumberFormat("en-US", {
      style: "currency", currency: "USD",
    }).format(Number(application.deposit_amount_cents) / 100);
  }

  accessView.hidden = true;
  portal.hidden = false;
  shell.removeAttribute("aria-busy");
};

const fail = (message) => {
  accessView.hidden = true;
  errorView.hidden = false;
  document.querySelector("[data-error-copy]").textContent = message;
  shell.removeAttribute("aria-busy");
};

(() => {
  const params = new URLSearchParams(location.search);
  const token = params.get("token") || "";
  const returningFromPayment = params.get("payment") === "success";
  const sessionKey = `rmc-status-${token}`;
  if (!token) return fail("Open the full private link included in your application email.");

  const loadApplication = async (lastFour, { paymentReturn = false } = {}) => {
    let application;
    for (let attempt = 0; attempt < (paymentReturn ? 6 : 1); attempt += 1) {
      const response = await fetch("/api/application-status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, lastFour }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "This application could not be loaded.");
      application = payload.application;
      if (!paymentReturn || application.status === "confirmed") break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    verifiedLastFour = String(lastFour);
    sessionStorage.setItem(sessionKey, verifiedLastFour);
    render(application);
    if (paymentReturn) {
      history.replaceState(null, "", `/application-status?token=${encodeURIComponent(token)}`);
      requestAnimationFrame(() => document.querySelector(".status-next-card")
        .scrollIntoView({ behavior: "smooth", block: "center" }));
    }
  };

  accessForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    accessError.textContent = "";
    const button = accessForm.querySelector("button");
    button.disabled = true;
    button.textContent = "verifying…";
    const lastFour = new FormData(accessForm).get("lastFour");
    try {
      await loadApplication(lastFour);
    } catch (error) {
      accessError.textContent = error.message;
      button.disabled = false;
      button.innerHTML = "view application <b>↗︎</b>";
      accessForm.querySelector("input").select();
    }
  });
  document.querySelector("[data-pay-deposit]").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const message = document.querySelector("[data-deposit-message]");
    button.disabled = true;
    button.textContent = "opening secure checkout…";
    message.textContent = "";
    try {
      const response = await fetch("/api/application-status/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, lastFour: verifiedLastFour }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Secure checkout could not be opened.");
      sessionStorage.setItem(sessionKey, verifiedLastFour);
      location.assign(payload.checkoutUrl);
    } catch (error) {
      message.textContent = error.message;
      button.disabled = false;
      button.innerHTML = "pay deposit securely <b>↗︎</b>";
    }
  });

  const savedLastFour = sessionStorage.getItem(sessionKey);
  if (returningFromPayment && /^[0-9]{4}$/.test(savedLastFour || "")) {
    accessView.hidden = true;
    loadApplication(savedLastFour, { paymentReturn: true }).catch((error) => fail(error.message));
  }
})();
