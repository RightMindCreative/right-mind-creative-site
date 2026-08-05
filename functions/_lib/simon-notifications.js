const notificationConfig = (env) => ({
  url: String(env.SIMON_APPLICATION_WEBHOOK_URL || "").trim(),
  secret: String(env.SIMON_APPLICATION_WEBHOOK_SECRET || "").trim(),
  publicSiteUrl: String(env.PUBLIC_SITE_URL || "https://www.rightmindcreative.co").replace(/\/$/, ""),
});

const employeeSessionStartsAt = (date, time) => {
  const match = String(time || "").match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  const twentyFourHour = String(time || "").match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match && !twentyFourHour) return "";
  let hour = Number((match || twentyFourHour)[1]);
  const minute = (match || twentyFourHour)[2];
  if (match?.[3].toUpperCase() === "PM" && hour !== 12) hour += 12;
  if (match?.[3].toUpperCase() === "AM" && hour === 12) hour = 0;
  const probe = new Date(`${date}T12:00:00Z`);
  const zoneName = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", timeZoneName: "longOffset",
  }).formatToParts(probe).find((part) => part.type === "timeZoneName")?.value || "GMT-06:00";
  return `${date}T${String(hour).padStart(2, "0")}:${minute}:00${zoneName.replace("GMT", "")}`;
};

export const applicationSubmittedEvent = (application, env) => {
  const config = notificationConfig(env);
  return {
    id: `application-submitted:${application.id}`,
    type: "application.submitted",
    application: {
      id: application.id,
      applicantName: `${application.firstName} ${application.lastName}`.trim(),
      artistName: application.artistName || "",
      serviceName: application.service,
      serviceOption: application.serviceOption || "",
      preferredDate: application.preferredDate || "",
      preferredTime: application.preferredTime || "",
      reviewUrl: `${config.publicSiteUrl}/admin?application=${encodeURIComponent(application.id)}`,
    },
  };
};

const artistContactEvent = (application, type, idPrefix) => ({
  id: `${idPrefix}:${application.id}`,
  type,
  application: {
    id: application.id,
    firstName: application.first_name || application.firstName || "",
    lastName: application.last_name || application.lastName || "",
    artistName: application.artist_name || application.artistName || "",
    email: application.email || "",
    phone: application.phone || "",
  },
});

export const applicationApprovedEvent = (application) => (
  artistContactEvent(application, "application.approved", "application-approved")
);

export const bookingConfirmedEvent = (application) => (
  artistContactEvent(application, "booking.confirmed", "booking-confirmed")
);

export const engineerAssignmentRespondedEvent = (assignment, application, env) => {
  const config = notificationConfig(env);
  return {
    id: `engineer-assignment-responded:${assignment.id}:${assignment.state}`,
    type: "engineer.assignment_responded",
    assignment: {
      id: assignment.id,
      engineerName: assignment.employee_name || "Jake Kaiser",
      status: assignment.state,
      responseNote: assignment.response_note || "",
      artistName: application.artist_name
        || `${application.first_name || ""} ${application.last_name || ""}`.trim(),
      serviceName: application.service || "session",
      preferredDate: application.preferred_date || "",
      preferredTime: application.preferred_time || "",
      reviewUrl: `${config.publicSiteUrl}/admin?application=${encodeURIComponent(application.id)}`,
    },
  };
};

export const engineerAssignmentRequestedEvent = (assignment, application, env) => {
  const config = notificationConfig(env);
  const artist = application.artist_name || `${application.first_name || ""} ${application.last_name || ""}`.trim();
  const responseUrl = `${config.publicSiteUrl}/team/?session=${encodeURIComponent(application.id)}&view=requests`;
  return {
    id: `engineer-assignment-requested:${assignment.id}:${assignment.updated_at}`,
    type: "engineer.assignment_requested",
    assignment: {
      id: assignment.id,
      engineerName: assignment.employee_name,
      sessionDescription: `${artist} · ${application.service}`,
      startsAt: employeeSessionStartsAt(application.preferred_date, application.preferred_time),
      responseUrl,
    },
  };
};

const notifySimon = async (event, applicationId, env, fetchImpl) => {
  const config = notificationConfig(env);
  if (!config.url || !config.secret) return { status: "disabled" };

  try {
    const response = await fetchImpl(config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-simon-webhook-secret": config.secret,
      },
      body: JSON.stringify(event),
    });
    if (!response.ok) {
      console.error("Simon application notification rejected", {
        applicationId, status: response.status,
      });
      return { status: "failed", responseStatus: response.status };
    }
    return { status: "sent" };
  } catch (error) {
    console.error("Simon application notification failed", { applicationId, error });
    return { status: "failed" };
  }
};

export async function notifySimonOfApplication(application, env, fetchImpl = fetch) {
  return notifySimon(applicationSubmittedEvent(application, env), application.id, env, fetchImpl);
}

export async function notifySimonOfApproval(application, env, fetchImpl = fetch) {
  return notifySimon(applicationApprovedEvent(application), application.id, env, fetchImpl);
}

export async function notifySimonOfBooking(application, env, fetchImpl = fetch) {
  return notifySimon(bookingConfirmedEvent(application), application.id, env, fetchImpl);
}

export async function notifySimonOfEngineerResponse(
  assignment, application, env, fetchImpl = fetch,
) {
  return notifySimon(
    engineerAssignmentRespondedEvent(assignment, application, env),
    application.id,
    env,
    fetchImpl,
  );
}

export async function notifySimonOfEngineerAssignment(
  assignment, application, env, fetchImpl = fetch,
) {
  return notifySimon(
    engineerAssignmentRequestedEvent(assignment, application, env),
    application.id,
    env,
    fetchImpl,
  );
}
