# nailsbymandisa

Booking &amp; loyalty platform for nailsbymandisa nail salon. No e-commerce/shop — this app
covers appointments, payments for those appointments, and the loyalty/referral/gift-card/
subscription mechanics around them.

## Structure

- `api/` — Node.js + Express + MongoDB backend (`routes/` → `services/` → `models/`)
- `web/` — React + Vite frontend, with a shared design system in `web/src/design-system`

## Getting started

```bash
# API
cd api
cp .env.example .env   # fill in real values — see comments in the file
npm install
npm run dev             # http://localhost:4000

# Web
cd web
cp .env.example .env.local
npm install
npm run dev              # http://localhost:5173
```

**First admin account.** There's no admin in a fresh database, and admin-user management
(below) requires an existing admin to grant the first one — so bootstrap it once via a
direct database update: register a normal account through the UI, then in Mongo set that
user's `role` to `"admin"` and `permissions` to the full list from
`api/src/config/constants.js`'s `PERMISSIONS`. Every admin after that first one can be added
from the dashboard itself at `/admin/users`.

## Testing

```bash
cd api && npm test    # Jest + Supertest
cd web && npm test    # Vitest + React Testing Library
```

CI (`.github/workflows/ci.yml`) runs lint + tests + build for both apps on every push.

## Build order

See the project brief for the full build order. Status:

- [x] Step 1 — scaffold, env validation, CI, design tokens + component library
- [x] Step 2 — auth (register/login/refresh rotation/reset), roles/permissions, rate limiting
- [x] Step 3 — core data model: settings, services, staff (+ working hours), availability blocking
- [x] Step 4 — booking engine: shared slot-validation service, guest/logged-in/admin booking,
      reschedule/cancel with server-enforced windows, atomic double-booking prevention
- [x] Step 5 — payments: Yoco checkout for booking deposits, signed + idempotent webhook,
      admin-triggered refunds with an atomic floor check
- [x] Step 6 — customer account hub: auth pages (login/register/forgot-reset password),
      profile editing, password change, bookings list (cancel/reschedule), notifications
- [x] Step 7 — admin dashboard core: overview stats, appointments (list/filter/cancel),
      clients (list + detail with booking history), services/staff/availability CRUD,
      payments/refunds, activity log — all gated by granular admin permissions
