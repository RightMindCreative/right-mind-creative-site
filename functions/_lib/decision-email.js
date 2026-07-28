import { getGoogleAccessToken } from "./google-auth.js";

const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const DEFAULT_SENDER = "welcome@rightmindcreative.co";

const base64Url = (value) => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};
const safeHeader = (value) => String(value || "").replace(/[\r\n]+/g, " ").trim();
const escapeHtml = (value) => String(value || "").replace(/&/g, "&amp;")
  .replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const copyFor = (decision) => decision === "approved"
  ? {
      heading: "your application has been approved.",
      body: "We’d love to move forward with your project. Your application status page will contain the next steps as they become available.",
      action: "view approved application",
    }
  : {
      heading: "your application has been reviewed.",
      body: "Thank you for taking the time to share your work with Right Mind Creative. We’re unable to move forward with this application, but we appreciate the opportunity to learn about your project.",
      action: "view application status",
    };

const buildMessage = ({ application, decision, statusUrl, sender }) => {
  const copy = copyFor(decision);
  const firstName = application.first_name || "there";
  const subject = "Your Right Mind Creative application has been reviewed";
  const plain = [
    `Hi ${firstName},`, "", copy.heading, "", copy.body, "",
    `To view your application status, visit: ${statusUrl}`, "",
    "Right Mind Creative",
  ].join("\r\n");
  const html = `<!doctype html><html><body style="margin:0;background:#080808;color:#f7f3ed;font-family:Arial,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#080808;padding:32px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;border:1px solid #444;border-radius:28px;background:#151515"><tr><td style="padding:42px">
<p style="margin:0 0 52px;font-size:20px;font-weight:700">right mind creative.</p>
<p style="margin:0 0 14px;color:#a9a9a9;font-size:11px;letter-spacing:2px;text-transform:uppercase">Application update</p>
<h1 style="margin:0;font-size:46px;line-height:1.02;letter-spacing:-2px">${escapeHtml(copy.heading)}</h1>
<p style="margin:30px 0 12px;font-size:16px;line-height:1.7">Hi ${escapeHtml(firstName)},</p>
<p style="margin:0 0 32px;color:#c7c7c7;font-size:16px;line-height:1.7">${escapeHtml(copy.body)}</p>
<a href="${escapeHtml(statusUrl)}" style="display:inline-block;padding:16px 22px;border-radius:999px;background:#f1ece4;color:#090909;text-decoration:none;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase">${escapeHtml(copy.action)} &nbsp;↗</a>
<p style="margin:50px 0 0;color:#777;font-size:11px;line-height:1.6">This message was sent regarding your ${escapeHtml(application.service)} application.</p>
</td></tr></table></td></tr></table></body></html>`;
  const boundary = `rmc-${crypto.randomUUID()}`;
  return [
    `From: Right Mind Creative <${safeHeader(sender)}>`,
    `To: ${safeHeader(application.email)}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "", `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit", "", plain,
    `--${boundary}`, 'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit", "", html, `--${boundary}--`,
  ].join("\r\n");
};

export const decisionEmailIsConfigured = (env) => Boolean(
  env.GOOGLE_SERVICE_ACCOUNT_EMAIL
  && env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
  && (env.GOOGLE_EMAIL_IMPERSONATED_USER || env.DECISION_EMAIL_FROM),
);

export const sendDecisionEmail = async (env, application, decision, statusUrl) => {
  const sender = env.DECISION_EMAIL_FROM || env.GOOGLE_EMAIL_IMPERSONATED_USER || DEFAULT_SENDER;
  const accessToken = await getGoogleAccessToken(env, {
    scope: GMAIL_SEND_SCOPE,
    delegatedUser: env.GOOGLE_EMAIL_IMPERSONATED_USER || sender,
  });
  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      raw: base64Url(buildMessage({ application, decision, statusUrl, sender })),
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gmail send failed (${response.status}): ${detail.slice(0, 500)}`);
  }
  return response.json();
};
