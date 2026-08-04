const notificationConfig = (env) => ({
  url: String(env.SIMON_APPLICATION_WEBHOOK_URL || "").trim(),
  secret: String(env.SIMON_APPLICATION_WEBHOOK_SECRET || "").trim(),
  publicSiteUrl: String(env.PUBLIC_SITE_URL || "https://www.rightmindcreative.co").replace(/\/$/, ""),
});

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
