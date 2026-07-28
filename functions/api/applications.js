const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES = 50 * 1024 * 1024;
const ALLOWED_FILE_TYPES = new Set([
  "application/msword",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/zip",
  "audio/aac",
  "audio/flac",
  "audio/m4a",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/x-m4a",
  "audio/x-wav",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
]);

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  },
});

const text = (form, key, maxLength = 500) => String(form.get(key) || "").trim().slice(0, maxLength);
const safeObjectName = (name) => name
  .normalize("NFKD")
  .replace(/[^\w.-]+/g, "-")
  .replace(/-+/g, "-")
  .replace(/^-|-$/g, "")
  .slice(0, 120) || "upload";

const validate = (application) => {
  const errors = [];
  if (!application.service) errors.push("Choose an application direction.");
  if (!application.firstName) errors.push("First name is required.");
  if (!application.lastName) errors.push("Last name is required.");
  if (!application.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(application.email)) {
    errors.push("Enter a valid email address.");
  }
  if (!application.phone) errors.push("Phone number is required.");
  if (application.usesCalendar && (!application.preferredDate || !application.preferredTime)) {
    errors.push("Choose a preferred date and time.");
  }
  if (application.category === "mixing" && (!application.stemCount || Number(application.stemCount) < 1)) {
    errors.push("Enter the number of stems or trackouts.");
  }
  if (application.service === "Custom Project" && !application.notes) {
    errors.push("Describe your custom project.");
  }
  return errors;
};

export async function onRequestPost(context) {
  if (!context.env.APPLICATIONS_DB || !context.env.APPLICATION_UPLOADS) {
    return json({ error: "The application service is not configured yet." }, 503);
  }

  let form;
  try {
    form = await context.request.formData();
  } catch {
    return json({ error: "The submitted application could not be read." }, 400);
  }

  const category = text(form, "category", 50);
  const service = text(form, "service", 120);
  const application = {
    category,
    service,
    serviceOption: text(form, "serviceOption", 120),
    preferredDate: text(form, "date", 20),
    preferredTime: text(form, "time", 20),
    firstName: text(form, "firstName", 100),
    lastName: text(form, "lastName", 100),
    artistName: text(form, "artistName", 160),
    email: text(form, "email", 254).toLowerCase(),
    phone: text(form, "phone", 50),
    stemCount: text(form, "stemCount", 10),
    socialLinks: text(form, "socialLinks", 2000),
    notes: text(form, "notes", 5000),
    usesCalendar: category !== "mixing" && service !== "Custom Project",
  };

  const validationErrors = validate(application);
  if (validationErrors.length) return json({ error: validationErrors[0], errors: validationErrors }, 422);

  const files = form.getAll("projectFiles").filter((item) => item instanceof File && item.size > 0);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (files.some((file) => file.size > MAX_FILE_BYTES)) {
    return json({ error: "Each uploaded file must be 25 MB or smaller." }, 413);
  }
  if (totalBytes > MAX_TOTAL_FILE_BYTES) {
    return json({ error: "Uploaded files must total 50 MB or less." }, 413);
  }
  if (files.some((file) => file.type && !ALLOWED_FILE_TYPES.has(file.type))) {
    return json({ error: "One or more uploaded file types are not supported." }, 415);
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const storedFiles = [];

  try {
    for (const file of files) {
      const fileId = crypto.randomUUID();
      const objectKey = `applications/${id}/${fileId}-${safeObjectName(file.name)}`;
      await context.env.APPLICATION_UPLOADS.put(objectKey, file.stream(), {
        httpMetadata: { contentType: file.type || "application/octet-stream" },
        customMetadata: { applicationId: id, originalName: file.name },
      });
      storedFiles.push({ id: fileId, objectKey, name: file.name, type: file.type, size: file.size });
    }

    const statements = [
      context.env.APPLICATIONS_DB.prepare(`
        INSERT INTO applications (
          id, created_at, status, category, service, service_option,
          preferred_date, preferred_time, first_name, last_name, artist_name,
          email, phone, stem_count, social_links, notes
        ) VALUES (?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id, createdAt, category, service, application.serviceOption,
        application.preferredDate, application.preferredTime, application.firstName,
        application.lastName, application.artistName, application.email,
        application.phone, application.stemCount || null, application.socialLinks,
        application.notes
      ),
      ...storedFiles.map((file) => context.env.APPLICATIONS_DB.prepare(`
        INSERT INTO application_files (
          id, application_id, object_key, original_name, content_type, size_bytes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(file.id, id, file.objectKey, file.name, file.type, file.size, createdAt)),
    ];
    await context.env.APPLICATIONS_DB.batch(statements);
  } catch (error) {
    if (storedFiles.length) {
      await context.env.APPLICATION_UPLOADS.delete(storedFiles.map((file) => file.objectKey)).catch(() => {});
    }
    console.error("Application submission failed", { id, error });
    return json({ error: "We couldn’t save the application. Please try again." }, 500);
  }

  return json({ id, status: "received" }, 201);
}

export function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return json({ error: "Method not allowed." }, 405);
}
