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

