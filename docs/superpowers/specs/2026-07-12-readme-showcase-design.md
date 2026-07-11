# README Product Showcase Design

## Goal

Turn the repository README into a concise product showcase that explains BambuMonitor at a glance, demonstrates the current desktop experience, and still gives developers accurate installation, networking, licensing, and build information.

## Audience And Tone

The first screen targets Bambu Lab users who operate several printers and want a lightweight always-visible monitor. Copy should be confident, concrete, and promotional without claiming unsupported remote-control capabilities.

## README Structure

1. Product name and a one-sentence value proposition.
2. A primary full-workspace screenshot.
3. Four short product benefits: multi-printer telemetry, responsive window modes, camera wall, and cloud-status plus LAN/VPN camera connectivity.
4. A visual gallery covering the main desktop surfaces.
5. Installation and release links.
6. Accurate cloud, LAN, VPN, camera, privacy, and security limitations.
7. Development, packaging, AGPLv3, and non-affiliation information.

## Screenshot Set

Produce six current screenshots with a consistent dark presentation:

- Full workspace with demo printer telemetry.
- Compact workspace with demo printer telemetry.
- Mini workspace with demo printer telemetry.
- Camera wall using real camera frames where available.
- Enlarged camera preview using a real camera frame.
- Settings sheet showing responsive controls.

Status screenshots use deterministic demo data. Camera screenshots may use real printer imagery, but all private LAN addresses, account names, tokens, and other identifiers must be hidden or cropped. Screenshots must show the application itself without unrelated desktop windows.

## Verification

- Capture from the current `1.0.12` interface rather than reusing older images.
- Check every image for readable text, complete controls, and no overlap or clipping.
- Verify README image links and Markdown rendering.
- Run tests, lint, build, and `git diff --check` before publishing.

## Delivery

Replace the existing screenshots, add the missing gallery images, rewrite README content in Chinese with a concise English summary, commit the result, and push it to `codex/resizable-workspace-ui`.
