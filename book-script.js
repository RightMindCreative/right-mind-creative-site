const bookingReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const bookingReveals = document.querySelectorAll(".booking-reveal");
const bookingObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    entry.target.classList.add("is-visible");
    bookingObserver.unobserve(entry.target);
  });
}, { threshold: 0.1 });
bookingReveals.forEach((element, index) => {
  element.style.transitionDelay = `${(index % 3) * 70}ms`;
  bookingObserver.observe(element);
});

const filterButtons = document.querySelectorAll("[data-filter]");
const serviceCards = document.querySelectorAll("[data-category]");
filterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    filterButtons.forEach((item) => item.classList.toggle("is-active", item === button));
    serviceCards.forEach((card) => {
      card.hidden = card.dataset.category !== button.dataset.filter;
      if (!card.hidden) requestAnimationFrame(() => card.classList.add("is-visible"));
    });
  });
});
const requestedCategory = new URLSearchParams(window.location.search).get("category");
const requestedFilter = [...filterButtons].find((button) => button.dataset.filter === requestedCategory);
if (requestedFilter) {
  requestedFilter.click();
  requestAnimationFrame(() => document.querySelector("#services").scrollIntoView({ block: "start" }));
}

const overlay = document.querySelector("[data-booking-overlay]");
const form = document.querySelector(".booking-form");
const steps = [...document.querySelectorAll(".booking-step")];
const progressItems = [...document.querySelectorAll(".booking-progress span")];
const selectedService = document.querySelector(".selected-service");
const summary = document.querySelector(".booking-summary");
const bookingProgress = document.querySelector(".booking-progress");
const firstNextButton = document.querySelector("[data-first-next]");
let currentStep = 1;
let selectedCard = null;
let calendarCursor = new Date();
calendarCursor.setDate(1);

const formatDate = (value) => new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date(`${value}T12:00:00`));
const getSessionHours = () => {
  const selectedLength = form.elements.serviceOption.value;
  return selectedLength === "Full day" ? 12 : Number.parseInt(selectedLength, 10);
};
const serviceOptionField = document.querySelector(".service-option-field");
const serviceOptionSelect = serviceOptionField.querySelector("select");
const vocalRecordingFields = [...document.querySelectorAll(".vocal-recording-field")];
const generalProjectField = document.querySelector(".general-project-field");
const mixingField = document.querySelector(".mixing-field");
const projectUploadField = document.querySelector(".project-upload-field");

const setServiceOptions = (card) => {
  const category = card.dataset.category;
  const service = card.dataset.service;
  let label = "Session length";
  let options = ["2 hours", "3 hours", "4 hours", "6 hours", "8 hours", "Full day"];

  if (category === "mixing") {
    label = "Number of songs";
    options = ["1 song", "2 songs", "3–5 songs", "6+ songs"];
  } else if (category === "packages" && service === "The Complete Single") {
    label = "Starting point";
    options = ["Idea / voice memo", "Lyrics and melody", "Demo recording", "Existing production", "Not sure yet"];
  } else if (category === "packages") {
    label = "Project scope";
    options = ["2–4 song EP", "5–8 song project", "Full album", "Campaign / multimedia project", "Something else"];
  }

  serviceOptionField.querySelector("span").textContent = label;
  serviceOptionSelect.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Choose one";
  serviceOptionSelect.append(placeholder);
  options.forEach((option) => {
    const item = document.createElement("option");
    item.textContent = option;
    serviceOptionSelect.append(item);
  });
  serviceOptionField.dataset.summaryLabel = label;
};

const setProjectFields = (card) => {
  const isVocalRecording = card.dataset.service === "Vocal Recording Session";
  const isMixing = card.dataset.category === "mixing";
  const isCompleteSingle = card.dataset.service === "The Complete Single";
  const isCustomProject = card.dataset.service === "Custom Project";
  const usesRecordingFields = isVocalRecording || card.dataset.category === "production";
  vocalRecordingFields.forEach((field) => {
    field.hidden = !usesRecordingFields;
    field.querySelectorAll("input, textarea").forEach((input) => {
      input.disabled = !usesRecordingFields;
      input.required = usesRecordingFields && input.name === "artistName";
    });
  });
  generalProjectField.hidden = false;
  const notes = generalProjectField.querySelector("textarea");
  notes.disabled = false;
  notes.required = isCustomProject;
  const projectLabel = generalProjectField.querySelector(".general-project-label");
  projectLabel.innerHTML = isCustomProject
    ? 'Describe your project <b class="required-mark" aria-hidden="true">*</b>'
    : "Any additional information";
  notes.placeholder = isCustomProject
    ? "Tell us what you’re building, where it currently stands, and what kind of support you’re looking for."
    : "Share anything else that would help us prepare for your session.";
  mixingField.hidden = !isMixing;
  const stemCount = mixingField.querySelector("input");
  stemCount.disabled = !isMixing;
  stemCount.required = isMixing;
  const usesProjectUpload = usesRecordingFields || isMixing || isCompleteSingle;
  projectUploadField.hidden = !usesProjectUpload;
  projectUploadField.querySelector("input").disabled = !usesProjectUpload;
};

