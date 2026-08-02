# Cloudflare staging setup

## Pages project

- Repository: `RightMindCreative/right-mind-creative-site`
- Production branch: `main`
- Preview/integration branch: `development`
- Framework preset: none
- Build command: leave blank
- Build output directory: `.`
- Root directory: repository root

The live Right Mind Creative domain must not be connected until the release gate
in `docs/production-foundation.md` passes.

## Initial preview gate

- Confirm all HTML, CSS, JavaScript, image, and video assets return successfully.
- Upload the two WAV-only player tracks to the staging R2 media bucket and replace
  their local URLs before considering the preview complete.
- Confirm Pages preview responses are `noindex`.
- Test home, tour, about, and application pages on desktop and mobile.

## Future resources

Use environment-specific names so testing data can never collide with production:

- D1: `right-mind-booking-staging`
- R2 uploads: `right-mind-uploads-staging`
- R2 web media: `right-mind-media-staging`
- Worker/API: `right-mind-booking-api-staging`

## Google Calendar staging

Create a dedicated calendar named `Right Mind Booking Staging`. Enable the
Google Calendar API in a Google Cloud project, create a service account, and
share only the staging calendar with that service account.

Configure these Pages preview variables:

- `BOOKING_TIME_ZONE`: `America/Chicago`
- `GOOGLE_CALENDAR_ID`: the staging calendar ID
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`: the service account email
- `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`: the private key stored as an encrypted
  secret

Do not reuse these credentials or this calendar in production.

## Simon service API preview

Apply all D1 migrations, including `0008_simon_service_api.sql`, to the staging
database before testing the Simon routes. Configure these as encrypted Pages
preview secrets rather than plaintext variables:

- `SIMON_SERVICE_TOKEN`: a dedicated high-entropy bearer token used only by Simon
- `SIMON_APPLICATION_WEBHOOK_SECRET`: the shared application-event signing secret

Configure `SIMON_APPLICATION_WEBHOOK_URL` to the staging Simon receiver. Do not
reuse the browser admin passcode or cookie as the service credential.

Verify missing and incorrect bearer tokens return an authentication error.
Then test artist lookup, service resolution, exact-slot availability, and one
idempotent booking request. Repeating the request with the same idempotency key
must return the same application ID without adding another D1 row or calendar
event. A newly created request has status `new`; it is not a confirmed booking
until the existing approval, Stripe, and verified webhook lifecycle reaches
`confirmed`/`paid`.
