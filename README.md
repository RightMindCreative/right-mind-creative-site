# Right Mind Creative

Independent website and application experience for Right Mind Creative.

The current frontend includes the home, studio tour, about, and application
pages. The production backend will use Cloudflare Workers, D1, and R2 with
Google Calendar and Stripe integrations.

## Run locally

Open Terminal in this folder and run:

```sh
python3 -m http.server 4173
```

Then open:

- Home: http://localhost:4173/
- Tour: http://localhost:4173/tour.html
- About: http://localhost:4173/about.html
- Application: http://localhost:4173/book.html

## Source control

- `main` is reserved for release-ready code.
- Active integration work will happen on `development`.
- Secrets belong in local environment files and cloud secret stores, never Git.
- WAV masters are intentionally ignored. They remain available in the studio
  archive and will be replaced with web-ready audio or private R2 objects before
  staging deployment.

See [docs/production-foundation.md](docs/production-foundation.md) for the
planned environments and release gate.

See [docs/cloudflare-staging.md](docs/cloudflare-staging.md) for the Pages
preview configuration and initial deployment gate.
