# Recast

Un convertidor de archivos autohospedado al estilo de CloudConvert: arrastra casi cualquier archivo, elige un formato de salida, ajusta cada parámetro y descárgalo. Todo se ejecuta localmente en tu ordenador.

*[Read in English](README.md)*

## Inicio rápido

```bash
npm install
npm start
```

Luego abre <http://localhost:3000>. Usa `npm run dev` para reiniciar el servidor automáticamente mientras editas `server/`.

### Con Docker (todo incluido)

```bash
docker compose up -d --build
```

Luego abre <http://localhost:3000>. La imagen incluye todos los motores — FFmpeg y ffprobe, libvips, MuPDF, 7-Zip con RAR, Chromium, LibreOffice, Pandoc, Calibre, ImageMagick 7, Assimp y yt-dlp con su solucionador JavaScript y emulación de navegador (curl_cffi) — sin necesidad de instalar nada en el sistema anfitrión. yt-dlp se actualiza solo cada vez que se inicia el contenedor (establece `YTDLP_AUTO_UPDATE=0` para desactivarlo). Si YouTube requiere iniciar sesión, guarda un `cookies.txt` exportado desde tu navegador como `cookies/cookies.txt` junto a `docker-compose.yml`. Usa `RECAST_PORT=8080 docker compose up -d` para publicarlo en otro puerto.

### Sin Docker

Requiere Node.js 20+. FFmpeg, libvips, MuPDF y 7-Zip se incluyen con las dependencias de npm. La renderización de PDF desde HTML/Markdown utiliza Edge o Chrome ya instalado en el sistema. Los enlaces de YouTube requieren yt-dlp y, para el solucionador JavaScript de yt-dlp, Node.js 22 o superior.

## Documentación

| Documento | Qué cubre |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | Modelo de procesos, subidas y tareas, grafo de rutas, contrato de motores, API HTTP |
| [docs/decisions.md](docs/decisions.md) | Decisiones de diseño de router, motores e importación de enlaces |

## Qué convierte

| Categoría | Motor | Aspectos destacados |
| --- | --- | --- |
| Imágenes | sharp (libvips) + FFmpeg | JPG, PNG, WebP, AVIF, GIF, TIFF, HEIC, BMP, ICO, PSD, TGA, EXR, HDR, JP2, QOI, PNM… Redimensión, recorte, rotación, ajustes de color, calidad, cuantización de paleta, animación, metadatos |
| Vectorial | Potrace, navegador headless | Raster → vectorización a SVG (color único o posterizado), SVG → PDF |
| Vídeo | FFmpeg | MP4, MKV, WebM, MOV, AVI, WMV, FLV, MPEG, 3GP, OGV, TS… H.264/H.265/AV1/VP9/ProRes, CRF / tasa de bits / tamaño objetivo, doble pasada, NVENC/QSV/AMF, recorte, velocidad, transiciones, filtros, subtítulos incrustados |
| Animación | FFmpeg, sharp | Vídeo → GIF (paleta optimizada), WebP, APNG; GIF → MP4 |
| Fotogramas | FFmpeg | Fotograma único, cada N segundos, N espaciados equitativamente, hojas de contactos |
| Audio | FFmpeg | MP3 (CBR/VBR), AAC, M4A/ALAC, FLAC, WAV, OGG, Opus, WMA, AIFF, AC-3, AMR… Normalización de volumen, recorte de silencios, inversión, etiquetas y carátulas. Visualizadores de audio a vídeo |
| Documentos | MuPDF, marked, turndown, mammoth, navegador headless | PDF → DOCX / Markdown / HTML / texto / imágenes / SVG; compresión de PDF, selección de páginas, rotación, cifrado; Markdown / HTML / DOCX / TXT → PDF con temas, tamaño de papel, márgenes, encabezados y pies de página |
| Libros | MuPDF | EPUB, MOBI, FB2, CBZ, XPS → PDF, imágenes, texto, DOCX con control de tamaño de página y fuente |
| Hojas de cálculo | SheetJS | XLSX, XLS, XLSB, ODS, Numbers, CSV, TSV, DBF, SYLK, DIF, JSON, HTML, Markdown; exportación por hoja, delimitadores, formato |
| Datos | js-yaml, fast-xml-parser, smol-toml, Papa Parse | JSON, JSON Lines, YAML, XML, TOML, CSV, INI ↔ entre sí, tablas Markdown/HTML |
| Archivos | 7-Zip | ZIP, 7Z, RAR, TAR(.GZ/.BZ2/.XZ), ISO, CAB, DMG, VHD/VHDX/VMDK, MSI, LZ, SquashFS, paquetes basados en ZIP (WAR, WHL, NUPKG, IPA…)… compresión, método, cifrado AES; compresión de cualquier archivo |
| Fuentes | fonteditor-core | Fuentes TTF, OTF, WOFF, WOFF2, EOT, SVG, con reducción de caracteres y renombrado |
| Modelos 3D | Assimp | STL, OBJ, PLY, glTF/GLB, FBX, COLLADA, 3DS, 3MF, OFF → STL, OBJ, PLY, glTF/GLB, FBX, COLLADA, 3DS, 3MF, X3D; binario o texto, triangulación, normales |
| Subtítulos | FFmpeg | SRT, VTT, ASS, SSA, LRC, TTML, SAMI, SCC, MPL2; extracción de pistas de vídeos; desfase de tiempo; codificación de entrada |

