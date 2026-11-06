# File Converter — Image conversion

**Status:** implemented — see §8 for where the code lives
**Date:** 2026-10-12
**Owning service:** `conversion-service` (conversion), `api-gateway` (`/api/images/convert`)
**Related:** [CONVERSIONS.md](CONVERSIONS.md) — the pipeline this runs on: history, `save`, storage, limits, audit

---

## 1. Scope

PNG → JPEG, JPEG → PNG, SVG → PNG, SVG → JPEG. **Nothing is converted to SVG**, and that is
permanent: tracing pixels into vectors is a different product, not a conversion. A request for it
is refused like any other direction that does not exist.

Images go through the same pipeline as the text formats. Everything in
[CONVERSIONS.md](CONVERSIONS.md) applies unchanged unless this document says otherwise: the
response contract, history and `save`, storage, clean-up, audit, the per-format byte limits, and
the 30-second limit. What is added here is one module (`ImageConverter`), a route scoped to images,
and options.

---

## 2. API

Every route needs a session. Images are served at both:

- **`POST /api/images/convert`**: images only. A CSV sent here is a `415`. Options are accepted
  as separate form fields too.
- **`POST /api/convert`**: every format, images included. Options are accepted only as the
  `options` JSON field.

Both write to the same history ([TRANSFORMATION-HISTORY.md](TRANSFORMATION-HISTORY.md)), where images are `type=image`.

### `POST /api/images/convert`

`multipart/form-data`:

| Field | | |
|---|---|---|
| `file` | required | PNG, JPEG or SVG |
| `targetFormat` | required | `png`, `jpeg` or `svg` (`svg` is accepted and always refused, §1) |
| `save` | optional | as in CONVERSIONS.md |
| `quality`, `width`, `height`, `background` | optional | the options, as separate fields… |
| `options` | optional | …or all of them as one JSON object: `{"width":512,"quality":80}`. **Not both.** |

**200**: the image, as `attachment; filename="converted.png"` or `"converted.jpeg"`, with
`Content-Type: image/png` / `image/jpeg` and `X-Conversion-Id`.

| Status | `code` | When |
|---|---|---|
| 400 | `VALIDATION_FAILED` | the form is wrong; an option is out of range, unknown, or **does not apply to the direction** (§3) |
| 400 | `UNSUPPORTED_CONVERSION` | the direction does not exist (anything → `svg`) |
| 400 | `INVALID_SOURCE` | not a valid image of its format: corrupt, truncated, an SVG that is not well-formed or has no size |
| 400 | `UNSAFE_SOURCE` | an SVG with scripts, event handlers, or references outside the file (§5) |
| 400 | `IMAGE_TOO_LARGE` | more pixels than allowed (read or produced), or a rasterised size over the maximum (§4) |
| 401 | `UNAUTHENTICATED` | no session |
| 413 | `FILE_TOO_LARGE` | over the byte limit for its format |
| 415 | `UNSUPPORTED_FORMAT` | not a PNG, JPEG or SVG |
| 422 | `CONVERSION_TIMEOUT` | did not finish within the time limit |

### `GET /api/images/convert/formats`

```json
[
  { "source": "jpeg", "target": ["png"] },
  { "source": "png",  "target": ["jpeg"] },
  { "source": "svg",  "target": ["jpeg", "png"] }
]
```

Built from the registry, scoped to the image family. `GET /api/convert/formats` lists these
directions together with the text formats.

---

## 3. Options

| Option | Applies to | Values | Default |
|---|---|---|---|
| `quality` | a **JPEG result** (png → jpeg, svg → jpeg) | whole number 1–100 | 80 |
| `width`, `height` | an **SVG source** | whole number 1 – `IMAGE_MAX_WIDTH` / `IMAGE_MAX_HEIGHT` | the SVG's own size |
| `background` | an **SVG source**, and **png → jpeg** | `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`; `transparent` for a PNG result | `#ffffff` |

**An option that does not apply is refused, not ignored.** A client sending `quality` with
`jpeg → png` believes it changed something, and is told otherwise. Raster images are converted,
not resized, so `width` and `height` apply to SVG only.

`background` also applies to PNG → JPEG, which goes beyond the spec (it names background for SVG
only). JPEG has no transparency, so a PNG's alpha has to become *some* colour. White is the
default, the same one the spec sets for SVG, and the option lets the caller choose it.

Values may be numbers or numeric strings. An all-digit form field is sent on as a number, so
`width=512` and `{"width":512}` arrive, and are stored in the history, the same way.

---

## 4. How each direction works

- **PNG → JPEG.** Transparency is laid on `background` (white by default), because JPEG has no
  alpha channel. Encoded at `quality`.
- **JPEG → PNG.** The EXIF orientation is applied to the pixels first, so a portrait photo stays
  portrait. A PNG keeps any alpha it is given (a JPEG has none to give).
