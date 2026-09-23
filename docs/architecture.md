# Architecture

Recast is a single Node process and a static page. There is no database, no build step, and no account system. Files live on disk under `data/` for a while; everything else (uploads, jobs, link downloads, the conversion graph) lives in memory and is gone when the process exits.

The page never converts anything itself. It uploads a file or asks the server to fetch a link, asks which conversions are possible, then starts a job. The server picks an engine, or a chain of engines, and writes the result.

## Processes and trust

`HOST` defaults to `127.0.0.1`. That is deliberate. The server will fetch any `http` or `https` URL you paste, and it will run ffmpeg, 7-Zip, LibreOffice, and yt-dlp on what comes back. On localhost, that is your own machine acting for you. Binding `0.0.0.0` makes the same process a proxy for anyone who can reach the port.

External programs are started with `spawn` and an argument array (`server/util.js`). Nothing the browser sends is passed through a shell. User-facing failures throw `UserError`; the message is returned as JSON and the stack stays on the server. A non-zero exit from a tool becomes a `UserError` whose `details` are the last lines of its output, which the page can show behind "Details".

`requestTimeout` is disabled. `headersTimeout` is 120 seconds and only covers the incoming request headers. Long work is not done inside one HTTP response: conversions and link downloads return an id immediately and the page polls.

## Layout

```
server/
  index.js              HTTP API and static files
  config.js             port, host, limits, directories
  jobs.js               upload records, conversion queue, retention
  fetch.js              link import (direct file or yt-dlp)
  registry.js           engines, route graph, chaining
  formats.js            format catalogue and filename aliases
  schema.js             option-field builders shared by engines and the UI
  tools.js              locate ffmpeg, 7-Zip, LibreOffice, yt-dlp, …
  util.js               spawn, filenames, time and page-range parsing
  engines/              one module per converter
public/
  index.html            shell
  css/app.css
  js/                   ES modules, loaded as-is by the browser
```

| UI module | Role |
| --- | --- |
| `app.js` | State, file list, uploads, link import, job polling, hash routing |
| `api.js` | `fetch` wrappers, including XHR upload progress |
| `form.js` | Turns a route schema into controls and remembers edited values |
| `picker.js` | Output-format popover |
| `formats.js` | `#/formats` catalogue and "pdf to docx" search |
| `ui.js` | Toasts, modals, the settings drawer |
| `util.js` | `h()` element helper, bytes, durations, `localStorage` |

`npm start` runs `server/index.js`. `npm run dev` restarts it when `server/` changes. The page is not bundled; editing `public/` is visible on refresh.

## What the page knows

On load the page calls `GET /api/meta`. The payload is the catalogue (`formats`, `categories`, `aliases`), the reachable targets for every format, which engines are installed, and the upload limit. The format picker and the Formats page are both rendered from that payload. After **Engines → Rescan** the page replaces it.

Client state is one list of rows. A row is a local file still uploading, a link still downloading, an upload ready to convert, or a finished job. There is a single 500 ms poll loop for conversion jobs and for link downloads. Upload progress is separate and uses XHR, three files at a time.

The only routes are hashes: `#/` is the converter, `#/formats` and `#/formats/<category>` are the catalogue. Theme (`system` / `light` / `dark`) and the last link-import settings live in `localStorage`.

Pasting files adds them to the list. Pasting one to ten `http` or `https` URLs, and nothing else, starts a link import with the saved settings. Pasting into an input or textarea is left to the browser.

## Two stores

**Uploads** are the inputs. `POST /api/uploads` writes the multipart body to `data/uploads/<id>/<safe name>` and registers it. Link import ends at the same `registerUpload`. Each record holds the path, the detected format, the size, and a probe (`width`, `duration`, page count, streams, and so on). The probe is whatever the first engine that claims that format returns, and it gives up after 15 seconds so a slow file does not block the response. Probe results are trimmed before they are sent to the browser (no raw stream lists).

**Jobs** are the outputs. A convert job points at one upload, a target format, the chosen route, and one options object per step. A merge job points at several uploads and always produces a PDF. Output files stay in `data/jobs/<id>/`. The upload is not modified, so the same file can be converted again with different settings.