Cuando ningún motor puede realizar una conversión directa, Recast los encadena automáticamente (por ejemplo DOCX → HTML → PDF → PNG) y expone los ajustes de cada paso.

Otras funciones: conversión por lotes, “Convertir todo a…”, combinación de PDF e imágenes en un solo PDF, importación desde URL (archivo directo o enlace de YouTube/página web con yt-dlp), pegar desde el portapapeles, ajustes por archivo con “aplicar a todos”, descarga en un solo archivo ZIP, temas claro/oscuro y selector de idioma (Español / Inglés).

## Motores opcionales

Instala cualquiera de estos y haz clic en **Motores → Reescanear** (o reinicia) para desbloquear más formatos:

| Herramienta | Añade | Instalación (Windows) |
| --- | --- | --- |
| LibreOffice | DOC, DOCX, ODT, RTF, XLS, PPT, PPTX, ODP, Pages, Keynote… con total fidelidad visual | `winget install TheDocumentFoundation.LibreOffice` |
| Pandoc | reStructuredText, LaTeX, Org, AsciiDoc, Textile, MediaWiki, Typst, Jupyter, EPUB | `winget install JohnMacFarlane.Pandoc` |
| Calibre | MOBI, AZW3, FB2, LIT, LRF y conversión profesional de libros electrónicos | `winget install calibre.calibre` |
| ImageMagick | RAW de cámara (CR2, NEF, ARW, DNG…), XCF, JPEG XL | `winget install ImageMagick.ImageMagick` |
| yt-dlp | YouTube y la mayoría de sitios web al pegar un enlace | `winget install yt-dlp.yt-dlp` |

## Configuración

| Variable | Valor por defecto | Significado |
| --- | --- | --- |
| `PORT` | `3000` | Puerto HTTP |
| `HOST` | `127.0.0.1` | Dirección de escucha (`0.0.0.0` para exponer en red local) |
| `DATA_DIR` | `./data` | Directorio de almacenamiento temporal de archivos |
| `RETENTION_MINUTES` | `120` | Los archivos se eliminan automáticamente tras este tiempo |
| `MAX_UPLOAD_MB` | `4096` | Tamaño máximo de subida |
| `CONCURRENCY` | 2–4 (según CPU) | Conversiones simultáneas en ejecución |
| `JOB_TIMEOUT_MIN` | `120` | Tiempo límite por conversión o descarga |
| `YTDLP_PATH` | | Ruta al ejecutable yt-dlp si no está en `PATH` |
| `YTDLP_COOKIES` | | Archivo `cookies.txt` exportado para sitios con inicio de sesión |
| `MAX_IMAGE_PIXELS` | `100000000` | Máximo de píxeles de imagen decodificados por archivo. Las imágenes mayores fallan con un mensaje que nombra esta variable. |
| `MAX_EXTRACT_MB` | 4 × `MAX_UPLOAD_MB` | Tamaño total máximo de un archivo comprimido una vez extraído |
| `MAX_EXTRACT_FILES` | `10000` | Número máximo de archivos en un archivo comprimido extraído |
| `RECAST_AUTH_USER` | | Usuario de Basic Auth (requerido si `HOST` no es loopback) |
| `RECAST_AUTH_PASSWORD` | | Contraseña de Basic Auth; úsala junto al usuario |

Por defecto, Recast es solo para uso local. En `docker-compose.yml`, el puerto está mapeado únicamente a loopback (`127.0.0.1:3000:3000`) con `RECAST_ALLOW_UNAUTHENTICATED=1`, lo que permite su uso local sin configuración adicional.

Para exponer Recast a tu red local (LAN):
- **Con Docker**: En `docker-compose.yml`, cambia el mapeo de puertos a `"3000:3000"` (o `"0.0.0.0:3000:3000"`), elimina `RECAST_ALLOW_UNAUTHENTICATED: 1` (o establécelo en `0`), y define tanto `RECAST_AUTH_USER` como `RECAST_AUTH_PASSWORD`.
- **Sin Docker**: Ejecuta con `HOST=0.0.0.0` y define tanto `RECAST_AUTH_USER` como `RECAST_AUTH_PASSWORD`.

Recast rechazará iniciar en interfaces externas sin credenciales a menos que se defina explícitamente `RECAST_ALLOW_UNAUTHENTICATED=1`.
