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
const money = (cents) => new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD",
}).format(Number(cents || 0) / 100);
const bookingDate = (value) => {
  if (!value) return "Scheduling to be arranged";
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value);
  return new Intl.DateTimeFormat("en-US", {
    month: "long", day: "numeric", year: "numeric",
  }).format(parsed);
};

const buildMessage = ({ application, statusUrl, sender }) => {
  const firstName = application.first_name || "there";
  const amount = money(application.deposit_amount_paid_cents || application.deposit_amount_cents);
  const details = [
    ["Service", application.service],
    ["Session option", application.service_option],
    ["Date", bookingDate(application.preferred_date)],
    ["Time", application.preferred_time || "Scheduling to be arranged"],
    ["Deposit paid", amount],
    ["Booking reference", application.id.slice(0, 8).toUpperCase()],
  ].filter(([, value]) => value);
  const detailText = details.map(([label, value]) => `${label}: ${value}`).join("\r\n");
  const plain = [
    `Hi ${firstName},`, "", "you’re on the books.", "",
    `Your ${amount} deposit has been received and your booking is confirmed.`, "",
    detailText, "", `View your booking details: ${statusUrl}`, "", "Right Mind Creative",
  ].join("\r\n");
  const detailHtml = details.map(([label, value]) => `
    <tr><td style="padding:13px 0;border-bottom:1px solid #383838;color:#8e8e8e;font-size:11px;text-transform:uppercase;letter-spacing:1.4px">${escapeHtml(label)}</td>
    <td align="right" style="padding:13px 0;border-bottom:1px solid #383838;color:#f7f3ed;font-size:14px">${escapeHtml(value)}</td></tr>
  `).join("");
  const html = `<!doctype html><html><body style="margin:0;background:#080808;color:#f7f3ed;font-family:Arial,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#080808;padding:32px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;border:1px solid #444;border-radius:28px;background:#151515"><tr><td style="padding:42px">
<p style="margin:0 0 52px;font-size:20px;font-weight:700">right mind creative.</p>
<p style="margin:0 0 14px;color:#a9a9a9;font-size:11px;letter-spacing:2px;text-transform:uppercase">Payment received</p>
<h1 style="margin:0;font-size:52px;line-height:1;letter-spacing:-2px">you’re on the books.</h1>
<p style="margin:30px 0 12px;font-size:16px;line-height:1.7">Hi ${escapeHtml(firstName)},</p>
<p style="margin:0 0 30px;color:#c7c7c7;font-size:16px;line-height:1.7">Your ${escapeHtml(amount)} deposit has been received and your booking is confirmed.</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 34px">${detailHtml}</table>
<a href="${escapeHtml(statusUrl)}" style="display:inline-block;padding:16px 22px;border-radius:999px;background:#f1ece4;color:#090909;text-decoration:none;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase">view booking details &nbsp;↗</a>
<p style="margin:48px 0 0;color:#777;font-size:11px;line-height:1.6">Questions? Reply to this email or contact welcome@rightmindcreative.co.</p>
</td></tr></table></td></tr></table></body></html>`;
  const boundary = `rmc-payment-${crypto.randomUUID()}`;
  return [
    `From: Right Mind Creative <${safeHeader(sender)}>`,
    `To: ${safeHeader(application.email)}`,
    "Subject: Your Right Mind Creative booking is confirmed",
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "", `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit", "", plain,
    `--${boundary}`, 'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit", "", html, `--${boundary}--`,
  ].join("\r\n");
};

export const sendPaymentConfirmationEmail = async (env, application, statusUrl) => {
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
      raw: base64Url(buildMessage({ application, statusUrl, sender })),
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gmail payment confirmation failed (${response.status}): ${detail.slice(0, 500)}`);
  }
  return response.json();
};
