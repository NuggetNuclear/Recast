# Recast

A self-hosted file converter in the spirit of CloudConvert: drop in almost any file, pick an output format, tune every setting, download. Everything runs locally on your machine.

## Quick start

```bash
npm install
npm start
```

Then open <http://localhost:3000>. Use `npm run dev` to auto-restart the server while editing `server/`.

### With Docker (everything included)

```bash
docker compose up -d --build
```

Then open <http://localhost:3000>. The image bundles every engine — FFmpeg and ffprobe, libvips, MuPDF, 7-Zip with RAR, Chromium, LibreOffice, Pandoc, Calibre, ImageMagick 7 and yt-dlp with its JavaScript solver and browser impersonation (curl_cffi) — so nothing needs to be installed on the host. yt-dlp updates itself each time the container starts (set `YTDLP_AUTO_UPDATE=0` to turn that off), so `docker compose restart` is usually enough when a video site changes. If YouTube asks you to sign in, save a `cookies.txt` exported from your browser as `cookies/cookies.txt` next to `docker-compose.yml`. Use `RECAST_PORT=8080 docker compose up -d` to publish on another port.

### Without Docker

Requires Node.js 20+. FFmpeg, libvips, MuPDF and 7-Zip ship with the npm dependencies. PDF rendering of HTML/Markdown uses the Edge or Chrome already installed on the machine. YouTube links need yt-dlp and, for yt-dlp's JavaScript solver, Node.js 22 or newer.

## Documentation

| Doc | What it covers |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | Process model, uploads and jobs, the route graph, the engine contract, the HTTP API |
| [docs/decisions.md](docs/decisions.md) | Why the router, the engines, and the link importer behave the way they do, including what broke against a real yt-dlp and a real YouTube link |

## What it converts

| Category | Engine | Highlights |
| --- | --- | --- |
| Images | sharp (libvips) + FFmpeg | JPG, PNG, WebP, AVIF, GIF, TIFF, HEIC, BMP, ICO, PSD, TGA, EXR, HDR, JP2, QOI, PNM… Resize, crop, rotate, colour adjustments, quality, palette quantisation, animation, metadata |
| Vector | Potrace, headless browser | Raster → SVG tracing (single colour or posterised), SVG → PDF |
| Video | FFmpeg | MP4, MKV, WebM, MOV, AVI, WMV, FLV, MPEG, 3GP, OGV, TS… H.264/H.265/AV1/VP9/ProRes, CRF / bitrate / target size, two-pass, NVENC/QSV/AMF, trimming, speed, fades, filters, subtitle burn-in |
| Animated | FFmpeg, sharp | Video → GIF (palette optimised), WebP, APNG; GIF → MP4 |
| Frames | FFmpeg | Single frame, every N seconds, N evenly spaced, contact sheets |
| Audio | FFmpeg | MP3 (CBR/VBR), AAC, M4A/ALAC, FLAC, WAV, OGG, Opus, WMA, AIFF, AC-3, AMR… Loudness normalisation, silence trimming, reverse, tags and cover art. Audio → video visualisers |
| Documents | MuPDF, marked, turndown, mammoth, headless browser | PDF → DOCX / Markdown / HTML / text / images / SVG; PDF compression, page selection, rotation, encryption; Markdown / HTML / DOCX / TXT → PDF with themes, paper size, margins, headers & footers |
| Ebooks | MuPDF | EPUB, MOBI, FB2, CBZ, XPS → PDF, images, text, DOCX with page size / font size control |
| Spreadsheets | SheetJS | XLSX, XLS, XLSB, ODS, Numbers, CSV, TSV, DBF, SYLK, DIF, JSON, HTML, Markdown; per-sheet export, delimiters, formatting |
| Data | js-yaml, fast-xml-parser, smol-toml, Papa Parse | JSON, JSON Lines, YAML, XML, TOML, CSV, INI ↔ each other, plus Markdown/HTML tables |
| Archives | 7-Zip | ZIP, 7Z, RAR, TAR(.GZ/.BZ2/.XZ), ISO, CAB… repack with compression level, method, AES encryption; compress any file |
| Fonts | fonteditor-core | TTF, OTF, WOFF, WOFF2, EOT, SVG fonts, with subsetting and renaming |
| Subtitles | FFmpeg | SRT, VTT, ASS, SSA, LRC, TTML; extract tracks from videos; timing shift; input encoding |

When no single engine can do a conversion, Recast chains them automatically (for example DOCX → HTML → PDF → PNG) and exposes the settings of every step.

Other features: batch conversion, “Convert all to…”, merging PDFs and images into one PDF, import from a URL (a direct file, or a YouTube/page link via yt-dlp), paste from clipboard, per-file settings with “apply to all”, download everything as one ZIP, light/dark themes.

## Optional engines

Install any of these and click **Engines → Rescan** (or restart) to unlock more formats. yt-dlp unlocks link downloads rather than extra formats:

| Tool | Adds | Install (Windows) |
| --- | --- | --- |
| LibreOffice | DOC, DOCX, ODT, RTF, XLS, PPT, PPTX, ODP, Pages, Keynote… with full layout fidelity | `winget install TheDocumentFoundation.LibreOffice` |
| Pandoc | reStructuredText, LaTeX, Org, AsciiDoc, Textile, MediaWiki, Typst, Jupyter, EPUB | `winget install JohnMacFarlane.Pandoc` |
| Calibre | MOBI, AZW3, FB2, LIT, LRF and professional ebook conversion | `winget install calibre.calibre` |
| ImageMagick | Camera RAW (CR2, NEF, ARW, DNG…), XCF, JPEG XL | `winget install ImageMagick.ImageMagick` |
| yt-dlp | YouTube and most other sites when you paste a link | `winget install yt-dlp.yt-dlp` |

