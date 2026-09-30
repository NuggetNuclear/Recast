# Decisions and discoveries

## Security

Recast is a local tool, but uploads, pasted URLs, and conversion options are untrusted. This table maps the main entry points to their sinks and controls.

| Entry point | Sink | Risk and control |
| --- | --- | --- |
| `POST /api/uploads`, `registerUpload` | Multer writes to `data/uploads/<uuid>`; probe engines read the file | Malformed media reaches native parsers. Upload size, UUID directories, safe filenames, probe timeouts, and the image pixel ceiling limit impact. |
| `POST /api/uploads/url`, `fetch.js` | Node `fetch` (`undici`), redirect targets, streamed file writes | SSRF and DNS rebinding. Connect-time validation via `safeAgent` (`undici.Agent`) inspects every resolved IP on every request and manual redirect hop; CIDR validation uses `net.BlockList` covering private IPv4/IPv6 ranges, IPv4-mapped IPv6 (`::ffff:`), and RFC 6052 NAT64 (`64:ff9b::/96`). Non-IP strings and private addresses fail closed. Bodies are capped by `MAX_UPLOAD_MB`. |
| URL import with yt-dlp | yt-dlp and its ffmpeg child process | Network access and process abuse. Pre-flight URL check rejects literal private IPs and loopback hostnames. Preferences are an allow-list, config loading is disabled when supported, output is confined to the fetch directory, and process groups are killed on cancellation. |
| `/api/jobs`, queue worker | Every engine's `convert()` and temporary/output directories | Untrusted bytes reach FFmpeg, libvips, MuPDF, 7-Zip, Office, Pandoc, Calibre, ImageMagick, Assimp, and font parsers. Step options are validated server-side against declared schemas (`validateStepOptions` in `registry.js`; enums/selects, bounded numbers, booleans, string length without NUL bytes); unknown keys are stripped. Jobs are time-limited. |
| Archive conversion | 7-Zip extraction into a temporary directory | Zip-slip or archive bombs. Pre-extraction `7z l -slt` listing check verifies entry paths after the header boundary; post-extraction disk walk (`fs.lstat`) rejects symlinks, verifies entries reside strictly within extraction directory via `realpath` and `path.relative`, and enforces extraction limits (`MAX_EXTRACT_MB`, `MAX_EXTRACT_FILES`). |
| HTML/Markdown/PDF-to-browser routes | Chromium `file://` page and child browser | Scripted documents could read local files or call the network. Windows file URLs are converted via `fileURLToPath` to prevent drive-letter corruption. Request interception permits only the input directory and blocks non-file requests; because interception does not see WebSockets, the browser is also launched with a dead proxy (`--proxy-server=socks5://127.0.0.1:1`, loopback included) so no network connection of any kind can leave the page. The sandbox remains enabled unless `BROWSER_NO_SANDBOX=1` is explicitly set. |
| Download routes and `sendFile` | Files stored under job/upload UUID directories | Traversal through IDs or output indexes. IDs must be UUIDs, indexes are bounded integers, and names are sanitized; paths originate from server-owned records. |
| All API routes and static files | HTTP responses, SSE, and static UI assets | LAN exposure without authentication. Fail-closed startup validation enforces that binding non-loopback interfaces (`HOST !== 127.0.0.1 / ::1 / localhost`) requires both `RECAST_AUTH_USER` and `RECAST_AUTH_PASSWORD`. Basic Auth middleware guards all API routes (including `/api/health`) and static assets before any processing. Credentials are compared using timing-safe SHA-256 digests. Legacy raw TCP `dev-proxy.js` has been removed. |

High and critical fixes are centralized in `server/security.js` and engine schemas, keeping the engine contract unchanged. External programs still receive argument arrays through `spawn`, never shell text. Option validation drops unknown keys and strictly enforces schema boundaries without breaking legitimate values (such as negative loudness targets).

Deferred risks:
- **yt-dlp internal DNS resolution**: Initial URL verification catches literal private IPs and loopback hostnames before invoking yt-dlp. However, yt-dlp executes its own Python/C-based networking and resolver stack that does not route through `safeAgent`. A completely race-free DNS rebinding defense against private network exfiltration for yt-dlp requires OS-level egress filtering (e.g. firewall, egress proxy, or network namespaces/Docker containers).
- **Native decompression ratios and complexity**: Decompression and filter complexity are bounded by `MAX_UPLOAD_MB`, `MAX_EXTRACT_MB`, and `JOB_TIMEOUT_MIN`, but engine-internal native memory limits remain dependent on tool implementations.

This file records choices that are easy to undo by accident, and behaviour that only showed up once a real tool or a real site was involved. The structure those choices sit in is [architecture](architecture.md).

## Conversion graph

**Chain through a few pivots instead of listing every pair.** Engines declare the edges they can do in one step. `registry.js` searches outward through `png`, `pdf`, `html`, and `json`, at most four hops, with a 0.5 penalty per extra hop. A new format is a catalogue entry plus an edge. It does not require a matrix edit. The pivot rules exist so the search cannot invent a conversion that type-checks and still makes no sense, such as turning a video frame into an SVG trace and then into a PDF.

