# Legacy Content Schema Specification (Sanity / `cms/`)

> **P2-12** — this document preserves the schema definitions from the
> abandoned `cms/` directory (a Sanity Studio skeleton that was never
> integrated into the CryptoFlip runtime) so the content model can be
> referenced if we ever wire up a real headless CMS.

The original `cms/` directory (528 MB including `node_modules`) was
removed from the repo in commit (P2-12) — but the schema
specifications it defined are preserved here verbatim as
documentation, in case we want to migrate to a real CMS later
(Strapi, Directus, Sanity, Contentful, etc.).

The schemas below describe four document types:

- **Announcement** — Site-wide banner messages
- **Category** — Tags for blog posts
- **Post** — Blog posts / promotions
- **Rule** — Game rules and terms

---

## 1. Announcement (`announcement.ts`)

> Source: `cms/schemas/announcement.ts` (preserved 2026-07-24)

The site-wide banner that appears at the top of every page.

| Field | Type | Required | Notes |
|---|---|---|---|
| `message` | text (2 rows) | yes | The banner text shown to users (e.g., "Welcome to CryptoFlip!") |
| `type` | string enum | yes | `info` (blue), `success` (green), `warning` (gold), `alert` (red). Default: `info` |
| `linkUrl` | string | no | URL the banner links to (optional) |
| `isActive` | boolean | yes | Whether the banner is currently displayed. Default: `true` |
| `startDate` | datetime | no | Scheduled start date (optional) |
| `endDate` | datetime | no | Scheduled end date — banner auto-hides after this (optional) |

---

## 2. Category (`category.ts`)

> Source: `cms/schemas/category.ts`

Tags / categories that blog posts can be associated with.

| Field | Type | Required | Notes |
|---|---|---|---|
| `title` | string | yes | Display name of the category |
| `slug` | slug | yes | URL-friendly identifier, auto-generated from `title` (max 96 chars) |
| `description` | text | no | Short description shown on category pages |

---

## 3. Post (`post.ts`)

> Source: `cms/schemas/post.ts`

Blog posts / promotional articles. Has a `seo` fieldset for SEO metadata.

### Main fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `title` | string | yes | Headline shown to users |
| `slug` | slug | yes | URL path, auto-generated from `title` (max 96 chars) |
| `featuredImage` | image | no | Hero image with hotspot for responsive cropping |
| `categories` | array<reference> | no | References to `category` documents |
| `publishedAt` | datetime | yes | Publish date (defaults to now) |
| `body` | array (block + image) | yes | Rich content with H1/H2/H3/quote styles |

### SEO fields (in the `seo` fieldset)

| Field | Type | Required | Notes |
|---|---|---|---|
| `metaTitle` | string | no | Google search title (max 60 chars; longer is truncated) |
| `metaDescription` | text (3 rows) | no | Google search snippet (max 160 chars) |
| `focusKeyphrase` | string | no | Primary SEO keyword |
| `ogImage` | image | no | Social-share image (overrides `featuredImage` if set) |

---

## 4. Rule (`rule.ts`)

> Source: `cms/schemas/rule.ts`

Game rules and terms-of-service content, keyed by a stable string for
frontend code to reference.

| Field | Type | Required | Notes |
|---|---|---|---|
| `title` | string | yes | Display title (e.g., "Provably Fair Rules") |
| `key` | string | yes | Stable identifier (e.g., "how-to-play", "terms-and-conditions"). **Don't change once published** — frontend code references it. |
| `content` | array (block) | yes | Rich content with Normal/H2/H3 styles |
| `lastUpdated` | datetime | yes | When the rule was last modified (defaults to now) |

---

## 5. Schema index (`index.ts`)

The original `cms/schemas/index.ts` exported the array:

```ts
export const schemaTypes = [post, category, announcement, rule];
```

This array is consumed by `cms/sanity.config.ts` to register the
schemas with Sanity Studio. With the `cms/` removal, this is now
documentation-only.

---

## 6. What was actually deleted

The P2-12 commit removed the following files from the repo:

```
cms/announcement.ts        (was: sanity.cli.ts at root)
cms/category.ts            (was: sanity.config.ts at root)
cms/index.ts               (was: tsconfig.json)
cms/post.ts                (was: package.json)
cms/rule.ts                (was: package-lock.json)
cms/schemas/               (was: tsconfig.tsbuildinfo)
cms/sanity.cli.ts          (10 tracked files total)
cms/sanity.config.ts
cms/tsconfig.json
cms/tsconfig.tsbuildinfo
cms/package.json
cms/package-lock.json
```

Plus the untracked `cms/node_modules/` (~393 MB of Sanity Studio deps).

**Files NOT in git but on disk after deletion**: `cms/node_modules/` is
untracked, so `git rm -rf cms/` did NOT touch it. Operators should run
`rm -rf cms/` manually after the commit lands to free disk space.

---

## 7. Should we ever wire up a real CMS?

**No, for the foreseeable future.** CryptoFlip uses PostgreSQL-backed
dynamic content (admin_settings table for the site banner, kyc_*
tables for legal docs, fraud_signals for fraud rules). A headless CMS
would add:

- An external dependency (Sanity / Strapi / etc.) with its own auth,
  billing, and uptime guarantees.
- Content duplication between DB and CMS (most legal text is in DB
  already per regulator-mandated audit requirements).
- A second deployment pipeline.

If we ever need structured content (e.g., marketing blog posts
beyond the admin-controlled promos), we can either:

1. Add a `blog_posts` table to PostgreSQL with a row-based CMS UI in
   the existing admin panel.
2. Stand up a separate CMS instance and integrate it via the schemas
   preserved above.

**Recommended**: option 1. It keeps content in the same DB as the
rest of the system (single source of truth, single backup pipeline
per P2-06, no extra uptime dependency).

---

## 8. P2-12 acceptance criteria

This preservation is **complete** if and only if:

1. `docs/legacy-content-schema-spec.md` exists with sections 1-7 above.
2. `cms/` is no longer in the repo (`ls cms/` returns "No such file or directory").
3. The 5 schema definitions (announcement, category, post, rule, index)
   are preserved verbatim in sections 1-5.
4. The schema types match what the original TypeScript code declared
   (verified by reading the preserved definitions in this document
   against the original `cms/schemas/*.ts` files prior to deletion).