Both maps are in memory. `resetStorage()` deletes `data/uploads` and `data/jobs` on startup, and `resetFetches()` does the same for `data/fetches`. A crash or a restart forgets every id. The sweep timer (every five minutes) deletes uploads and finished jobs older than `RETENTION_MINUTES`, and finished fetch records. An upload that a running job still needs is kept.

Filenames pass through `safeName`: control characters and path separators are stripped, the name is capped at 180 characters, and an empty name becomes `file`. That is why a download cannot choose its own directory.

## The queue

`CONCURRENCY` jobs run at once (2–4 by default, from the CPU count). The rest stay `queued` and report a queue position. Each job has its own `AbortController`. Cancel aborts it. `JOB_TIMEOUT_MIN` (120) aborts it too. The worker tells a timeout from a cancel by how long the job has been running.

A conversion walks the route one step at a time. Each step writes into `step0`, `step1`, … and the last step writes into `out`. If a step returns several files, the next step is applied to each of them. Progress is the fraction of steps finished, plus whatever the engine reports inside the current step, and it is capped at 0.99 until the job is marked done. The stage label comes from the engine id (`Encoding`, `LibreOffice`, …) and gains "step i/n" when the route has more than one step.

Fields marked `finalOnly` are removed from every step except the last. The Markdown converter's "complete document" switch is one of these: it only means something on the file the user actually downloads.

Merge is not a route. `POST /api/merge` builds one PDF with the image/PDF engine: images become pages, PDFs contribute their pages, and the order is whatever the dialog sent.

## Formats and the route graph

`server/formats.js` is the catalogue: a canonical id, a category, and a display name. `ALIASES` maps spellings onto those ids (`jpeg` → `jpg`, `yml` → `yaml`, `tar.gz` as a compound extension). Detecting a format is "read the filename". Bytes are not sniffed, except where an engine's probe later notices that the file is not what the name claimed.

An engine contributes edges, not a free-form converter:

```js
{ from: ['md', 'html'], to: ['docx', 'pdf'], cost: 1, same: true, sourceOnly: false }
```

`from: ['*']` is a wildcard edge. The only one today is "pack this file into an archive", at cost 5, so a real conversion always wins. A format is listed as supported only when at least one of its routes is a real edge. An unknown extension still gets the wildcard targets, which is why a nameless file can still be zipped.

`same: true` allows `from === to` (re-encode a PNG, recompress a PDF). Without it, a self-edge is dropped.

`sourceOnly: true` means the edge may be used from the file the user added, and not from an intermediate result. The browser's HTML → PNG/JPG/WebP edges are source-only. An uploaded HTML page can be screenshotted. HTML that appeared in the middle of a chain cannot, or a document would turn into a picture of its own markup instead of a rendered page.

### Chaining

Direct edges are not enough for DOCX → PNG. The router also walks through four pivot formats: `png`, `pdf`, `html`, `json`. From a pivot it may keep walking, up to four hops. Each extra hop adds 0.5 to the cost, so a direct edge of cost 1 beats two cheap hops.

Pivots are not open. Each one lists which source categories may enter it and which categories may come out. Rendered pages and video frames may only continue to everyday image formats (`jpg`, `webp`, `avif`, `tiff`, `gif`, `bmp`), which stops "grab a frame, then trace it to SVG, then …". An image may continue from `png` to `pdf`; a video frame may not.

The cheapest route wins. Costs are how an engine says "prefer me" or "I am a last resort":

| Edge | Cost | Why |
| --- | --- | --- |
| Browser HTML → PDF | 1 | Real layout. Used when Edge or Chrome is installed. |
| MuPDF HTML → PDF | 3 | Fallback when no browser is installed. |
| Pandoc → DOCX, ODT, EPUB, … | 0.95 | Beats the built-in markup engine when Pandoc is present. |
| Pandoc → Markdown / HTML | 1.3 | The built-in converter stays preferred for those. |
| Potrace raster → SVG | 1.5 | Tracing is a choice, not the default image conversion. |
| Archive wildcard | 5 | Packing is always available and almost never the best route. |

`GET /api/route?upload=<id>&to=<fmt>` returns that chain and the option schema of every step, already filtered. The settings drawer edits one object per step. "Apply to all" copies those objects onto other rows with the same source format and the same target.

## Engine contract

An engine module default-exports:

| Field | Required | Meaning |
| --- | --- | --- |
| `id`, `label` | yes | Stable id and the name shown in the UI |
| `detect()` | yes | `{ available, version, detail, note }`. Called at startup and on rescan. |
| `routes()` | yes | Edges. Return `[]` for a tool that is not a converter. |
| `schema(ctx)` | no | Option groups for `ctx.from`, `ctx.to`, `ctx.info`, `ctx.intermediate` |
| `convert(ctx)` | for converters | Returns absolute output paths |
| `probe(path, format)` | no | Metadata for the file row |
| `probeFormats()` | no | Formats this probe understands |
| `shutdown()` | no | Called on SIGINT/SIGTERM |
| `optional` | no | `{ install, url, adds }`, shown when `detect` says it is missing |

`convert` receives `input`, `from`, `to`, `o` (the options object), `outDir`, `baseName`, `tmpDir`, `signal`, `info`, `originalName`, and `progress(0..1)`. It must respect `signal` so cancel and the job timeout actually stop the work.

`schema.js` builds the fields (`select`, `number`, `range`, `toggle`, `text`, `textarea`, `color`, `time`, `multi`). `showIf` hides a field until another field has one of a set of values. The same JSON is what `form.js` renders. Engines do not ship HTML.

yt-dlp is registered as an engine so it shows up next to LibreOffice and Pandoc, with an install command. `routes()` returns `[]`. The download itself is `server/fetch.js`. The engine does not import `fetch.js`: `fetch.js` imports `jobs.js`, which imports the registry, and the registry imports the engine. Keeping the downloader out of that cycle is why detection of the cookies file is duplicated in the engine module.

### Where each conversion actually happens

| Engine | Runs | Notes |
| --- | --- | --- |
| `image` | sharp (libvips), plus ffmpeg or ImageMagick for formats sharp cannot open | HEIC is decoded in-process. ImageMagick, when installed, adds camera RAW, XCF, JPEG XL. |
| `trace` | Potrace | Raster to SVG, one colour or posterised. |
| `media` | ffmpeg | Video, audio, GIF/WebP/APNG, frames, visualisers. Hardware encoders (NVENC, AMF, QSV) are detected once with a one-frame encode and then offered in the codec list. Container/codec pairs are an allow-list, not "whatever ffmpeg accepts". |
| `subtitle` | ffmpeg | Text subtitle formats, and extracting a track from a video. |
| `pdf` | MuPDF | PDF and a few paged formats: render, text, structure, encrypt, rotate. |
| `imagepdf` | pdf-lib and MuPDF | Images to a PDF, and the multi-file merge. |
| `browser` | Puppeteer against the installed Edge, Chrome, or Brave | HTML/SVG to PDF. Screenshots of HTML only when that HTML is the original file. |
| `markup` | marked, turndown, mammoth, html-to-docx | Markdown, HTML, text, and DOCX without LibreOffice. |
| `data` | js-yaml, fast-xml-parser, smol-toml, Papa Parse | JSON, YAML, XML, TOML, CSV, INI, and tables. |
| `sheet` | SheetJS | Workbooks. The code-page tables ship beside the library so old XLS locales decode. |
| `archive` | 7-Zip | The `7zip-bin` dependency is a reduced build. RAR, CBR, and Zstandard appear only when a full `7z` is found on `PATH` or via `SEVENZIP_PATH` (`sevenZipFull`). |
| `font` | fonteditor-core | TTF, OTF, WOFF, WOFF2, EOT, SVG. WOFF2 is written by encoding a TTF with the `woff2` encoder, because fonteditor's own WOFF2 writer is unreliable. Hinting and kerning are dropped and retried if the encoder rejects the font. |
| `office` | LibreOffice `soffice` | One conversion at a time. LibreOffice cannot share a profile across two processes, so the engine serialises on a promise chain instead of the global job queue. |
| `pandoc` | Pandoc | Optional. Cheaper than the built-in markup engine for the formats it is better at, more expensive for Markdown and HTML. |
| `ebook` | Calibre `ebook-convert` | Optional. Kindle and the other formats MuPDF does not handle well. |
| `ytdlp` | none | Status light only. See [decisions](decisions.md). |

