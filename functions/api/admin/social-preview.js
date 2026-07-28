import { json, requireAdmin } from "../../_lib/admin-auth.js";

const ALLOWED_HOSTS = [
  "instagram.com",
  "tiktok.com",
  "youtube.com",
  "youtu.be",
  "spotify.com",
  "soundcloud.com",
  "threads.net",
  "x.com",
  "twitter.com",
  "facebook.com",
];

const isAllowedHost = (hostname) => ALLOWED_HOSTS.some(
  (host) => hostname === host || hostname.endsWith(`.${host}`),
);

const decodeEntities = (value = "") => value
  .replace(/&amp;/gi, "&")
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">");

const attributes = (tag) => {
  const result = {};
  for (const match of tag.matchAll(/([:\w-]+)\s*=\s*(["'])(.*?)\2/gs)) {
    result[match[1].toLowerCase()] = decodeEntities(match[3].trim());
  }
  return result;
};

const metadata = (html) => {
  const values = {};
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    const key = (attrs.property || attrs.name || "").toLowerCase();
    if (key && attrs.content && !values[key]) values[key] = attrs.content;
  }
  return {
    image: values["og:image:secure_url"] || values["og:image"] || values["twitter:image"],
    title: values["og:title"] || values["twitter:title"],
    description: values["og:description"] || values.description || values["twitter:description"],
  };
};

export async function onRequestGet(context) {
  const unauthorized = await requireAdmin(context);
  if (unauthorized) return unauthorized;

  const requested = new URL(context.request.url).searchParams.get("url");
  let socialUrl;
  try {
    socialUrl = new URL(requested);
  } catch {
    return json({ error: "Invalid social URL." }, 400);
  }
  if (socialUrl.protocol !== "https:" || !isAllowedHost(socialUrl.hostname.toLowerCase())) {
    return json({ error: "That social platform is not supported." }, 400);
  }

  try {
    const response = await fetch(socialUrl.toString(), {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "Mozilla/5.0 (compatible; RightMindCreativePreview/1.0; +https://rightmindcreative.co)",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(7000),
    });
    const finalUrl = new URL(response.url);
    if (!response.ok || !isAllowedHost(finalUrl.hostname.toLowerCase())) {
      return json({ image: "", title: "", description: "" });
    }
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) {
      return json({ image: "", title: "", description: "" });
    }
    const html = (await response.text()).slice(0, 750_000);
    const preview = metadata(html);
    if (preview.image) {
      try {
        preview.image = new URL(preview.image, finalUrl).toString();
      } catch {
        preview.image = "";
      }
    }
    return json(preview, 200, { "cache-control": "private, max-age=3600" });
  } catch {
    return json({ image: "", title: "", description: "" });
  }
}