- [x] Public booking wizard (pulled forward from step 4's frontend half): services →
      staff → date/time → guest-or-account details → review → Yoco checkout redirect,
      plus the confirmation and payment-retry landing pages Yoco redirects back to
- [x] Step 8 — loyalty (points earned per booking deposit paid, tiers, atomic redemption
      with a max-percent-of-order cap, full ledger) + referrals (unique code per user,
      welcome discount for the friend, points to the referrer on the friend's first
      confirmed booking — idempotent even if the confirmation webhook replays)
- [x] Step 9 (core) — discount codes: the one shared `createDiscountCode()` constructor
      (referral rewards and admin-created codes both go through it), atomic usage-limit
      enforcement, stacked with loyalty-point redemption at checkout behind a hard price
      floor so a charge can never hit zero
- [x] Step 10 (gift cards) — real purchase flow (choose amount, pay via Yoco, code
      emailed to purchaser + optional recipient), redemption against a booking deposit
      that's atomic and stacks with discount codes/loyalty points behind the same price
      floor, full admin visibility. This is exactly the feature the brief called out as
      half-built in the reference app (no purchase flow, non-atomic redemption) — built
      completely this time, including the concurrent-redemption test that proves it.
- [x] Step 10 (subscriptions) — plans grant N booking credits per period; a credit fully
      covers a deposit and bypasses Yoco entirely (confirmed synchronously, no webhook
      wait); one subscription document per customer (upsert on resubscribe/renew, not a
      second row); plan deletion blocked while active subscribers exist rather than
      silently orphaning them. No automatic recurring billing — Yoco's Checkout API is
      one-off sessions, not a stored-card/recurring primitive, so renewal is a
      customer-triggered repeat of the same subscribe call, documented as a real
      limitation rather than papered over.
- [x] Step 11 — client gallery (admin-curated + customer-submitted before/afters with a
      moderation queue, public likes), admin broadcast/targeted notification compose
      (real form, not `prompt()`), optional SMS via Twilio, WhatsApp deep link, custom
      PWA install prompt (Android/Chrome `beforeinstallprompt`, manual guide for iOS
      Safari), and SEO basics (robots.txt, sitemap.xml, LocalBusiness JSON-LD, per-page
      titles/descriptions)
- [x] Step 12 (hardening pass — the dedicated §5–7 security/reliability/accessibility
      audit). No automated `security-review` skill run (no git remote/commits for it to
      diff against), so this was a manual systematic pass against the brief's own §5/§6/§7
      checklists instead. Found and fixed:
      - A real refresh-token rotation race (React 18 StrictMode double-effect + genuine
        multi-tab use could trigger false theft-detection and log a user out). Fixed with
        a server-side grace window that rotates forward from the already-issued
        replacement token, plus client-side in-flight-refresh de-duplication.
      - Missing rate limiting on `/auth/change-password` (§5.5) — now behind `authLimiter`.
      - A malformed `:id` route param threw an unhandled `BSONError` → generic 500 instead
        of a clean 400 (§5.6/§5.11) — normalized centrally in `errorHandler.js`.
      - No pagination on 5 admin list endpoints (discount codes, gift cards, subscriptions,
        gallery, gallery moderation queue) (§7.3) — added a shared `paginate()` utility and
        wired `Pagination` into each admin page.
      - The refund flow (`AdminPaymentsPage`) let "Issue refund" fire immediately from the
        amount/reason form, unlike every other money-affecting/destructive admin action,
        which goes through `ConfirmDialog` with a plain-language summary first (§7.2) —
        restructured into a two-step form → confirm flow.
      - Five async buttons (gallery moderation approve/reject, gallery publish/hide,
        discount code activate/deactivate, notification mark-read/delete/mark-all-read,
        gallery photo likes) fired API calls with no loading/disabled guard, so a fast
        double-click could double-submit (§7.4) — all five now track in-flight state and
        disable during the request.
      Verified clean, no changes needed: IDOR protection (§5.3, spot-checked across every
      `:id` route), sensitive-field leakage (§5.10, `toPublicUser()` used consistently),
      CORS lockdown + production origin/Sentry checks (§5.9, `config/env.js`), CSPRNG usage
      for all tokens/codes (§5.8, `utils/crypto.js` — no `Math.random()` anywhere
      security-adjacent), generated-secret validation at boot (§5.7), real `<button>`/`<a>`
      elements throughout (no clickable `<div>`s), all form inputs labeled via `FormField`,
      and shared `Modal`/`ConfirmDialog` used everywhere (no hand-rolled overlays).

### Responsiveness pass (§7.7)
Every route was driven headless (Playwright + a cached Chromium) at 375×812 (mobile) and
1440×900 (desktop) — logged out, as a customer, and as admin — with an automated check for
`document.documentElement.scrollWidth` exceeding the viewport (the objective signal for
"something is forcing horizontal scroll on mobile"), plus a manual screenshot review.
Found and fixed two real bugs, both in `AdminLayout`/`AdminLayout.css` (the public site and
account pages, which never had `@media` rules to begin with, turned out to already be fine —
flex/grid with `auto-fit`/`auto-fill`/`minmax()` and no fixed pixel widths):
- `.admin-layout` sets `align-items: flex-start` for its desktop row layout (nav + content
  top-aligned instead of stretched to equal height). Under 700px it switches to
  `flex-direction: column`, which flips the cross-axis to width — `flex-start` there meant
  `.admin-layout__content` sized to its widest child's intrinsic content width (e.g. a wide
  admin table) instead of the viewport, blowing the whole page into horizontal scroll rather
  than letting the table's own `overflow-x: auto` wrapper contain it. Fixed with
  `align-items: stretch` inside the breakpoint.
- The admin nav (~15 links across 5 groups) rendered fully expanded at every width, so on
  mobile a user had to scroll past roughly 700px of nav before reaching any page content.
  Collapsed it behind a toggle button (closed by default under 700px, always expanded above
  it, matching the account-menu dropdown pattern already used in `Layout.jsx`) that shows
  the current section's label and closes automatically on navigation.