const isCustomProjectFlow = () => selectedCard?.dataset.service === "Custom Project";
const usesCalendar = () => selectedCard?.dataset.category !== "mixing" && !isCustomProjectFlow();

const showStep = (step) => {
  currentStep = step;
  steps.forEach((panel) => {
    const active = Number(panel.dataset.step) === step;
    panel.hidden = !active;
    panel.classList.toggle("is-active", active);
  });
  progressItems.forEach((item, index) => item.classList.toggle("is-active", index <= Math.min(step - 1, 3)));
  document.querySelector(".booking-panel").scrollTop = 0;
  if (step === 4) buildSummary();
};

const openBooking = (card) => {
  selectedCard = card;
  selectedService.querySelector("img").src = card.dataset.image;
  selectedService.querySelector("h2").textContent = card.dataset.service;
  selectedService.querySelector("p").textContent = "Right Mind Creative / Application";
  setServiceOptions(card);
  setProjectFields(card);
  const calendarEnabled = card.dataset.category !== "mixing";
  const customProject = card.dataset.service === "Custom Project";
  bookingProgress.classList.toggle("is-calendarless", !calendarEnabled && !customProject);
  bookingProgress.classList.toggle("is-project-only", customProject);
  firstNextButton.firstChild.textContent = calendarEnabled ? "preferred availability " : "your details ";
  form.reset();
  calendarCursor = new Date();
  calendarCursor.setDate(1);
  renderCalendar();
  showStep(customProject ? 3 : 1);
  overlay.hidden = false;
  document.body.style.overflow = "hidden";
  document.querySelector(".booking-close").focus();
};
document.querySelectorAll(".book-service").forEach((button) => button.addEventListener("click", () => openBooking(button.closest(".booking-service-card"))));

const closeBooking = () => {
  overlay.hidden = true;
  document.body.style.overflow = "";
  selectedCard?.querySelector(".book-service")?.focus();
};
document.querySelector(".booking-close").addEventListener("click", closeBooking);
overlay.addEventListener("click", (event) => { if (event.target === overlay) closeBooking(); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !overlay.hidden) closeBooking(); });

const validateStep = () => {
  if (currentStep === 2) {
    const hasDateAndTime = Boolean(form.elements.date.value && form.elements.time.value);
    const error = document.querySelector(".schedule-error");
    error.hidden = hasDateAndTime;
    document.querySelector(".time-column").classList.toggle("is-invalid", !hasDateAndTime);
    return hasDateAndTime;
  }
  const panel = steps.find((item) => Number(item.dataset.step) === currentStep);
  const fields = [...panel.querySelectorAll("input[required], select[required], textarea[required]")];
  return fields.every((field) => field.reportValidity());
};
document.querySelectorAll("[data-next]").forEach((button) => button.addEventListener("click", () => {
  if (validateStep()) showStep(!usesCalendar() && currentStep === 1 ? 3 : currentStep + 1);
}));
document.querySelectorAll("[data-back]").forEach((button) => button.addEventListener("click", () => {
  if (isCustomProjectFlow() && currentStep === 3) {
    closeBooking();
  } else {
    showStep(!usesCalendar() && currentStep === 3 ? 1 : currentStep - 1);
  }
}));

const renderCalendar = () => {
  const monthLabel = document.querySelector(".calendar-month");
  const days = document.querySelector(".calendar-days");
  monthLabel.textContent = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(calendarCursor);
  days.replaceChildren();
  const year = calendarCursor.getFullYear();
  const month = calendarCursor.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const dayCount = new Date(year, month + 1, 0).getDate();
  for (let index = 0; index < firstDay; index += 1) days.append(document.createElement("span"));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let day = 1; day <= dayCount; day += 1) {
    const date = new Date(year, month, day);
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = day;
    const sessionHours = getSessionHours();
    const cannotFitSunday = date.getDay() === 0 && Number.isFinite(sessionHours) && 13 + sessionHours > 24;
    button.disabled = date < today || date.getDay() === 1 || cannotFitSunday;
    const value = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    button.setAttribute("aria-label", formatDate(value));
    button.addEventListener("click", () => selectDate(value, button));
    days.append(button);
  }
};

