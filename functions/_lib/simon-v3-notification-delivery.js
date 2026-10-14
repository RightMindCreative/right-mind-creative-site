import { getGoogleAccessToken } from "./google-auth.js";

const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const STAGING_TEMPLATE = "staging_delivery_probe";

const base64Url = (value) => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const safeHeader = (value) => String(value || "").replace(/[\r\n]+/g, " ").trim();

export const isStagingDeliveryProbe = (data) => (
  data?.channel === "email"
  && data?.template === STAGING_TEMPLATE
  && data?.audience_role === "admin"
  && !data?.recipient_person_id
  && Object.keys(data?.variables || {}).length === 0
);

const configuration = (env) => {
  const recipient = safeHeader(env.SIMON_V3_STAGING_NOTIFICATION_EMAIL).toLowerCase();
  const sender = safeHeader(
    env.DECISION_EMAIL_FROM || env.GOOGLE_EMAIL_IMPERSONATED_USER,
  ).toLowerCase();
  if (env.SIMON_V3_ENVIRONMENT !== "staging"
      || !recipient.endsWith("@rightmindcreative.co")
      || !sender.endsWith("@rightmindcreative.co")
      || !env.GOOGLE_SERVICE_ACCOUNT_EMAIL
      || !env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
    throw new Error("staging_notification_delivery_not_configured");
  }
  return { recipient, sender };
};

const messageFor = ({ recipient, sender, notificationId }) => [
  `From: Right Mind Creative <${sender}>`,
  `To: ${recipient}`,
  "Subject: Simon V3 staging delivery verification",
  `Message-ID: <simon-v3-${safeHeader(notificationId)}@rightmindcreative.co>`,
  "MIME-Version: 1.0",
  'Content-Type: text/plain; charset="UTF-8"',
  "Content-Transfer-Encoding: 8bit",
  "",
  "Simon V3 isolated staging delivery verification.",
  "No client data is included. This message is safe to ignore.",
].join("\r\n");

export async function deliverStagingNotificationProbe(
  env, notificationId, fetchImpl = fetch,
) {
  const { recipient, sender } = configuration(env);
  const accessToken = await getGoogleAccessToken(env, {
    scope: GMAIL_SEND_SCOPE,
    delegatedUser: env.GOOGLE_EMAIL_IMPERSONATED_USER || sender,
    fetchImpl,
  });
  const send = await fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      raw: base64Url(messageFor({ recipient, sender, notificationId })),
    }),
  });
  if (!send.ok) throw new Error("gmail_send_not_confirmed");
  const sent = await send.json();
  if (!sent?.id) throw new Error("gmail_send_receipt_missing");

  const verify = await fetchImpl(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(sent.id)}?format=minimal`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  if (!verify.ok) throw new Error("gmail_receipt_not_verified");
  const verified = await verify.json();
  if (verified?.id !== sent.id || !verified?.labelIds?.includes("SENT")) {
    throw new Error("gmail_receipt_not_verified");
  }
  return {
    provider: "gmail",
    receipt_ref: sent.id,
    verified_at: new Date().toISOString(),
  };
}