`api/` has 182 passing tests (Jest + Supertest) covering auth rotation/reuse-detection,
permission gates, the booking engine (overlap rejection, the atomic double-booking guard,
blocked-slot enforcement, cancellation/reschedule windows, off-peak pricing), payments
(webhook signature verification, idempotent replay handling, atomic refund floor checks
under concurrency), admin overview/client-detail correctness, loyalty/discount/gift-card/
subscription-credit atomic guarantees (concurrent redemptions can't overdraw a balance,
over-redeem a limited code, overdraw a gift card, or double-spend a credit), gallery
moderation visibility rules, and admin-user-management (below). `web/` has design-system
component tests plus LoginPage and BookingWizard (guest flow) integration tests.

### Admin user management (`/admin/users`)
Closes a gap flagged after Step 12: previously the only way to grant someone admin access
was a developer running a one-off database script (that's how the first admin account in
any fresh environment got made — see "Getting started" below for that one unavoidable
bootstrap step). Now, any admin with the new `manage_admin_users` permission can do it from
the dashboard itself:
- **Invite by email.** If the email already has an account (customer or otherwise), it's
  promoted to admin in place with the chosen permissions — no new password, they keep
  logging in as before. If it's a brand-new email, a new admin account is created with an
  unusable random password and they're emailed a set-password link, reusing the same
  password-reset token flow/page the customer-facing "forgot password" already has.
- **Edit permissions** on any existing admin — granular checkboxes, same
  `PERMISSIONS`/`requirePermission()` list every other admin route is gated by.
- **Revoke access** — demotes back to a plain customer account with permissions cleared
  (not a delete; they keep their login, just lose admin access, and can be re-granted later).
- **Can't touch your own row.** An admin can't edit or revoke their own access through this
  screen (server-enforced, not just hidden in the UI) — the only way to modify your own
  admin record is to have another admin do it. This is also what guarantees the admin set
  can never hit zero through this UI: whoever performs a revoke necessarily remains an
  admin themselves afterwards, so no separate "don't revoke the last admin" counter check
  is needed.
- One real limitation carried over from the rest of the system: the `staff` role exists in
  the schema/permission model but has no permission-gated capabilities wired to anything
  yet (`requirePermission()` only ever grants access to `role === 'admin'`) — so this screen
  only manages admin accounts. Promoting someone to `staff` today would give them a working
  login with nowhere to go.