**Cost is a preference, not a measurement.** Pandoc is 0.95 into DOCX and 1.3 into Markdown, so it wins where it is better and loses where the built-in converter is enough. The browser's HTML → PDF edge is 1 and MuPDF's is 3, so a machine with Edge or Chrome renders pages, and a machine without one still gets a PDF. The archive wildcard costs 5 so "zip it" never beats a real conversion.

**`sourceOnly` on browser screenshots.** HTML → PNG is only offered for the file the user added. If it were a normal edge, a chain that passed through HTML would photograph the markup.

**LibreOffice is serial, on its own queue.** Two `soffice` processes on one profile corrupt each other or fail. The global job queue will still run an image encode beside an Office conversion. Office conversions wait on each other.

**The bundled 7-Zip is not the full one.** `7zip-bin` is what you get with `npm install`. It does not unpack RAR or Zstandard. Those formats are added only when `tools.js` finds a real `7z` and sets `sevenZipFull`.

**WOFF2 is not written by fonteditor.** Its WOFF2 writer produced empty or rejected fonts. The font engine writes a TTF and compresses that with the `woff2` package, retrying without kerning and then without hinting if the encoder refuses the tables.

**Hardware encoders are probed, not assumed.** NVENC, AMF, and QSV are each asked to encode one black frame. The ones that succeed are appended to the codec list. A failed probe is silence, not a startup error.

**Format identity is the filename.** `detectFormat` uses the extension and the alias table. Content sniffing would mis-label a lot of the formats ffmpeg and 7-Zip already understand by name, and it would make the route graph depend on a probe that can time out. The probe still runs, but it fills in dimensions and duration; it does not rename the format.

## Link import

The feature is "paste a link, get a file, convert it with the engines above". yt-dlp is not a conversion step. It is an importer that ends in `registerUpload`, same as a drag-and-drop.

**The POST returns immediately.** A YouTube download can run for many minutes. Holding the request open fought `headersTimeout` and made cancel awkward. The client polls a fetch record, the same way it polls a conversion. The fetch record stores progress and, at the end, the upload JSON. It does not store a path the browser could read.

**`auto` tries to tell a file from a page before spending a yt-dlp startup.** A ranged GET looks at `Content-Type`. `text/html` is a page. A PDF, image, or zip content type is a file and is streamed in-process. A page with yt-dlp missing is an error that names the missing tool, not an HTML file saved into the list. `example.com` with yt-dlp installed ends as "yt-dlp does not support this link" (`Unsupported URL` from the generic extractor). Some hosts answer 403 even to a browser User-Agent; that status is reported as-is (`https://www.w3.org/.../dummy.pdf` did this). `httpbin.org/image/png` and a public sample PDF imported and probed normally.

**The browser cannot pass yt-dlp flags.** `preference` is one of `auto`, `best`, `1080`, `720`, `480`, `audio`. Anything else is rejected with a 400. `playlist` and `subtitles` are booleans. There is no format string, no `--exec`, no extra arguments. The server also passes `--ignore-config` when that flag exists, so a yt-dlp config file in the home directory cannot add `--exec` or change the format behind the dialog.

**Quality presets do not re-encode.** Video is `bv*+ba/b` (or the same with a height cap) merged to MKV. MKV accepts AV1, VP9, and Opus. Merging to MP4 fails or silently drops those streams. Height caps fall through to the best file the site actually has: the 19-second YouTube video `jNQXAC9IVRw` ("Me at the zoo"), requested at 480p, came back as a 320×240 AV1+Opus MKV because that is the source. Metadata and chapters are embedded when those flags exist. Thumbnails are not written; a small JPEG next to a video was being picked up as a second upload.

**Audio does not depend on ffprobe.** `ffmpeg-static`, which Recast ships, is ffmpeg only. yt-dlp's `-x` / `--audio-format` path needs ffprobe, and it fails closed when ffprobe is absent. Recast passes `-x --audio-format best` only when an ffprobe binary sits beside ffmpeg or is on `PATH`. Otherwise it downloads the best audio (or the combined file, if the site has no audio-only stream) and, when the result still has a real video stream, strips it with `ffmpeg -vn -c:a copy`, falling back to AAC in an M4A if the copy into the native container fails. The same YouTube video requested as audio came back as a 19-second stereo Opus file that the media probe could read.

**At most 25 playlist items, and only when the box is checked.** Current yt-dlp (verified against 2026.08.19) no longer documents `--playlist-end`. The limit is `--playlist-items 1:25`, with `--playlist-end` kept only as a fallback for an older binary that still has it. `--no-playlist` is passed otherwise, because a watch URL that also carries a list id would otherwise download the whole list. After the process exits, Recast still caps what it imports: 25 media files and 25 subtitle files for a playlist, or a handful for a single link. Live streams are skipped with `--match-filters !is_live`, which is the example yt-dlp's own help gives for "not a live video". An open-ended live download would fill the disk. The help's aside that a missing numeric field still matches is about filters like `like_count`, not about `is_live`, so this filter is used as documented and has not been probed against a live URL.

