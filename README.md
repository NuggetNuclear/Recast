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

Then open <http://localhost:3000>. The image bundles every engine — FFmpeg, libvips, MuPDF, 7-Zip with RAR, Chromium, LibreOffice, Pandoc, Calibre, ImageMagick 7 and yt-dlp — so nothing needs to be installed on the host. yt-dlp updates itself each time the container starts (set `YTDLP_AUTO_UPDATE=0` to turn that off), so `docker compose restart` is usually enough when a video site changes. Use `RECAST_PORT=8080 docker compose up -d` to publish on another port.

### Without Docker

Requires Node.js 20+. FFmpeg, libvips, MuPDF and 7-Zip ship with the npm dependencies. PDF rendering of HTML/Markdown uses the Edge or Chrome already installed on the machine.

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

**Videos from the web:** *Add from URL* accepts direct file links and, when yt-dlp is installed, pages from YouTube, Vimeo, SoundCloud, Twitch, X and 1,800+ other sites. Choose video (up to a maximum resolution) or audio only; the download shows live progress and the result can be converted like any other file. If YouTube answers “Sign in to confirm you’re not a bot”, export your browser cookies with an extension such as *Get cookies.txt LOCALLY*, save them as `cookies/cookies.txt` next to `docker-compose.yml` (or point `YTDLP_COOKIES` at the file) and try again.

Other features: batch conversion, “Convert all to…”, merging PDFs and images into one PDF, import from URL, paste from clipboard, per-file settings with “apply to all”, download everything as one ZIP, light/dark themes.

## Optional engines

Install any of these and click **Engines → Rescan** (or restart) to unlock more formats:

| Tool | Adds | Install (Windows) |
| --- | --- | --- |
| LibreOffice | DOC, DOCX, ODT, RTF, XLS, PPT, PPTX, ODP, Pages, Keynote… with full layout fidelity | `winget install TheDocumentFoundation.LibreOffice` |
| Pandoc | reStructuredText, LaTeX, Org, AsciiDoc, Textile, MediaWiki, Typst, Jupyter, EPUB | `winget install JohnMacFarlane.Pandoc` |
| Calibre | MOBI, AZW3, FB2, LIT, LRF and professional ebook conversion | `winget install calibre.calibre` |
| ImageMagick | Camera RAW (CR2, NEF, ARW, DNG…), XCF, JPEG XL | `winget install ImageMagick.ImageMagick` |
| yt-dlp | Downloading from YouTube and other video sites | `pip install -U "yt-dlp[default]"` |

Tools are found on `PATH` or in their default install folders; you can also point to them with `SOFFICE_PATH`, `PANDOC_PATH`, `CALIBRE_PATH`, `MAGICK_PATH`, `YTDLP_PATH`, `FFMPEG_PATH`, `SEVENZIP_PATH` or `BROWSER_PATH`.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Interface to listen on (`0.0.0.0` to expose on your network) |
| `DATA_DIR` | `./data` | Where uploads and results are stored |
| `RETENTION_MINUTES` | `120` | Files are deleted after this long |
| `MAX_UPLOAD_MB` | `4096` | Maximum upload size |
| `CONCURRENCY` | 2–4 (by CPU) | Conversions running at the same time |
| `JOB_TIMEOUT_MIN` | `120` | Maximum time for a single conversion or download |
| `YTDLP_COOKIES` | — | cookies.txt passed to yt-dlp |
| `BROWSER_NO_SANDBOX` | — | `1` runs Chromium without its sandbox (needed in containers) |

The data directory is wiped when the server starts.

## Project layout

```
server/
  index.js          HTTP API (uploads, jobs, downloads)
  download.js       Add from URL: direct downloads and yt-dlp
  jobs.js           upload store, job queue, clean-up
  registry.js       engine registry and conversion router (chaining)
  formats.js        format catalogue and aliases
  engines/          one module per engine: routes, option schema, convert()
public/
  index.html, css/app.css, js/*.js   the single-page UI (no build step)
```

Each engine declares the routes it supports, an option schema the UI renders as a form, and a `convert()` function. Adding a format usually means adding it to `formats.js` and to an engine's route list.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/meta` | Formats, categories, reachable targets per format, engine status |
| `POST` | `/api/uploads` | Multipart upload (`file`) → upload id + probed info |
| `POST` | `/api/imports` | `{ url, mode: auto\|video\|audio\|file, quality: best\|1080… }` → import id |
| `GET` | `/api/imports/:id` | Download progress; `upload` once done |
| `DELETE` | `/api/imports/:id` | Cancel a download |
| `GET` | `/api/route?upload=ID&to=fmt` | Conversion chain and option schema for every step |
| `POST` | `/api/jobs` | `{ uploadId, to, options: [ {…step 1}, … ] }` |
| `GET` | `/api/jobs?ids=a,b` | Status and progress |
| `GET` | `/api/jobs/:id/download` | Result (ZIP when there are several outputs) |
| `POST` | `/api/merge` | `{ uploadIds, options, name }` → one PDF |
| `GET` | `/api/download?jobs=a,b` | Every result as one ZIP |