`tools.js` resolves a binary in this order: the environment variable, `PATH`, then a short list of default install paths (including `~/.local/bin/yt-dlp` whether or not that directory is on `PATH`). ffmpeg prefers `FFMPEG_PATH` and otherwise the `ffmpeg-static` package, which is a single ffmpeg binary with no ffprobe next to it.

## Link import

`POST /api/uploads/url` validates the URL (`http` or `https` only), checks the preference against a fixed list, and returns `202` with a fetch id. The work continues in `server/fetch.js`. Two downloads run at a time; further ones stay at stage "Waiting". The page adds a row immediately and polls `GET /api/fetches/:id`.

`auto` (the default, and what a paste uses) does a short ranged GET and reads the content type:

- A real file type, or a filename with an extension, is streamed to disk with a browser-like User-Agent. The body is capped at `MAX_UPLOAD_MB`. HTML is rejected with an install hint when yt-dlp is missing, so a web page is not saved as the file.
- Anything else goes to yt-dlp when the binary exists. If yt-dlp reports an unsupported URL and the probe did not look like a page, the same URL is fetched as a file.
- An explicit preference (`best`, `1080`, `720`, `480`, `audio`) always uses yt-dlp and fails fast when it is not installed.

When the download finishes, each kept file is moved into its own upload directory and probed. A playlist can therefore become many rows. The fetch directory is then deleted. If publishing fails part way, the uploads already registered are deleted too.

Cancel, removing the row, or the job timeout aborts the controller. yt-dlp is started in its own process group (`detached` on Linux, `taskkill /T` on Windows) so the ffmpeg it spawned dies with it. Other engines are not detached; ffmpeg there is the child process itself.

The choices, the flag quirks, and what was observed against a real YouTube link are written up in [decisions](decisions.md).

## HTTP API

| Method | Path | Behaviour |
| --- | --- | --- |
| `GET` | `/api/meta` | Catalogue, targets, engines, limits |
| `POST` | `/api/engines/rescan` | Re-locate binaries, re-run `detect`, rebuild the graph, return meta |
| `POST` | `/api/uploads` | Multipart field `file`. Optional `x-file-name` header (percent-encoded) because multipart filenames arrive as latin1. |
| `GET` | `/api/uploads/:id` | One upload |
| `DELETE` | `/api/uploads/:id` | Delete the upload and its directory |
| `POST` | `/api/uploads/url` | `{ url, preference?, playlist?, subtitles? }` → `202` fetch object |
| `GET` | `/api/fetches/:id` | `{ id, status, progress, stage, error, details, uploads }`. `uploads` is empty until `status` is `done`. |
| `POST` | `/api/fetches/:id/cancel` | Abort a running download |
| `GET` | `/api/route` | `?upload=&to=` or `?from=&to=`. Chain plus schemas. |
| `GET` | `/api/merge/schema` | Option groups for the merge dialog |
| `POST` | `/api/jobs` | `{ uploadId, to, options }` → job |
| `POST` | `/api/merge` | `{ uploadIds, options, name }` → job |
| `GET` | `/api/jobs?ids=a,b` | Many jobs. Unknown ids are omitted. |
| `GET` | `/api/jobs/:id` | One job |
| `POST` | `/api/jobs/:id/cancel` | Abort a queued or running job |
| `DELETE` | `/api/jobs/:id` | Drop the job and its output directory |
| `GET` | `/api/jobs/:id/download` | The file, or a zip when the job produced several |
| `GET` | `/api/jobs/:id/files/:index?inline=1` | One output. `inline=1` is the preview link. |
| `GET` | `/api/download?jobs=a,b` | Every finished result in those jobs, as one zip |
| `GET` | `/api/health` | `{ ok, uploads, jobs, running, queued }` |

Job `status` is `queued`, `processing`, `done`, `error`, or `cancelled`. Fetch `status` is `working`, `done`, `error`, or `cancelled`. `preference` is `auto`, `best`, `1080`, `720`, `480`, or `audio`. Unknown preference values become `auto`. `playlist` and `subtitles` count only when they are JSON `true`.

Errors are `{ error, details? }` with status 400 for a `UserError`, 413 for an upload over the limit, 404 when the id is gone.

## Configuration

See the table in the [README](../README.md). The directories under `DATA_DIR` are `uploads`, `jobs`, `fetches`, and `profiles` (the LibreOffice profile and the browser profile). All of them are disposable.