- **SVG → PNG / JPEG.**
  - **Size.** The SVG's own size, as the renderer (librsvg) reads it: `width`/`height` in any
    unit, else the `viewBox`, else the extent of what is drawn. Given one of `width`/`height`,
    the other keeps the proportions. Given both, the drawing is fitted inside that box and
    centred, with `background` filling the rest.
  - **Rendering.** The vector is rendered at the density that produces the requested size
    directly, not drawn small and then stretched, so edges stay sharp at any size.
  - **Background.** White by default (the spec's default). `transparent` keeps a PNG
    transparent; a JPEG cannot be transparent, so that combination is refused.
  - **Limits.** The result is refused past `IMAGE_MAX_WIDTH` × `IMAGE_MAX_HEIGHT` (default
    8192 × 8192) or `IMAGE_MAX_PIXELS`. This is checked before rendering.

**Results carry no metadata.** EXIF, GPS and camera data are not copied into them, so a photo
does not leak where it was taken.

**Limits** (operator-set, in conversion-service's environment):

| Setting | Default | |
|---|---|---|
| `CONVERSION_MAX_BYTES_PNG` / `_JPEG` / `_SVG` | 10 MiB / 10 MiB / 2 MiB in compose | bytes, per source format, as for the text formats |
| `IMAGE_MAX_WIDTH`, `IMAGE_MAX_HEIGHT` | 8192 | the largest rasterised result, per side |
| `IMAGE_MAX_PIXELS` | 40 000 000 | the most pixels any image may have, read or produced |

---

## 5. Security

- **Decompression bombs.** A 50 KB PNG can declare itself 100 000 × 100 000 pixels, 40 GB once
  decoded. The dimensions are read from the **header** and checked against `IMAGE_MAX_PIXELS`
  before a single pixel is decoded. The decoder also enforces the same limit itself, in case the
  header and the data disagree.
- **SVG: refuse, never strip.** The renderer runs no scripts, but it does **load what a file
  points at**: `<image href="file:///etc/passwd">`, `url(http://169.254.169.254/…)`, CSS
  `@import`. That is the real threat, a request that makes the server read its own files or call
  internal addresses. Before the renderer sees the file:
  - every `href` must be a `#fragment` or an embedded raster (`data:image/png|jpeg|gif|webp;base64,…`);
  - every `url(…)`, in attributes and CSS, must be a `#fragment`;
  - `@import`, `xml:base`, `<?xml-stylesheet?>`, `<!DOCTYPE>` and `<!ENTITY>` are refused (the
    last two also close off XXE);
  - `<script>`, `<foreignObject>`, `<iframe>`, `<embed>`, `<object>`, `<audio>`, `<video>`, and
    every `on…` event attribute are refused. They would not run, but the spec says active content
    is not accepted.
  - Character references are decoded before checking (`&#x66;ile:` is `file:`). Escapes in CSS
    (`@\69mport`) are refused outright rather than decoded, since a drawing has no need of them.
  - At most 50 000 elements, and at most 100 levels of nesting.

  A file is refused with the reason, never cleaned and rendered: a cleaned file is a different
  drawing from the one the user sent, and they would not be told.
- **Detection by signature.** PNG and JPEG are recognised by their magic bytes, which outrank the
  file name. A JPEG named `photo.png` is converted as the JPEG it is.

---

## 6. Threads, time and memory

The engine is **sharp** (libvips, and librsvg for SVG). Its work runs on libuv's thread pool, not
on the main thread, so unlike the text formats, images need no worker thread of their own. The
pool is shared with file and DNS work, so the conversion image sets `UV_THREADPOOL_SIZE=8`, twice
`CONVERSION_RPC_CONCURRENCY`.

**Time.** Each pipeline gets sharp's own `timeout()`, which stops libvips mid-work, plus the
converter's deadline around it. Either one answers `422`.

**Memory.** Native memory is outside the V8 heap limit that bounds the text conversions. The pixel
limit is what bounds it: at the 40-megapixel default, about 160 MB per image in flight.

**Streaming.** As with the text formats, the upload and the result stream through storage. The
image itself is decoded in memory, within the byte limit and the pixel limit.

**Known limit.** A deliberately expensive SVG (huge blur filters, for example) is bounded by the
time limit and the output size, but librsvg can only be interrupted between stages. A render
can run briefly past its deadline before it stops, and the client still gets its `422` on time.

---

## 7. How detection was changed for this

Before images, the first module that recognised a file decided what it was. An SVG starts with
`<`, so the data module would have taken it for XML. Detection now carries a confidence:
signature 30 > extension 20 > specific content 15 (an `<svg>` root) > generic content 10 (a
leading `<` or `{`). The registry takes the surest answer, so module order never decides.

A family route asks only that family's modules. So on `/api/images/convert`, a `drawing.xml`
whose root is `<svg>` is the SVG it is; on `/api/convert` the `.xml` name wins and it is XML.

`FileConverter` gained `checkOptions()`, which by default refuses every option, so the text
formats take none. The RPC contract gained two optional fields: `options`, a flat bag of
primitives that only the converter interprets, and `family`. Neither names a format, so the next
module needs no contract change.

---

## 8. Where the code lives

| | |
|---|---|
| `apps/conversion-service/src/modules/image/` | `ImageConverter`; `image-options.ts` (which option applies where); `svg-safety.ts`; `image-formats.ts` (signatures, SVG sniffing) |
| `apps/conversion-service/src/modules/converters/` | `DETECTION` and `checkOptions()` on `FileConverter`; family-scoped `ConverterRegistry` |
| `apps/api-gateway/src/modules/conversions/` | `images.controller.ts`; `convert-fields.ts` (options as JSON or as fields) |
| `apps/conversion-service/prisma/migrations/20261012090000_conversion_options` | the `options` column |

Tests: `image.converter.spec.ts` uses real sharp on images made in the test (no fixtures):
alpha, orientation, sizing, sharpness, limits, bombs. `svg-safety.spec.ts` covers each way out
of the file, encoded and not. `image-options.spec.ts` covers every option in every direction. The
image route is also tested over real HTTP (`convert.e2e-spec.ts`) and against the running stack
(`scripts/smoke.sh`, `== images`).