On Linux, the standalone binary does not need a system Python:

```bash
mkdir -p ~/.local/bin
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o ~/.local/bin/yt-dlp
chmod +x ~/.local/bin/yt-dlp
```

Put `~/.local/bin` on `PATH`, or set `YTDLP_PATH` to the binary. On macOS, `brew install yt-dlp`. Recast uses the FFmpeg it already ships to merge video and audio, and points yt-dlp at the Node.js process that is running the server so YouTube's JavaScript challenges can be solved. For a video that requires a sign-in, set `YTDLP_COOKIES` to a `cookies.txt` file exported from your own browser. After installing, click **Engines → Rescan**.

Tools are found on `PATH` or in their default install folders; you can also point to them with `SOFFICE_PATH`, `PANDOC_PATH`, `CALIBRE_PATH`, `MAGICK_PATH`, `FFMPEG_PATH`, `FFPROBE_PATH`, `SEVENZIP_PATH`, `BROWSER_PATH` or `YTDLP_PATH`.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Interface to listen on (`0.0.0.0` to expose on your network) |
| `DATA_DIR` | `./data` | Where uploads and results are stored |
| `RETENTION_MINUTES` | `120` | Files are deleted after this long |
| `MAX_UPLOAD_MB` | `4096` | Maximum upload size |
| `CONCURRENCY` | 2–4 (by CPU) | Conversions running at the same time |
| `JOB_TIMEOUT_MIN` | `120` | Maximum time for a single conversion or link download |
| `YTDLP_PATH` | | Path to the yt-dlp binary, if it is not on `PATH` |
| `YTDLP_COOKIES` | | `cookies.txt` exported from your browser, for sites that require a sign-in |

The data directory is wiped when the server starts.

## Project layout

```
Dockerfile, docker-compose.yml, docker/   the all-engines container
docs/
  architecture.md   how the process, the queue, and the route graph fit together
  decisions.md      choices and the yt-dlp / YouTube behaviour behind them
server/
  index.js          HTTP API and static files
  jobs.js           upload store, conversion queue, retention
  fetch.js          link import: direct download or yt-dlp
| `BROWSER_NO_SANDBOX` | | `1` runs Chromium without its sandbox (needed in containers) |
| `YTDLP_AUTO_UPDATE` | | `1` updates yt-dlp when the Docker container starts (on by default there) |
  registry.js       engine registry and conversion router (chaining)
  formats.js        format catalogue and aliases
  schema.js         option fields the engines declare and the page renders
  tools.js          where external binaries are found
  engines/          one module per engine: routes, option schema, convert()
public/
  index.html, css/app.css, js/*.js   the page (ES modules, no build step)
```

Each engine declares the routes it supports, an option schema the UI renders as a form, and a `convert()` function. Adding a format usually means adding it to `formats.js` and to an engine's route list. The full contract is in [docs/architecture.md](docs/architecture.md).

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/meta` | Formats, categories, reachable targets per format, engine status |
| `POST` | `/api/engines/rescan` | Find newly installed tools and return a fresh meta payload |
| `POST` | `/api/uploads` | Multipart upload (`file`) → upload id + probed info |
| `GET` | `/api/uploads/:id` | One upload |
| `GET` | `/api/uploads/:id/file` | The uploaded or link-imported file as-is (`?inline=1` to view) |
| `DELETE` | `/api/uploads/:id` | Delete an upload |
| `POST` | `/api/uploads/url` | `{ url, preference?, playlist?, subtitles? }` starts a download. `preference` is `auto` (default), `best`, `1080`, `720`, `480` or `audio`. Returns `202` and a fetch id. |
| `GET` | `/api/fetches/:id` | Progress. When `status` is `done`, `uploads` lists the imported files. |
| `POST` | `/api/fetches/:id/cancel` | Cancel a link download |
| `GET` | `/api/route?upload=ID&to=fmt` | Conversion chain and option schema for every step |
| `GET` | `/api/merge/schema` | Options for the merge dialog |
| `POST` | `/api/jobs` | `{ uploadId, to, options: [ {…step 1}, … ] }` |
| `GET` | `/api/jobs?ids=a,b` | Status and progress |
| `GET` | `/api/jobs/:id` | One job |
| `POST` | `/api/jobs/:id/cancel` | Cancel a queued or running conversion |
| `DELETE` | `/api/jobs/:id` | Delete a job and its output |
| `GET` | `/api/jobs/:id/download` | Result (ZIP when there are several outputs) |
| `GET` | `/api/jobs/:id/files/:index` | One output. `?inline=1` displays it instead of downloading. |
| `POST` | `/api/merge` | `{ uploadIds, options, name }` → one PDF |
| `GET` | `/api/download?jobs=a,b` | Every result as one ZIP |
| `GET` | `/api/health` | Process is up, plus upload and queue counts |

Request and response shapes, status values, and why link downloads are asynchronous are in [docs/architecture.md](docs/architecture.md).