**Flag names are checked against `yt-dlp --help`, and the check has to be exact.** Help is cached per binary path. Two traps from that version's help text:

- The filter flag is `--match-filters`, plural. `--match-filter` is not a flag. It is a prefix of `--match-filters`, so `help.includes('--match-filter')` is true and the process then dies with "no such option". Detection uses a regex that refuses another letter or hyphen after the flag.
- `--playlist-end` is absent. Shipping it unconditionally would make every playlist download fail.

`--js-runtimes` and `--remote-components` are passed only when help contains them, so an older yt-dlp that has never heard of them still runs.

**YouTube needs a JavaScript runtime, and Node is not the default.** As of the 2026 yt-dlp EJS setup, YouTube challenge scripts run outside yt-dlp. Deno is enabled by default. Node is not, until `--js-runtimes node:/path/to/node`. Recast points that at `process.execPath`. The EJS scripts themselves are bundled in the official `yt-dlp_linux` / PyInstaller binaries. A pip install often does not include them unless it was `yt-dlp[default]`. Passing `--remote-components ejs:github` lets those installs fetch the matching scripts. The runtime yt-dlp documents for Node is 22 or newer. Recast itself starts on Node 20; YouTube extraction on a Node 20 host can still fail inside yt-dlp even though every other site works.

**Subtitles are fetched before the video, and one failed language aborts the run.** With `--sub-langs "en.*"`, yt-dlp expanded the request to `en`, `en-en`, and `en-de`, wrote the first two `.vtt` files, then exited 1 on `HTTP Error 429` for `en-de`. The video file did not exist yet. The whole import failed and the page showed a rate-limit error. Two changes keep the video:

- The language list is `en`, not `en.*`, plus `-live_chat` so live chat replays are not saved as subtitles.
- When subtitles were requested, the command includes `--ignore-errors`. A later non-zero exit still keeps the result if a media file is on disk. Subtitle-only leftovers (the `.vtt` files from the failed run) are not imported as a successful download.

With that in place, the same video plus subtitles produced the MKV and a separate `en.srt`. The SRT is its own upload, so it can be converted with the subtitle engine. Subtitles are not burned in.

**Downloaded names stay inside the fetch directory.** The output template is a single filename (`title [id].ext`, or `index - title [id].ext` for a playlist). `--windows-filenames` replaces characters a title could use to escape the directory; failing that, `--restrict-filenames` is the older switch. After the process exits, every file is `realpath`'d and dropped if it is not under the fetch directory. Partial files (`.part`, `.ytdl`, `.temp`) and sidecars (`.info.json`, `.description`) are ignored. A title that survives is then passed through `safeName` when it becomes an upload. A URL whose last segment has no dot gets an extension from the content type, which is why `https://httpbin.org/image/png` is stored as `png.png`.

**Cookies are a file path in the environment, never a request field.** `YTDLP_COOKIES` may point at a `cookies.txt` in the text format yt-dlp reads (the format is still described in yt-dlp's own help with its historical name). The server does not read a browser profile, and it does not accept cookie contents from the page. Most links never need the file. It matters when a site answers with a sign-in or "confirm you are not a bot" error; that case is rewritten into a message that names the variable.

**Two process-wide limits, on purpose.** At most two yt-dlp or direct downloads run together (`MAX_PARALLEL`). Each one is also capped by `MAX_UPLOAD_MB` (`--max-filesize` for yt-dlp, a counting stream for a direct GET) and by `JOB_TIMEOUT_MIN`. The fetch directory is removed in a `finally`, including after a failure.

## UI consequences

The format button stays disabled while a link is still downloading. The format is unknown until the upload exists, and the wildcard "zip it" targets would otherwise look like a real choice.

Removing a row before the `202` comes back still has to cancel the server work. The row is marked removed immediately, and the response handler calls cancel if the row is no longer waiting. Otherwise the download would finish into an upload nothing is showing.

Link-import settings (quality, playlist, subtitles) are remembered under the `localStorage` key `url-import`. A paste uses that memory and does not open the dialog. The dialog is there when you want a different quality than last time.

## What was run

Against yt-dlp `2026.08.19` and the ffmpeg binary from `ffmpeg-static`, on this machine:

| Input | Result |
| --- | --- |
| `https://httpbin.org/image/png` | PNG, probed as 100×100 |
| A public one-page sample PDF | PDF, probed as one page |
| `https://example.com` | Error: yt-dlp does not support this link |
| YouTube `jNQXAC9IVRw` at 480p | MKV, AV1 320×240, Opus stereo, 19.03 s, title embedded |
| The same URL as audio | Opus, 19.03 s, no video stream |
| The same URL at 480p with subtitles, after the `en` / `--ignore-errors` change | The MKV plus `Me at the zoo [jNQXAC9IVRw].en.srt` |
| The same URL with `en.*` and no `--ignore-errors` | Exit 1 during subtitles, no video file, HTTP 429 on `en-de` |
| Cancel during a direct download | Fetch status `cancelled`, no upload left behind |

A playlist was not downloaded end to end. The 25-item cap is the flag above plus the post-process slice.