**Scope deliberately deferred from the admin dashboard** (called out so it isn't mistaken
for finished): appointments calendar view (list view only for now), CSV/PDF export, staff
weekly-view grid (the working-hours editor supports one shift per day; the backend model
already supports split shifts), and a proper analytics/leaderboard screen (loyalty data
now exists to build one on, but the screen itself isn't built).

### Loyalty/referral notes
- Points are earned on the **deposit actually charged through the app** (after any
  discount/points already applied), not the full service price — the app has no record
  of the balance paid in person, so that's the only amount it can honestly attribute.
  Worth revisiting once/if an admin "mark fully paid" flow exists.
- A stacked discount code + points redemption is floored at `MIN_CHARGE_CENTS` (R1) so
  the Yoco charge can never hit zero.
- A found-in-passing bug while adding this: the in-memory fake Mongo used by tests didn't
  actually implement `$push`, so the refund-history array in `paymentsService.test.js`
  was silently never populated even though tests passed. Fixed, and a couple of `sort()`
  calls across services got a same-millisecond tiebreaker while in there — genuine
  precision gaps, not flaky tests, surfaced by the new loyalty ledger ordering test.

**Known gap: abandoned pending-payment appointments never expire.** A booking holds its
slot (via the unique index) as soon as it's created, even if the customer never completes
payment — there's no TTL/cleanup job releasing it. Worth a small scheduled job before
launch; flagged rather than silently left implicit.

**Browser end-to-end testing still not done.** Lint, unit/integration tests (which exercise
the real Express app + real service logic against an in-memory fake Mongo), and production
builds all pass for both apps — but I have not clicked through the running app in an actual
browser. That needs a real MongoDB connection; `mongodb-memory-server`'s binary download
stalled indefinitely twice in this sandbox (looked network-throttled). Once a real
`MONGO_URI` is available (Atlas or otherwise), set it in `api/.env` and this becomes
possible — worth doing before trusting the UI beyond what the automated tests cover.

### Payments integration notes
- Yoco's Checkout API and Standard Webhooks signature scheme were verified against
  Yoco's live docs (developer.yoco.com) while building this — re-check before going live
  if this has sat untouched for a long time, since third-party API shapes can drift.
- `YOCO_WEBHOOK_SECRET` must be the real `whsec_...` secret from the Yoco dashboard for
  a registered endpoint at `POST /api/payments/webhook`.

### Gift card notes
- Purchase amount is bounded by `GIFT_CARD_MIN_CENTS`/`GIFT_CARD_MAX_CENTS` (R50–R5000,
  placeholders) — not yet admin-configurable via SETTINGS; move there if the salon wants
  to change the bounds without a deploy.
- At booking checkout, reductions apply in a fixed order — discount code, then loyalty
  points, then gift card balance — each computed against what's left after the previous
  one, all floored at `MIN_CHARGE_CENTS` so Yoco always receives a positive amount. A
  subscription credit, when used, replaces this whole reduction chain (it covers the
  deposit outright — see subscription notes below).
- There's deliberately no "check this gift card's balance" endpoint — it would let anyone
  probe codes for a live balance. A card's state is only visible to its purchaser or an
  admin, both authenticated.

### Subscription notes
- A plan's credits reset to a fresh `creditsPerPeriod` on every successful payment
  (first subscribe or renewal) rather than accumulating — unused credits don't roll
  over. This is a deliberate simplicity choice, not an oversight; revisit if the salon
  wants rollover.
- A customer can hold exactly one subscription document (enforced by a unique index on
  `userId`, not just application logic) — switching plans requires cancelling first;
  renewing the same plan reuses the document rather than creating a new one.
- Booking with a credit produces a `payment` record with `amountCents: 0` and
  `status: 'paid'` immediately (no `yocoCheckoutId`) — the frontend checks the response
  status and skips the Yoco redirect entirely for that path.

### Gallery, notifications, PWA, SEO notes
- **No file-upload storage.** Both `gallery` (admin-curated) and `clientGallery` (UGC)
  reference already-hosted media by URL — there's no S3/Cloudinary-style upload built,
  since that needs its own infrastructure credentials beyond this app's env setup. Admin
  and customers paste a URL to media they've already uploaded elsewhere. A real launch
  would want to add an upload step in front of this.
- **Push notifications (optional per the brief) are not built.** `VAPID_PUBLIC_KEY`/
  `VAPID_PRIVATE_KEY` are scaffolded as optional env vars but nothing subscribes to or
  sends push yet — SMS (Twilio) and WhatsApp (deep link) are the two channels actually
  wired up, plus the existing email/in-app notification center.
- **Broadcast SMS was deliberately left out.** The admin compose form offers "also send
  by SMS" only for a single targeted notification, never for a broadcast — blasting SMS
  to every customer at once is a real cost/abuse risk with no one-click path to it here.
- **SEO is the ceiling a client-rendered SPA without SSR can reach**: per-page
  `document.title`/meta description via a small hook, a static sitemap.xml/robots.txt,
  and LocalBusiness JSON-LD in `index.html`. A crawler that doesn't execute JS won't see
  the per-page meta tags — prerendering or SSR would be the next step for full SEO
  benefit, and is a bigger change than fits this pass.
- The JSON-LD block in `index.html` now has the real business name/address/phone/email,
  but it's still static hand-typed markup — it's **not** rendered from the live
  `SETTINGS` document, so if either changes (e.g. hours, or the address once there's an
  admin settings screen to edit it through), keep the two in sync by hand until/unless
  this becomes server-rendered.

### Brand & theme
Real business identity applied throughout: NailsByMandisa, nailsbymandisa.com,
076 687 8843, nailsbymandisa@gmail.com, 882 Almondrock, Strubensvalley, Roodepoort, 1734
— in `index.html` (title/meta/JSON-LD), `api/src/models/settings.js` `DEFAULT_SETTINGS`
**and** the live settings document (`PATCH /api/settings`, so it's already reflected in
the running app, not just the code default), `sitemap.xml`/`robots.txt`, email subject
lines, and a new footer (`Layout.jsx`) showing the tagline and contact details on every
page. Color tokens (`tokens.css`) moved from the old placeholder warm-neutral/terracotta
palette to black + white + a dusty-rose pink accent, per the chosen "light site, black +
pink accents" direction: a new `--color-ink`/`--color-ink-text` pair is used only for the
header/footer band (reversed wordmark, pink nav-hover/CTA), while every content
surface — booking forms, tables, the admin dashboard — stays on the light
`--color-bg`/`--color-surface` pair. Because every component already pulled its colors
from tokens rather than hardcoded hex values, this was a tokens.css + Layout swap; nothing
else needed touching, and a grep for `#[0-9a-f]{3,6}` outside `tokens.css` (and
`WhatsAppButton.css`, whose green is WhatsApp's own brand color, deliberately left alone)
turns up nothing.

**The real logo is now in the app**, not a text stand-in. It couldn't be pulled from the
chat attachment directly (pasted image bytes aren't reachable by this tooling, only
readable/describable) — it was found already saved on disk at
`~/OneDrive/Documents/mandisa logo.jpeg` and brought in from there instead. Source of
truth: `web/public/brand/logo.jpeg` (the original, 1600×1600). Everything else is derived
from it via a one-off headless-Chromium canvas script (content-bounds detection + crop,
since the source has a lot of empty black padding around the mark) — not checked into the
repo as a build step, so if the source logo ever changes, regenerate these by hand the
same way:
- `web/public/brand/logo-lockup.png` (791×400, the full mark + wordmark + tagline
  tightly cropped) — used in the header (`Layout.jsx`, 40px tall) and footer (100px tall).
  The home page hero originally also showed the logo in a black card, but that was removed
  per a follow-up request — the hero now shows just the "Clean. Chic. Creative." tagline
  as plain text (`HomePage.jsx`/`.css`), since the header right above it already carries
  the full logo.
- `web/public/icons/icon-{32,192,512}.png` (mark only, no wordmark/tagline — illegible at
  favicon/app-icon sizes otherwise) — wired into `index.html` (`<link rel="icon">` /
  `apple-touch-icon`) and `vite.config.js`'s PWA manifest, replacing the placeholder "M"
  monogram SVG (deleted, no longer referenced anywhere).
- `--color-ink` in `tokens.css` was nudged from `#0e0c0d` to pure `#000000` to exactly
  match the logo's own flat black background — the header/footer edges now have zero
  visible seam against the embedded image.

### Admin dashboard rebuild
The admin dashboard was restructured to match a reference dashboard (NXL Beauty Bar) the
salon owner shared, recolored into the black/white/pink brand instead of its original
rainbow palette. Planned via `EnterPlanMode` given the size (see the approved plan for the
full phase breakdown); shipped in seven phases, each linted/tested/screenshot-checked
before moving on:
- **Sidebar + top bar** (`AdminLayout.jsx`/`.css`, new `AdminTopBar.jsx`) — flattened the
  old 6 grouped nav sections into one icon-led list on a dark (`--color-ink`) rail with the
  logo lockup + "Admin panel" caption at top and "← Back to site"/"Log out" pinned at the
  bottom; page titles moved out of each page body and into a shared top bar (page title +
  "NailsByMandisa · Admin Panel" + the signed-in admin's name/email), so every admin page
  had its own redundant `<h1>` removed. `.layout__main` gets a wider `max-width` only when
  it contains `.admin-layout` (a `:has()` rule), so the public site's narrower reading
  width is untouched. WhatsAppButton/InstallPrompt are now hidden on `/admin/*` routes —
  neither makes sense in the dashboard, and both are fixed-position, so they were
  overlapping the sidebar's own footer controls.
- **Overview** (`adminService.getOverviewStats()`/new `getTrend()`, new
  `GET /api/admin/trends`, new dependency-free `SimpleLineChart`/`SimpleBarChart` in the
  design system) — 8 color-coded stat cards (bookings today/upcoming in pink, three
  revenue windows in black, cancellations/no-shows/unpaid in the existing
  danger/warning/neutral tokens), a revenue trend line chart with Week/Month/Year toggles,
  a bookings trend bar chart (booked/cancelled/completed by day), and a quick-actions row.
  Revenue/bookings windows are rolling (last N days ending today), not calendar week/month,
  to sidestep "what day does the week start on" ambiguity.
- **Appointments** — staff filter (the API already supported `employeeId`, just unused by
  the UI), new service filter and client name/email search (`appointments.js` route), a
  `clientName`/`clientEmail` field resolved server-side onto every row (there was
  previously no way to see who a booking was even for), and CSV (hand-rolled, no
  dependency) + PDF (`jspdf`/`jspdf-autotable`, new dependency) export of the current
  filtered view.
- **Schedule** (new `AdminSchedulePage.jsx`, route `/admin/schedule`) — Daily
  Overview (a time-slot × staff grid: open/closed from working hours, blocked slots,
  booked appointments) and Per-Staff Weekly (a 7-day agenda for one staff member). No new
  backend — built entirely from the existing staff/appointments/availability endpoints.
- **Clients** — `listClients()` now joins each row's booking count, last booking date, and
  loyalty point balance (computed only for the current page, not the whole customer base);
  added `search`; added a Notify quick action (reuses
  `POST /api/admin/notifications/send`) and Block/Unblock (new
  `POST /api/admin/clients/:id/block` + `/unblock`, reusing the `isActive` flag `login()`
  already enforces — no new "banned" concept). "Adjust points" already existed on the
  client detail page from an earlier step; nothing new needed there.
- **Services/Staff** — left as-is; already matched the target look via the shared design
  system, no functional gaps found against the reference.
- **Gallery uploads are now real**, not URL-paste — new `POST /api/uploads/image`
  (`multer` for multipart parsing + the `cloudinary` SDK, both new dependencies; a new
  `config/cloudinaryClient.js` that mirrors `config/smsClient.js`'s "optional integration,
  clear error if unconfigured, never silently pretend to succeed" pattern) used by both
  `AdminGalleryPage.jsx` (admin posts — video items still take a URL, since video upload
  wasn't in scope) and `SubmitPhotoPage.jsx` (customer submissions). `apiClient.js` gained
  `FormData` support (skips JSON-stringifying and lets `fetch` set its own multipart
  boundary) to make this possible. **Live and verified** — the owner created a free
  Cloudinary account and provided real credentials (now in `api/.env`); confirmed working
  with an actual file picked in the browser, uploaded through the real API, landing on
  Cloudinary's CDN, and rendering back in the gallery table. Doing this surfaced two real
  bugs, both fixed:
  - The Table's `type` column had no `render` function and no `key: 'type'` field on the
    gallery item (the model field is `mediaType`) — silently rendered blank for every row,
    pre-existing from when this page was first built, just never noticed until real data
    made it visible.
  - `tests/setup.env.js` only *defaults* env vars it doesn't already find set — once real
    Cloudinary credentials existed in `api/.env`, dotenv loaded them before the test setup
    ran, and the "uploads not configured" test started exercising the real (now-configured)
    path instead of the unconfigured one. Fixed by force-clearing
    `CLOUDINARY_CLOUD_NAME`/`CLOUDINARY_API_KEY`/`CLOUDINARY_API_SECRET` for every test run,
    so tests never depend on — or accidentally hit — whatever's in a developer's real `.env`.
  The plan's stretch goal of merging Admin Posts/Client Submissions into one tabbed page
  (matching the reference exactly) was dropped as not worth the added complexity — they
  stay as separate sidebar items ("Gallery" / "Gallery moderation").

Two real bugs found and fixed during the verification pass (beyond the two just above):
the Schedule page's daily appointments fetch requested `pageSize=100` — an earlier draft
used `200`, over `PAGINATION.MAX_LIMIT` (100), which the API correctly rejected with 400.
All four were caught by actually running the app (Playwright screenshot/overflow sweeps,
and for the upload path, a real file through the real UI to the real Cloudinary account),
not by the type checker or test suite — there's no frontend test covering any of these
pages yet (see below).

**Not done, flagged rather than silently skipped:**
- No automated tests for any of the seven new/changed frontend pages (`AdminSchedulePage`,
  the rebuilt `AdminOverviewPage`/`AdminAppointmentsPage`/`AdminClientsPage`/
  `AdminGalleryPage`, `AdminLayout`) — covered by manual Playwright screenshot/overflow
  checks this session, not by anything that runs in CI. Backend changes (trends,
  client-list enrichment, block/unblock, uploads) do have Jest/Supertest coverage.
- `npm audit` on both installs (jspdf/jspdf-autotable, cloudinary/multer) surfaced
  vulnerabilities, but none traced back to the new packages themselves — they're
  pre-existing transitive issues in vite/vitest/esbuild/react-router (dev tooling) and
  nodemailer (already flagged elsewhere as never having been tested against a real SMTP
  server). Worth a dedicated `npm audit fix` pass, not done here since some fixes are
  breaking major-version bumps.

### Home page hero
The hero (`HomePage.jsx`/`.css`) is a full-bleed background photo/video spanning the whole
viewport width, not just the page's content column — the tagline, subtitle, and two CTA
buttons ("Book an appointment" / "View gallery") sit on top of it behind a dark gradient
scrim for contrast. This went through two iterations:
- **First pass**: a real-photography banner *between* the hero text and "Our services",
  contained within the page's normal 960px-max content width — a genuine NailsByMandisa
  manicure photo shot in front of the salon's own signage, found already sitting in the
  Cloudinary account (uploaded via the gallery feature before this existed to use them for
  anything else), not a new upload. A candidate already on the owner's local disk
  (`mandisabanner.jpeg`) turned out to carry a third party's watermark ("NATTTISHA_NAILS")
  — flagged rather than used, since publishing someone else's watermarked photo as this
  site's own banner would misattribute it.
- **Second pass** (current): merged into one full-bleed hero matching a reference site the
  owner shared, spanning the full viewport width edge-to-edge. `width: 100vw` +
  `margin: calc(-50vw + 50%)` breaks it out of the shared `Layout`'s centered/padded
  `.layout__main`; `margin-top: calc(-1 * var(--space-5))` cancels that same ancestor's
  top padding so the hero sits flush under the header with no gap (a real bug from the
  first full-bleed attempt, caught from a screenshot the owner sent). `overflow-x: clip`
  was added to `body` (`tokens.css`) as a safety net for this technique's usual failure
  mode — vw units include the scrollbar gutter on some browsers, which can otherwise force
  a stray pixel of horizontal scroll; verified overflow-free at 390/1440/1920px regardless.

**Admin-editable, image or video** — `/admin/homepage` (new `AdminHomepagePage.jsx`,
new sidebar item). Backend: `SETTINGS.heroMedia: { url, type }` (`api/src/models/settings.js`,
`routes/settings.js`), updated via the existing `PATCH /api/settings` (`MANAGE_SETTINGS`
permission) — `$set` semantics mean patching just `heroMedia` doesn't touch any other
settings field. Images go through the same real Cloudinary upload
(`uploadImageFile`) the gallery uses; video is URL-paste (autoplays muted+looped, so kept
short is on the admin to manage — no video transcoding/hosting was in scope). The public
`HomePage.jsx` fetches `GET /api/settings` (public, no auth) and renders either an `<img>`
or an autoplaying muted `<video>` behind the overlay depending on `heroMedia.type`, falling
back to the same default photo (hardcoded client-side, matching `DEFAULT_SETTINGS`) until
the real value loads, so there's no flash of an empty hero.

This is the first real instance of the "no admin settings screen exists" gap (noted
earlier in this file) actually being closed — narrowly, for just this one setting, not a
general settings UI.

### Home page "Our work" section
A horizontally-scrollable row of gallery cards between the hero and "Our services"
(`home__work*` in `HomePage.jsx`/`.css`), matching a layout the owner referenced from
another salon's site (eyebrow label, serif heading, swipe-hint row of cards). No new
content type or backend endpoint — it's a shorter client-side slice (first 10) of the
exact same public `/gallery` + `/client-gallery` data the full Gallery page already
shows (curated admin posts + approved client submissions merged into one list), so
publishing a photo from `/admin/gallery` or approving one from `/admin/gallery-moderation`
is all it takes to make it appear here too. Video items show the video element itself
(browsers render its first frame as a natural thumbnail) with a play-icon overlay; every
card links through to the full `/gallery` page rather than playing inline, keeping this a
lightweight teaser. The row uses the same full-bleed-scroller-inside-a-contained-heading
pattern as everywhere else full-bleed shows up on this page (`width: 100vw` +
`calc(-50vw + 50%)` margins) — verified overflow-free the same way. The section hides
itself entirely when there's no published gallery content yet, same as "Our services"
already did for an empty services list.

**Still no *general* admin settings screen.** `/api/settings` has a working GET/PATCH API
(built in Step 3) and now exactly one field of it (`heroMedia`) has a real admin UI
(`/admin/homepage`, above). Everything else on the settings document — business
name/contact/hours, booking deposit, cancellation policy, loyalty/referral rates — still
has no frontend page; business info was updated earlier this session by calling the API
directly. Going forward, either extend `/admin/homepage` into a fuller settings screen or
keep editing the rest the same way.

### Email (Resend) — booking confirmations & reminders
Swapped the never-configured SMTP setup (`SMTP_HOST`/`PORT`/`USER`/`PASS`, always
placeholder values — every transactional email had been silently failing) for
[Resend](https://resend.com): `config/mailer.js`'s `sendMail()` keeps the exact same
signature and never-throws behavior, just backed by the Resend SDK now. Free tier is
3,000 emails/month.

**Setup**, mirroring how Cloudinary was wired up earlier:
1. Sign up at resend.com, then **API Keys → Create API Key** → put it in `RESEND_API_KEY`.
2. **Domains → Add Domain** → add the DNS records Resend gives you (on whatever registrar
   holds `nailsbymandisa.com`). Until this is verified, Resend will only deliver to the
   email address the Resend account itself was signed up with — real customers won't
   receive anything, so this step isn't optional for production.
3. Set `EMAIL_FROM` to an address on that verified domain, e.g.
   `"NailsByMandisa <bookings@nailsbymandisa.com>"`.

**Two real gaps closed along the way:**
- `sendBookingConfirmationEmail` (paymentsService.js) only ever emailed **guest**
  bookings — for a logged-in customer it silently did nothing (the account holder got an
  in-app bell notification only, never an email). Fixed to resolve the email from the
  user's account too.
- Reminders are new: `services/remindersService.js`'s `sendDueReminders()` finds
  confirmed appointments starting within `SETTINGS.reminderHoursBefore` (default 24h,
  no admin UI yet — `PATCH /api/settings` directly) that haven't been reminded yet
  (`appointments.reminderSentAt`, a new field), emails each one once, and atomically
  claims it first so it's safe to call as often/late as a scheduler likes.

**Why an external cron, not an in-process timer:** Render's free web-service tier spins
down after inactivity, so a `setInterval`/`node-cron` loop living inside the API process
wouldn't reliably fire on schedule while asleep. Instead, `.github/workflows/reminders.yml`
(this repo's GitHub Actions, free) calls `POST /api/cron/reminders` hourly — the call
itself also wakes the dyno if needed. That route is authenticated by a shared secret
(`CRON_SECRET`, timing-safe compared, same pattern as the Yoco webhook signature check)
sent as the `X-Cron-Secret` header — deliberately outside the admin JWT/permission system
since there's no logged-in person driving it.

**To finish deploying this:** set `RESEND_API_KEY`, `EMAIL_FROM`, and `CRON_SECRET` on
Render (same value for `CRON_SECRET` as below); then add two repo secrets on GitHub —
`API_URL` (the deployed API's base URL) and `CRON_SECRET` (must match Render's value) —
so the scheduled workflow can authenticate. The workflow also has a manual
`workflow_dispatch` trigger for testing it on demand from the Actions tab.
