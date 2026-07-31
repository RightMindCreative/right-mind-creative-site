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

export async function notifySimonOfApplication(application, env, fetchImpl = fetch) {
  const config = notificationConfig(env);
  if (!config.url || !config.secret) return { status: "disabled" };

  try {
    const response = await fetchImpl(config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-simon-webhook-secret": config.secret,
      },
      body: JSON.stringify(applicationSubmittedEvent(application, env)),
    });
    if (!response.ok) {
      console.error("Simon application notification rejected", {
        applicationId: application.id,
        status: response.status,
      });
      return { status: "failed", responseStatus: response.status };
    }
    return { status: "sent" };
  } catch (error) {
    console.error("Simon application notification failed", {
      applicationId: application.id,
      error,
    });
    return { status: "failed" };
  }
}
