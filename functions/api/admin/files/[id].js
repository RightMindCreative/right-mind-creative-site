import { json, requireAdmin } from "../../../_lib/admin-auth.js";

const safeFilename = (value) => String(value || "file")
  .replace(/[\r\n"]/g, "")
  .slice(0, 180);

export async function onRequestGet(context) {
  const unauthorized = await requireAdmin(context);
  if (unauthorized) return unauthorized;

  const file = await context.env.APPLICATIONS_DB.prepare(`
    SELECT object_key, original_name, content_type
    FROM application_files
    WHERE id = ?
  `).bind(context.params.id).first();
  if (!file) return json({ error: "File not found." }, 404);

  const object = await context.env.APPLICATION_UPLOADS.get(file.object_key);
  if (!object) return json({ error: "The stored file could not be found." }, 404);

  return new Response(object.body, {
    headers: {
      "content-type": file.content_type || object.httpMetadata?.contentType || "application/octet-stream",
      "content-length": String(object.size),
      "content-disposition": `inline; filename="${safeFilename(file.original_name)}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