const selectDate = (value, button) => {
  document.querySelectorAll(".calendar-days button").forEach((item) => item.classList.toggle("is-selected", item === button));
  form.elements.date.value = value;
  form.elements.time.value = "";
  document.querySelector(".schedule-error").hidden = true;
  document.querySelector(".time-column").classList.remove("is-invalid");
  document.querySelector(".selected-date-label").textContent = formatDate(value);
  const slots = document.querySelector(".time-slots");
  slots.replaceChildren();
  const selectedDate = new Date(`${value}T12:00:00`);
  const sessionHours = getSessionHours();
  const latestStartHour = Number.isFinite(sessionHours) ? 24 - sessionHours : 22;
  const firstStartHour = selectedDate.getDay() === 0 ? 13 : 10;
  const availableTimes = Array.from({ length: Math.max(0, latestStartHour - firstStartHour + 1) }, (_, index) => {
    const hour = index + 10;
    const displayHour = hour > 12 ? hour - 12 : hour;
    return `${displayHour}:00 ${hour >= 12 ? "PM" : "AM"}`;
  });
  const latestStart = availableTimes.at(-1);
  document.querySelector(".time-wheel-hint").textContent = latestStart
    ? `Scroll and select a time · latest start ${latestStart}`
    : "No start times available for this session length";
  availableTimes.forEach((time) => {
    const slot = document.createElement("button");
    slot.type = "button";
    slot.textContent = time;
    slot.setAttribute("role", "option");
    slot.setAttribute("aria-selected", "false");
    slot.addEventListener("click", () => {
      slots.querySelectorAll("button").forEach((item) => {
        const selected = item === slot;
        item.classList.toggle("is-selected", selected);
        item.setAttribute("aria-selected", String(selected));
      });
      form.elements.time.value = time;
      slot.scrollIntoView({ block: "center", behavior: bookingReducedMotion ? "auto" : "smooth" });
      document.querySelector(".schedule-error").hidden = true;
      document.querySelector(".time-column").classList.remove("is-invalid");
    });
    slots.append(slot);
  });
};

document.querySelectorAll("[data-month]").forEach((button) => button.addEventListener("click", () => {
  calendarCursor.setMonth(calendarCursor.getMonth() + Number(button.dataset.month));
  renderCalendar();
}));

const buildSummary = () => {
  const data = new FormData(form);
  const items = isCustomProjectFlow()
    ? [["Guest", `${data.get("firstName")} ${data.get("lastName")}`], ["Email", data.get("email")], ["Project", data.get("notes")]]
    : [
      ["Application direction", selectedCard.dataset.service],
      [serviceOptionField.dataset.summaryLabel, data.get("serviceOption")],
      ["Guest", `${data.get("firstName")} ${data.get("lastName")}`],
      ["Email", data.get("email")],
    ];
  if (usesCalendar()) {
    items.splice(1, 0, ["Preferred date & time", `${formatDate(data.get("date"))} at ${data.get("time")}`]);
  }
  if (selectedCard.dataset.category === "mixing") {
    items.push(["Number of Stems/Trackouts", data.get("stemCount")]);
  }
  if (selectedCard.dataset.service === "Vocal Recording Session" || selectedCard.dataset.category === "production" || selectedCard.dataset.category === "mixing" || selectedCard.dataset.service === "The Complete Single") {
    const uploadedFiles = [...form.elements.projectFiles.files].map((file) => file.name).join(", ") || "No files added";
    items.push(["Files", uploadedFiles]);
  }
  if (selectedCard.dataset.service === "Vocal Recording Session" || selectedCard.dataset.category === "production") {
    items.push(
      ["Artist name", data.get("artistName")],
      ["Phone", data.get("phone")],
      ["Social links", data.get("socialLinks")]
    );
  }
  summary.replaceChildren(...items.map(([label, value]) => {
    const item = document.createElement("div");
    item.className = "summary-item";
    item.innerHTML = `<span>${label}</span><strong>${value}</strong>`;
    return item;
  }));
};

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (validateStep()) showStep(5);
});
document.querySelector("[data-finish]").addEventListener("click", closeBooking);
renderCalendar();
