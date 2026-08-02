import { json } from "./admin-auth.js";

const same = (left, right) => {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
};

export const requireSimonService = (context) => {
  if (!context.env.APPLICATIONS_DB || !context.env.SIMON_SERVICE_TOKEN) {
    return json({ error: "The Simon service API is not configured." }, 503);
  }
  const header = context.request.headers.get("authorization") || "";
  const token = header.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  if (!same(token, String(context.env.SIMON_SERVICE_TOKEN))) {
    return json({ error: "Service authentication required." }, 401);
  }
  return null;
};
