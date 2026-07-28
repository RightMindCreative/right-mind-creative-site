# Production foundation

## Environments

- `development`: local work and Cloudflare preview deployments.
- `production`: the reviewed release connected to the public domain.
- Staging and production must use separate D1 databases, R2 buckets, Stripe
  credentials, Google calendars, and email settings.

## Planned cloud services

- Cloudflare Pages for the website and preview deployments.
- Cloudflare Workers for application, availability, approval, and payment APIs.
- Cloudflare D1 for applications, bookings, clients, and payment state.
- Cloudflare R2 for private client uploads and web audio that is too large for
  Pages.
- Google Calendar for free/busy checks and confirmed studio events.
- Stripe Checkout and signed webhooks for deposits and payments.

## Source-control rules

- Never commit `.env`, `.dev.vars`, API keys, OAuth tokens, or service-account
  credentials.
- WAV masters remain outside Git. Keep an archival copy in approved studio
  storage; publish compressed web audio or R2 object references instead.
- All production changes should be reviewed on a preview deployment before
  merging into `main`.
- Database migrations and Worker configuration will be committed alongside the
  code once those services are introduced.

## Release gate

The public domain stays on the existing production site until the staged
application, file upload, approval, calendar, Stripe, email, mobile, security,
and recovery test suites pass.

