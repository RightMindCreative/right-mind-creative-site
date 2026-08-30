# Right Mind Creative iOS booking integration

This is the implementation handoff for the client iOS app and any trusted companion backend.

## Canonical files and URLs

- Production base URL: `https://www.rightmindcreative.co`
- OpenAPI contract: `https://www.rightmindcreative.co/right-mind-booking-openapi.json`
- Live client configuration: `https://www.rightmindcreative.co/api/mobile/config`
- Repository contract: `/right-mind-booking-openapi.json`

The OpenAPI contract is authoritative for paths, methods, parameters, payloads, security tiers, and response shapes. The live config is authoritative for services, duration options, hours, upload limits, status vocabulary, and the 48-hour lead-time rule.

## Security boundary

There are two distinct API tiers.

### Client tier — safe to call from the iOS app

- `GET /api/mobile/config`
- `GET /api/availability`
- `POST /api/applications`
- `POST /api/application-status`
- `POST /api/application-status/checkout`

These reproduce the public website booking journey. Application status and deposit checkout require both the private application UUID token and the last four digits of the submitted phone number.

### Companion-server tier — never call directly from a distributed app

Routes under `/api/simon/*` can change applications, Google Calendar events, bookings, deposits, and employee assignments. They require `Authorization: Bearer <SIMON_SERVICE_TOKEN>`.

Do **not** place that token in Swift source, an asset, `Info.plist`, UserDefaults, Keychain bootstrap data, Firebase Remote Config, or a public repository. An App Store binary is an untrusted client and its secrets can be extracted.

If the iOS product needs owner/staff controls, route them through a trusted backend that:

1. Authenticates the signed-in staff member.
2. Authorizes the requested action by role.
3. Adds `SIMON_SERVICE_TOKEN` server-side.
4. Adds a fresh UUID `Idempotency-Key` to every mutation.
5. Records a request ID and audit event.

Client users should not receive studio-wide application or calendar mutation permissions. Client reschedule/cancellation features need dedicated applicant-scoped endpoints before shipping; do not proxy unrestricted `/api/simon/*` access to clients.

## Booking flow

1. Fetch `/api/mobile/config` at launch and cache it for offline display.
2. The user chooses a service and one of its `durationOptions` in minutes.
3. For calendar-based sessions, query `/api/availability?date=YYYY-MM-DD&duration=HOURS`.
4. Interpret each returned `slots` integer as a local start hour in `America/Chicago`.
5. Submit `multipart/form-data` to `/api/applications`.
6. Save the returned application `id` and the UUID token contained in `statusUrl` securely in Keychain.
7. Verify status using the token plus the phone's last four digits.
8. When `deposit_status` is `pending`, request a Stripe Checkout URL and open it in `ASWebAuthenticationSession` or the system browser.
9. Refresh application status after returning from Stripe. The webhook is authoritative; do not mark a deposit paid from the browser redirect alone.

## Current rules

- Time zone: `America/Chicago`
- Minimum advance notice: 48 hours
- Monday: closed
- Sunday: opens at 1:00 PM
- Tuesday–Saturday: opens at 10:00 AM
- Sessions cannot extend beyond midnight
- Calendar availability is returned only for start times that satisfy the complete duration
- Each upload: at most 25 MB
- All uploads together: at most 50 MB
- Primary audio types: WAV/WAVE, MP3, AIF, AIFF
- Mixing & Mastering and Custom Project do not use the client calendar flow

## Service-specific application fields

All applications require `category`, `service`, `firstName`, `lastName`, `email`, and `phone`.

- Calendar-based recording/production: also send `serviceOption`, `date`, and `time`.
- Vocal Recording and Production: include artist name and social links when available.
- Mixing & Mastering: `stemCount` is required; no preferred calendar slot.
- Custom Project: `notes` must describe the project; no preferred calendar slot.
- The Complete Single: optional project files are supported.

Use the exact service `name` and `category` returned by `/api/mobile/config`; do not invent or normalize display values locally.

## Upload implementation notes

Build one multipart field named `projectFiles` per file. Preserve the original filename and use the best available MIME type. Apple audio files may arrive as `audio/aiff`, `audio/x-aiff`, `audio/aif`, `audio/x-aif`, or `application/octet-stream`; the backend also validates approved extensions when a browser/device omits a useful MIME type.

Do not compress, transcode, or alter the audio automatically. Show aggregate upload progress and surface server status `413` and `415` messages verbatim.

## Swift model bootstrap

```swift
struct BookingConfig: Decodable {
    let apiVersion: String
    let timeZone: String
    let minimumLeadTimeHours: Int
    let services: [Service]
    let uploads: UploadRules
}

struct Service: Decodable, Identifiable {
    let id: String
    let name: String
    let category: String
    let durationOptions: [Int]
}

struct UploadRules: Decodable {
    let maximumFileBytes: Int
    let maximumTotalBytes: Int
    let primaryAudioExtensions: [String]
}

let baseURL = URL(string: "https://www.rightmindcreative.co")!
let configURL = baseURL.appending(path: "api/mobile/config")
let (data, response) = try await URLSession.shared.data(from: configURL)
guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw APIError.server }
let config = try JSONDecoder().decode(BookingConfig.self, from: data)
```

## Error and retry policy

- Parse `{ "error": "…" }` for every non-2xx response.
- Do not retry `400`, `401`, `404`, `409`, `413`, `415`, or `422` without a user/data change.
- Retry transient `502`/`503` and network timeouts with bounded exponential backoff.
- Never automatically retry a privileged mutation without reusing the same `Idempotency-Key`.
- Generate a separate `X-Request-Id` UUID per user action for tracing.

## Calendar and payment invariants

- Pending applications are requests and must not block availability.
- Approved/deposit-pending events remain transparent.
- Only confirmed/deposit-paid (or explicitly waived) sessions block calendar time.
- Stripe webhook processing, not the app, changes payment state to paid.
- Calendar and database changes must remain coordinated through the existing API; the app must never call Google Calendar or Stripe secret APIs directly.

## Privileged capabilities already available

The companion-server tier currently supports:

- Listing active applications.
- Explicit owner approval with a deposit waiver.
- Guarded rollback of an erroneous waiver.
- Artist lookup.
- Exact availability checks.
- Creating approved bookings with deposit email and calendar event.
- Finding and rescheduling active bookings.
- Previewing and atomically splitting a booking.
- Requesting, assigning, accepting, and declining Jake's engineer handoffs.

The exact route contract is in the OpenAPI file. Cancellation/refund remains an admin-dashboard workflow and is intentionally not exposed as a general service endpoint yet.

## Resolving an app greeting from the artist directory

The app's trusted Cloudflare Worker may resolve an authenticated account with either:

- `GET /api/simon/artists?email=<account email>` (preferred), or
- `GET /api/simon/artists?phone=<account phone>`.

Send the service bearer token only from the Worker. The result keeps the account holder and artist identity separate:

```json
{
  "artists": [{
    "id": "artist-id",
    "fullName": "Ryan VanSickle",
    "artistName": "roo",
    "greetingName": "roo",
    "email": "account@example.com",
    "phone": "+1 531 000 0000"
  }]
}
```

The Worker should return only the minimum client-safe result, for example `{ "greetingName": "roo" }`. If `artists` is empty, fall back to the first name already stored in the authenticated app account. Never return the directory bearer token or the full artist record to the iOS client.
