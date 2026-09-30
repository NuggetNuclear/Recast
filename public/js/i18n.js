// Internationalization (i18n) module for Recast
// Supports Spanish ('es') and English ('en') with automatic detection and persistence.

import { storage } from './util.js';

const STORAGE_KEY = 'recast_lang';
const listeners = new Set();

function detectInitialLang() {
  const saved = storage.get(STORAGE_KEY, null);
  if (saved === 'es' || saved === 'en') return saved;
  const browser = (typeof navigator !== 'undefined' && navigator.language) ? navigator.language.toLowerCase() : '';
  if (browser.startsWith('es')) return 'es';
  // Default to Spanish if requested or English otherwise.
  // Since the user asked for Spanish support in this instance, if browser is Spanish or preference is set, use it.
  return 'es';
}

let current = detectInitialLang();

export function currentLang() {
  return current;
}

export function setLang(lang) {
  if (lang !== 'es' && lang !== 'en') return;
  current = lang;
  storage.set(STORAGE_KEY, lang);
  if (typeof document !== 'undefined') {
    document.documentElement.lang = lang;
  }
  for (const fn of listeners) {
    try { fn(lang); } catch (e) { console.error('i18n listener error:', e); }
  }
}

export function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const CATEGORIES = {
  es: {
    image: 'Imagen',
    vector: 'Vectorial',
    video: 'Vídeo',
    audio: 'Audio',
    document: 'Documento',
    ebook: 'Libro electrónico',
    spreadsheet: 'Hoja de cálculo',
    presentation: 'Presentación',
    data: 'Datos',
    archive: 'Archivo comprimido',
    font: 'Fuente',
    subtitle: 'Subtítulo',
    model: 'Modelo 3D',
    other: 'Otro',
  },
  en: {
    image: 'Image',
    vector: 'Vector',
    video: 'Video',
    audio: 'Audio',
    document: 'Document',
    ebook: 'Ebook',
    spreadsheet: 'Spreadsheet',
    presentation: 'Presentation',
    data: 'Data',
    archive: 'Archive',
    font: 'Font',
    subtitle: 'Subtitle',
    model: '3D model',
    other: 'Other',
  },
};

const FORMAT_NAMES = {
  es: {
    jpg: 'Imagen JPEG',
    jpeg: 'Imagen JPEG',
    png: 'Imagen PNG',
    webp: 'Imagen WebP',
    avif: 'Imagen AV1 (AVIF)',
    gif: 'Formato de intercambio de gráficos (GIF)',
    tiff: 'Archivo de imagen etiquetada (TIFF)',
    heic: 'Imagen de alta eficiencia (Apple HEIC)',
    bmp: 'Mapa de bits de Windows (BMP)',
    ico: 'Icono de Windows (ICO)',
    psd: 'Documento de Photoshop (PSD)',
    svg: 'Gráficos vectoriales escalables (SVG)',
    eps: 'PostScript encapsulado (EPS)',
    pdf: 'Documento de formato de documento portátil (PDF)',
    docx: 'Documento de Microsoft Word',
    doc: 'Documento de Microsoft Word 97-2003',
    odt: 'Documento de texto OpenDocument',
    rtf: 'Formato de texto enriquecido (RTF)',
    txt: 'Texto sin formato',
    md: 'Documento Markdown',
    html: 'Página web HTML',
    xlsx: 'Libro de cálculo de Microsoft Excel',
    xls: 'Libro de cálculo de Excel 97-2003',
    ods: 'Hoja de cálculo OpenDocument',
    csv: 'Valores separados por comas (CSV)',
    tsv: 'Valores separados por tabulaciones (TSV)',
    pptx: 'Presentación de Microsoft PowerPoint',
    ppt: 'Presentación de PowerPoint 97-2003',
    odp: 'Presentación OpenDocument',
    epub: 'Libro electrónico EPUB',
    mobi: 'Libro electrónico Mobipocket (MOBI)',
    azw3: 'Libro electrónico Kindle (AZW3)',
    mp4: 'Vídeo MPEG-4 (MP4)',
    mkv: 'Vídeo Matroska (MKV)',
    webm: 'Vídeo WebM',
    mov: 'Película QuickTime (MOV)',
    avi: 'Audio Video Interleave (AVI)',
    mp3: 'Audio MP3',
    wav: 'Audio Waveform (WAV)',
    flac: 'Audio sin pérdidas Free Lossless Audio Codec (FLAC)',
    ogg: 'Audio Ogg Vorbis',
    opus: 'Audio Opus',
    m4a: 'Audio MPEG-4 (M4A)',
    zip: 'Archivo comprimido ZIP',
    '7z': 'Archivo comprimido 7-Zip (7Z)',
    tar: 'Archivo TAR',
    'tar.gz': 'Archivo comprimido Gzip (TAR.GZ)',
    rar: 'Archivo comprimido RAR',
    json: 'Notación de objetos JavaScript (JSON)',
    yaml: 'Documento YAML',
    xml: 'Documento XML',
    toml: 'Documento TOML',
    srt: 'Subtítulos SubRip (SRT)',
    vtt: 'Subtítulos WebVTT',
    ass: 'Subtítulos Advanced SubStation Alpha (ASS)',
    ttf: 'Fuente TrueType (TTF)',
    otf: 'Fuente OpenType (OTF)',
    woff: 'Fuente web WOFF',
    woff2: 'Fuente web WOFF2',
  },
  en: {},
};

const STRINGS = {
  es: {
    // Nav
    'nav.convert': 'Convertir',
    'nav.formats': 'Formatos',
    'nav.engines': 'Motores',
    'nav.history': 'Historial',
    'topbar.brandAria': 'Inicio de Recast',
    'topbar.theme': 'Tema',
    'topbar.themeSystem': 'Tema: sistema',
    'topbar.themeLight': 'Tema: claro',
    'topbar.themeDark': 'Tema: oscuro',
    'topbar.lang': 'Idioma',
    'topbar.langSwitch': 'Cambiar a inglés',

    // Accessibility (a11y)
    'a11y.skipLink': 'Saltar al contenido principal',
    'a11y.fileList': 'Lista de archivos para convertir',
    'a11y.progress': 'Progreso de conversión',
    'a11y.navMain': 'Navegación principal',
    'a11y.uploadZone': 'Zona para subir archivos',
    'a11y.chooseFilesInput': 'Seleccionar archivos desde el equipo',
    'a11y.formatsTablist': 'Categorías de formatos',
    'a11y.fileRowActions': 'Acciones para {name}',
    'a11y.closeModal': 'Cerrar ventana emergente',
    'a11y.closeDrawer': 'Cerrar panel lateral',
    'a11y.filesAdded': 'Se añadieron {count} archivos',
    'a11y.conversionDone': 'Conversión completada para {name}',
    'a11y.filesCleared': 'Se han eliminado todos los archivos',
    'a11y.chooseFormatFor': 'Elegir formato de salida para {name} (actual: {target})',
    'a11y.settingsFor': 'Ajustes de conversión para {name}',
    'a11y.cancelDownloadFor': 'Cancelar descarga de {name}',
    'a11y.cancelConversionFor': 'Cancelar conversión de {name}',
    'a11y.retryFor': 'Reintentar conversión de {name}',
    'a11y.openFor': 'Abrir resultado de {name}',
    'a11y.downloadFor': 'Descargar resultado de {name}',
    'a11y.downloadOriginalFor': 'Descargar archivo original de {name}',
    'a11y.detailsFor': 'Ver detalles del registro para {name}',
    'url.inputLabel': 'URL o enlace web',


    // Footer
    'footer.privacy': 'Recast se ejecuta totalmente en este ordenador. Los archivos se eliminan automáticamente tras ',
    'footer.enginesActive': '{on} de {total} motores activos',
    'units.hours': '{count} hora{s}',
    'units.minutes': '{count} minutos',

    // Hero & dropzone
    'hero.eyebrow': 'Privado · se ejecuta en tu propio ordenador',
    'hero.titleLine1': 'Convierte cualquier archivo.',
    'hero.titleLine2': 'Mantén todos los ajustes.',
    'hero.titleFiles': 'Convertir archivos',
    'hero.lede': '{count}+ formatos de entrada entre imágenes, vídeo, audio, documentos, libros electrónicos, hojas de cálculo, datos, archivos comprimidos, fuentes, subtítulos y modelos 3D — con control detallado de códecs, calidad, tamaño, páginas y más.',
    'dropzone.dropAnywhere': 'Arrastra archivos aquí para comenzar',
    'dropzone.chooseFiles': 'Elegir archivos',
    'dropzone.fromUrl': 'Desde URL',
    'dropzone.hint': 'Hasta {size} por archivo · ',
    'dropzone.pasteHint': ' pega un archivo o un enlace',
    'popular.title': 'Populares',
    'drop.veil': 'Suelta para añadir archivos',

    // List toolbar & footer
    'toolbar.convertAllTo': 'Convertir todo a…',
    'toolbar.mergePdf': 'Combinar en PDF',
    'toolbar.addFiles': 'Añadir archivos',
    'toolbar.url': 'URL',
    'toolbar.clear': 'Limpiar',
    'toolbar.clearTitle': 'Eliminar todos los archivos',
    'list.addMore': 'Añadir más archivos — o arrástralos aquí',
    'list.downloadAll': 'Descargar todo',
    'list.convert': 'Convertir',
    'list.convertCount': 'Convertir {count} archivo{s}',
    'list.converting': 'Convirtiendo…',
    'list.summary': '{files} archivo{filesS}{done}{busy}',
    'list.summaryDone': ' · {count} convertido{s}',
    'list.summaryWorking': ' · procesando…',

    // File rows
    'status.waiting': 'Esperando para subir',
    'status.uploading': 'Subiendo {pct}',
    'status.downloading': 'Descargando',
    'status.queued': 'En cola · #{pos}',
    'status.starting': 'Iniciando…',
    'status.converting': 'Convirtiendo',
    'status.stepConversion': 'Conversión en {count} pasos',
    'status.uploadFailed': 'Error al subir',
    'status.failed': 'Fallido',
    'status.cancelled': 'Cancelado',
    'status.retry': 'Reintentar',
    'status.tryAgain': 'Reintentar',
    'status.cancel': 'Cancelar',
    'status.cancelDownload': 'Cancelar descarga',
    'status.cancelConversion': 'Cancelar conversión',
    'status.open': 'Abrir',
    'status.openResult': 'Abrir resultado',
    'status.download': 'Descargar',
    'status.downloadAsFetched': 'Descargar el archivo tal como se obtuvo, sin convertir',
    'status.downloadOriginal': 'Descargar original',
    'status.downloadOriginalFmt': 'Descargar el archivo original {fmt}',
    'status.hideDetails': 'Ocultar detalles',
    'status.details': 'Detalles',
    'status.remove': 'Eliminar',
    'status.removeFile': 'Eliminar {name}',
    'row.mergedFrom': 'Combinado a partir de {count} archivos',
    'row.convertTo': 'Convertir a…',
    'row.to': 'a',
    'row.chooseFormat': 'Elegir formato de salida',
    'row.settings': 'Ajustes',
    'row.chooseFormatFirst': 'Elige primero un formato',
    'describe.passwordProtected': 'protegido con contraseña',
    'describe.frames': '{count} fotogramas',
    'describe.page': '{count} página',
    'describe.pages': '{count} páginas',
    'describe.sheet': '{count} hoja',
    'describe.sheets': '{count} hojas',
    'describe.files': '{count} archivos',
    'describe.subtitleTrack': '{count} pista de subtítulos',
    'describe.subtitleTracks': '{count} pistas de subtítulos',

    // Landing features
    'feat.formatsTitle': 'Todos los formatos importantes',
    'feat.formatsDesc': 'Fotos incl. HEIC y PSD, vídeo, audio, PDF, Word, Markdown, hojas de cálculo, JSON/YAML/XML, archivos comprimidos, fuentes, subtítulos y modelos 3D.',
    'feat.settingsTitle': 'Todos los ajustes al descubierto',
    'feat.settingsDesc': 'Códecs, CRF, tasa de bits, tamaño deseado, resolución, fotogramas por segundo, recorte, rangos de páginas, compresión, cifrado y más.',
    'feat.chainTitle': 'Encadenamiento inteligente',
    'feat.chainDesc': 'Cuando ningún motor puede hacerlo directamente, Recast los encadena — DOCX → HTML → PDF → PNG — y te permite ajustar cada paso.',
    'feat.privacyTitle': 'Privado por diseño',
    'feat.privacyDesc': 'Nada sale de este ordenador. Las subidas y resultados se eliminan automáticamente tras {hours} horas.',
    'feat.batchTitle': 'Lotes, combinación y descarga',
    'feat.batchDesc': 'Convierte docenas de archivos a la vez, combina PDF e imágenes en un solo documento y descárgalo todo en un solo ZIP.',
    'feat.enginesTitle': '{count} motores, una sola interfaz',
    'feat.enginesDesc': 'FFmpeg, libvips, MuPDF, SheetJS, 7-Zip, un navegador headless y más — además de LibreOffice, Pandoc, Calibre, Assimp y yt-dlp si están instalados.',
    'cat.formatsCount': '{count} formatos',

    // URL Import Modal
    'url.title': 'Añadir desde un enlace',
    'url.subtitle': 'Un enlace a un archivo se guarda tal cual. Una página, incluido YouTube, se descarga con yt-dlp en este ordenador.',
    'url.placeholder': 'https://… o un enlace de YouTube',
    'url.saveAs': 'Guardar como',
    'url.saveAsHelp': 'Automático conserva un archivo directo y descarga el mejor vídeo de una página.',
    'url.prefs.auto': 'Automático — archivo o mejor vídeo',
    'url.prefs.best': 'Mejor vídeo',
    'url.prefs.1080': 'Hasta 1080p',
    'url.prefs.720': 'Hasta 720p',
    'url.prefs.480': 'Hasta 480p',
    'url.prefs.audio': 'Solo audio',
    'url.playlist': 'Lista de reproducción',
    'url.playlistHelp': 'Importar cada elemento, hasta 25.',
    'url.subtitles': 'Subtítulos',
    'url.subtitlesHelp': 'Los subtítulos en inglés, cuando el sitio los tenga, se añaden como archivos independientes.',
    'url.ytdlpNote': 'yt-dlp no está instalado, por lo que solo funcionan los enlaces directos a archivos. Instálalo desde Motores para descargar de YouTube y otros sitios.',
    'url.cancel': 'Cancelar',
    'url.import': 'Importar',

    // Merge Modal
    'merge.title': 'Combinar en un solo PDF',
    'merge.subtitle': 'Arrastra para reordenar. Las imágenes se convierten en páginas; los PDF conservan todas sus páginas.',
    'merge.fileName': 'Nombre de archivo',
    'merge.moveUp': 'Subir',
    'merge.moveDown': 'Bajar',
    'merge.leaveOut': 'Excluir',
    'merge.cancel': 'Cancelar',
    'merge.merge': 'Combinar',

    // Settings Drawer
    'settings.title': 'Ajustes',
    'settings.reset': 'Restablecer',
    'settings.applyToAll': 'Aplicar a los {count}',
    'settings.applyToAllTitle': 'Aplicar también a los otros {count} archivos {from} → {to}',
    'settings.done': 'Listo',
    'settings.appliedToast': 'Ajustes aplicados a {count} archivos',

    // Engines Modal
    'engines.title': 'Motores de conversión',
    'engines.subtitle': 'Recast detecta estas herramientas automáticamente. Instala una opcional y vuelve a escanear para desbloquear más formatos.',
    'engines.notInstalled': 'No instalado',
    'engines.unavailable': 'No disponible',
    'engines.active': 'Activo',
    'engines.adds': 'Añade {adds}.',
    'engines.copy': 'Copiar',
    'engines.copyCommand': 'Copiar comando',
    'engines.rescan': 'Reescanear',
    'engines.close': 'Cerrar',
    'engines.rescanned': 'Motores reescaneados',
    'engines.docker': 'Ejecutando en Docker — Todos los motores activos',

    // Picker
    'picker.searchPlaceholder': 'Buscar formatos…',
    'picker.ariaLabel': 'Elegir formato de salida',
    'picker.suggested': 'Sugeridos',
    'picker.hint': 'Escribe para buscar · Enter para elegir · Esc para cerrar',
    'picker.noMatch': 'Ningún formato de salida coincide con «{query}»',
    'picker.commonFormats': 'Formatos a los que se pueden convertir todos los archivos',
    'picker.noCommonFormats': 'Ningún formato se adapta a todos los archivos — los demás se omitirán',

    // Formats page
    'formats.title': 'Formatos admitidos',
    'formats.subtitle': '{inputs} formatos de entrada y {targets} formatos de salida. Haz clic en un formato para ver todo a lo que se puede convertir.',
    'formats.searchPlaceholder': 'Busca un formato, o prueba «heic a jpg»',
    'formats.all': 'Todos · {count}',
    'formats.outputs': '{count} salidas',
    'formats.pickHint': 'Elige una salida para seleccionar archivos y convertir directamente.',
    'formats.noMatch': 'Ningún formato coincide con «{query}».',
    'formats.inputFormats': '{count} formatos de entrada',
    'formats.needsOptional': 'Requiere un motor opcional',
    'formats.formatsCount': '{count} formatos',
    'formats.unlockHint': 'Instala LibreOffice, Pandoc, Calibre o ImageMagick (ver Motores) para desbloquearlos.',
    'formats.checking': 'Comprobando…',
    'formats.supported': 'Admitido:',
    'formats.chooseFiles': 'Elegir archivos',
    'formats.notAvailable': '{from} → {to} no está disponible{suffix}.',
    'formats.withoutOptional': ' sin un motor opcional',

    // Forms
    'form.step': 'Paso {count}',
    'form.noSettings': 'No hay ajustes para este paso.',
    'form.showPassword': 'Mostrar contraseña',
    'form.hidePassword': 'Ocultar contraseña',
    'form.transparent': 'Transparente',

    // Notifications & Toasts
    'toast.copied': 'Copiado al portapapeles',
    'toast.cannotCopy': 'No se pudo copiar',
    'toast.fileTooLarge': '{name} es mayor que {max}',
    'toast.chooseTarget': 'Elige un formato de salida para {target}',
    'toast.alreadyConverted': 'Todo ya está convertido',
    'toast.downloadCancelled': 'Descarga cancelada',
    'toast.downloadNoFile': 'La descarga no generó ningún archivo',
    'toast.addedFiles': 'Se añadieron {count} archivos',
    'toast.cannotConvert': '{count} archivo{s} no se puede{n} convertir a {fmt}',
    'toast.serverLostJob': 'El servidor ya no reconoce esta tarea (¿se ha reiniciado?)',
    'toast.serverLostDownload': 'El servidor ya no reconoce esta descarga (¿se ha reiniciado?)',
    'toast.titleConverted': '✓ Convertido — Recast',
    'toast.titleDefault': 'Recast — Convierte cualquier archivo',
    'toast.serverUnreachable': 'No se puede conectar con el servidor',
    'toast.startWithNpm': '{message}. Inícialo con “npm start”.',

    // History
    'history.title': 'Historial de conversiones',
    'history.empty': 'No hay conversiones recientes.',
    'history.emptyHint': 'Los archivos que conviertas aparecerán aquí para que puedas previsualizarlos o descargarlos en cualquier momento.',
    'history.clear': 'Vaciar historial',
    'history.clearConfirm': '¿Seguro que deseas vaciar el historial?',
    'history.preview': 'Vista previa',
    'history.download': 'Descargar',
    'history.merged': 'Combinación PDF',

    // Previews
    'preview.title': 'Vista previa',
    'preview.close': 'Cerrar vista previa',
    'preview.download': 'Descargar archivo',
    'preview.openNewTab': 'Abrir en pestaña nueva',
    'preview.unsupported': 'Vista previa no disponible para este formato',
    'preview.unsupportedHint': 'Este formato no se puede reproducir directamente dentro del navegador, pero puedes descargarlo para abrirlo en tu dispositivo.',
    'preview.loading': 'Cargando archivo…',
    'preview.copyCode': 'Copiar contenido',
    'preview.copiedCode': 'Contenido copiado',
  },

  en: {
    // Nav
    'nav.convert': 'Convert',
    'nav.formats': 'Formats',
    'nav.engines': 'Engines',
    'nav.history': 'History',
    'topbar.brandAria': 'Recast home',
    'topbar.theme': 'Theme',
    'topbar.themeSystem': 'Theme: system',
    'topbar.themeLight': 'Theme: light',
    'topbar.themeDark': 'Theme: dark',
    'topbar.lang': 'Language',
    'topbar.langSwitch': 'Switch to Spanish',

    // Accessibility (a11y)
    'a11y.skipLink': 'Skip to main content',
    'a11y.fileList': 'List of files to convert',
    'a11y.progress': 'Conversion progress',
    'a11y.navMain': 'Main navigation',
    'a11y.uploadZone': 'File upload area',
    'a11y.chooseFilesInput': 'Choose files from device',
    'a11y.formatsTablist': 'Format categories',
    'a11y.fileRowActions': 'Actions for {name}',
    'a11y.closeModal': 'Close dialog',
    'a11y.closeDrawer': 'Close settings drawer',
    'a11y.filesAdded': '{count} files added',
    'a11y.conversionDone': 'Conversion completed for {name}',
    'a11y.filesCleared': 'All files cleared',
    'a11y.chooseFormatFor': 'Choose output format for {name} (current: {target})',
    'a11y.settingsFor': 'Conversion settings for {name}',
    'a11y.cancelDownloadFor': 'Cancel download of {name}',
    'a11y.cancelConversionFor': 'Cancel conversion of {name}',
    'a11y.retryFor': 'Retry conversion for {name}',
    'a11y.openFor': 'Open result for {name}',
    'a11y.downloadFor': 'Download result for {name}',
    'a11y.downloadOriginalFor': 'Download original file for {name}',
    'a11y.detailsFor': 'View log details for {name}',
    'url.inputLabel': 'URL or web link',


    // Footer
    'footer.privacy': 'Recast runs entirely on this computer. Files are deleted automatically after ',
    'footer.enginesActive': '{on} of {total} engines active',
    'units.hours': '{count} hour{s}',
    'units.minutes': '{count} minutes',

    // Hero & dropzone
    'hero.eyebrow': 'Private · runs on your own machine',
    'hero.titleLine1': 'Convert any file.',
    'hero.titleLine2': 'Keep every setting.',
    'hero.titleFiles': 'Convert files',
    'hero.lede': '{count}+ input formats across images, video, audio, documents, ebooks, spreadsheets, data, archives, fonts, subtitles and 3D models — with fine control over codecs, quality, size, pages and more.',
    'dropzone.dropAnywhere': 'Drop files anywhere to start',
    'dropzone.chooseFiles': 'Choose files',
    'dropzone.fromUrl': 'From URL',
    'dropzone.hint': 'Up to {size} per file · ',
    'dropzone.pasteHint': ' pastes a file or a link',
    'popular.title': 'Popular',
    'drop.veil': 'Drop to add files',

    // List toolbar & footer
    'toolbar.convertAllTo': 'Convert all to…',
    'toolbar.mergePdf': 'Merge into PDF',
    'toolbar.addFiles': 'Add files',
    'toolbar.url': 'URL',
    'toolbar.clear': 'Clear',
    'toolbar.clearTitle': 'Remove all files',
    'list.addMore': 'Add more files — or drop them anywhere',
    'list.downloadAll': 'Download all',
    'list.convert': 'Convert',
    'list.convertCount': 'Convert {count} file{s}',
    'list.converting': 'Converting…',
    'list.summary': '{files} file{filesS}{done}{busy}',
    'list.summaryDone': ' · {count} converted',
    'list.summaryWorking': ' · working…',

    // File rows
    'status.waiting': 'Waiting to upload',
    'status.uploading': 'Uploading {pct}',
    'status.downloading': 'Downloading',
    'status.queued': 'Queued · #{pos}',
    'status.starting': 'Starting…',
    'status.converting': 'Converting',
    'status.stepConversion': '{count}-step conversion',
    'status.uploadFailed': 'Upload failed',
    'status.failed': 'Failed',
    'status.cancelled': 'Cancelled',
    'status.retry': 'Retry',
    'status.tryAgain': 'Try again',
    'status.cancel': 'Cancel',
    'status.cancelDownload': 'Cancel download',
    'status.cancelConversion': 'Cancel conversion',
    'status.open': 'Open',
    'status.openResult': 'Open result',
    'status.download': 'Download',
    'status.downloadAsFetched': 'Download the file as fetched, without converting',
    'status.downloadOriginal': 'Download original',
    'status.downloadOriginalFmt': 'Download the original {fmt}',
    'status.hideDetails': 'Hide details',
    'status.details': 'Details',
    'status.remove': 'Remove',
    'status.removeFile': 'Remove {name}',
    'row.mergedFrom': 'Merged from {count} files',
    'row.convertTo': 'Convert to…',
    'row.to': 'to',
    'row.chooseFormat': 'Choose output format',
    'row.settings': 'Settings',
    'row.chooseFormatFirst': 'Choose a format first',
    'describe.passwordProtected': 'password-protected',
    'describe.frames': '{count} frames',
    'describe.page': '{count} page',
    'describe.pages': '{count} pages',
    'describe.sheet': '{count} sheet',
    'describe.sheets': '{count} sheets',
    'describe.files': '{count} files',
    'describe.subtitleTrack': '{count} subtitle track',
    'describe.subtitleTracks': '{count} subtitle tracks',

    // Landing features
    'feat.formatsTitle': 'Every format that matters',
    'feat.formatsDesc': 'Photos incl. HEIC and PSD, video, audio, PDF, Word, Markdown, spreadsheets, JSON/YAML/XML, archives, fonts, subtitles and 3D models.',
    'feat.settingsTitle': 'Every setting exposed',
    'feat.settingsDesc': 'Codecs, CRF, bitrate, target size, resolution, frame rate, trimming, page ranges, compression, encryption, subsetting and more.',
    'feat.chainTitle': 'Smart chaining',
    'feat.chainDesc': 'When no single engine can do it, Recast chains them — DOCX → HTML → PDF → PNG — and lets you tune each step.',
    'feat.privacyTitle': 'Private by design',
    'feat.privacyDesc': 'Nothing leaves this computer. Uploads and results are deleted automatically after {hours} hours.',
    'feat.batchTitle': 'Batch, merge & download',
    'feat.batchDesc': 'Convert dozens of files at once, merge PDFs and images into one document, grab everything as a single ZIP.',
    'feat.enginesTitle': '{count} engines, one interface',
    'feat.enginesDesc': 'FFmpeg, libvips, MuPDF, SheetJS, 7-Zip, a headless browser and more — plus LibreOffice, Pandoc, Calibre, Assimp and yt-dlp when installed.',
    'cat.formatsCount': '{count} formats',

    // URL Import Modal
    'url.title': 'Add from a link',
    'url.subtitle': 'A file link is saved as-is. A page, including YouTube, is downloaded with yt-dlp on this computer.',
    'url.placeholder': 'https://… or a YouTube link',
    'url.saveAs': 'Save as',
    'url.saveAsHelp': 'Auto keeps a direct file and downloads the best video from a page.',
    'url.prefs.auto': 'Auto — file, or best video',
    'url.prefs.best': 'Best video',
    'url.prefs.1080': 'Up to 1080p',
    'url.prefs.720': 'Up to 720p',
    'url.prefs.480': 'Up to 480p',
    'url.prefs.audio': 'Audio only',
    'url.playlist': 'Playlist',
    'url.playlistHelp': 'Import every item, up to 25.',
    'url.subtitles': 'Subtitles',
    'url.subtitlesHelp': 'English subtitles, when the site has them, are added as separate files.',
    'url.ytdlpNote': 'yt-dlp is not installed, so only a direct file link works. Install it from Engines to download YouTube and other sites.',
    'url.cancel': 'Cancel',
    'url.import': 'Import',

    // Merge Modal
    'merge.title': 'Merge into one PDF',
    'merge.subtitle': 'Drag to reorder. Images become pages; PDFs keep all their pages.',
    'merge.fileName': 'File name',
    'merge.moveUp': 'Move up',
    'merge.moveDown': 'Move down',
    'merge.leaveOut': 'Leave out',
    'merge.cancel': 'Cancel',
    'merge.merge': 'Merge',

    // Settings Drawer
    'settings.title': 'Settings',
    'settings.reset': 'Reset',
    'settings.applyToAll': 'Apply to all {count}',
    'settings.applyToAllTitle': 'Also apply to the other {count} {from} → {to} files',
    'settings.done': 'Done',
    'settings.appliedToast': 'Settings applied to {count} files',

    // Engines Modal
    'engines.title': 'Conversion engines',
    'engines.subtitle': 'Recast detects these tools automatically. Install an optional one and rescan to unlock more formats.',
    'engines.notInstalled': 'Not installed',
    'engines.unavailable': 'Unavailable',
    'engines.active': 'Active',
    'engines.adds': 'Adds {adds}.',
    'engines.copy': 'Copy',
    'engines.copyCommand': 'Copy command',
    'engines.rescan': 'Rescan',
    'engines.close': 'Close',
    'engines.rescanned': 'Engines rescanned',
    'engines.docker': 'Running in Docker — All engines active',

    // Picker
    'picker.searchPlaceholder': 'Search formats…',
    'picker.ariaLabel': 'Choose output format',
    'picker.suggested': 'Suggested',
    'picker.hint': 'Type to search · Enter to pick · Esc to close',
    'picker.noMatch': 'No output format matches “{query}”',
    'picker.commonFormats': 'Formats every file can be converted to',
    'picker.noCommonFormats': 'No format fits every file — others will be skipped',

    // Formats page
    'formats.title': 'Supported formats',
    'formats.subtitle': '{inputs} input formats and {targets} output formats. Click a format to see everything it converts to.',
    'formats.searchPlaceholder': 'Search a format, or try “heic to jpg”',
    'formats.all': 'All · {count}',
    'formats.outputs': '{count} outputs',
    'formats.pickHint': 'Pick an output to choose files and convert straight away.',
    'formats.noMatch': 'No format matches “{query}”.',
    'formats.inputFormats': '{count} input formats',
    'formats.needsOptional': 'Needs an optional engine',
    'formats.formatsCount': '{count} formats',
    'formats.unlockHint': 'Install LibreOffice, Pandoc, Calibre or ImageMagick (see Engines) to unlock these.',
    'formats.checking': 'Checking…',
    'formats.supported': 'Supported:',
    'formats.chooseFiles': 'Choose files',
    'formats.notAvailable': '{from} → {to} is not available{suffix}.',
    'formats.withoutOptional': ' without an optional engine',

    // Forms
    'form.step': 'Step {count}',
    'form.noSettings': 'No settings for this step.',
    'form.showPassword': 'Show password',
    'form.hidePassword': 'Hide password',
    'form.transparent': 'Transparent',

    // Notifications & Toasts
    'toast.copied': 'Copied to clipboard',
    'toast.cannotCopy': 'Could not copy',
    'toast.fileTooLarge': '{name} is larger than {max}',
    'toast.chooseTarget': 'Choose an output format for {target}',
    'toast.alreadyConverted': 'Everything is already converted',
    'toast.downloadCancelled': 'Download cancelled',
    'toast.downloadNoFile': 'The download produced no file',
    'toast.addedFiles': 'Added {count} files',
    'toast.cannotConvert': '{count} file{s} cannot be converted to {fmt}',
    'toast.serverLostJob': 'The server no longer knows this job (was it restarted?)',
    'toast.serverLostDownload': 'The server no longer knows this download (was it restarted?)',
    'toast.titleConverted': '✓ Converted — Recast',
    'toast.titleDefault': 'Recast — Convert any file',
    'toast.serverUnreachable': 'Cannot reach the server',
    'toast.startWithNpm': '{message}. Start it with “npm start”.',

    // History
    'history.title': 'Conversion History',
    'history.empty': 'No recent conversions.',
    'history.emptyHint': 'Converted files will appear here so you can preview or download them anytime.',
    'history.clear': 'Clear history',
    'history.clearConfirm': 'Are you sure you want to clear the conversion history?',
    'history.preview': 'Preview',
    'history.download': 'Download',
    'history.merged': 'PDF Merge',

    // Previews
    'preview.title': 'Preview',
    'preview.close': 'Close preview',
    'preview.download': 'Download file',
    'preview.openNewTab': 'Open in new tab',
    'preview.unsupported': 'Preview not available for this format',
    'preview.unsupportedHint': 'This format cannot be rendered directly in the browser, but you can download it to view on your device.',
    'preview.loading': 'Loading file…',
    'preview.copyCode': 'Copy content',
    'preview.copiedCode': 'Content copied',
  },
};

// Common schema terms (groups, fields, options) translated to Spanish
const SCHEMA_ES = {
  // Groups
  'Look & feel': 'Aspecto y estilo',
  'Page': 'Página',
  'Print options': 'Opciones de impresión',
  'Rendering': 'Renderizado',
  'Screenshot': 'Captura de pantalla',
  'Book': 'Libro',
  'Look': 'Apariencia',
  'Font': 'Fuente',
  'Size': 'Tamaño',
  'Transform': 'Transformar',
  'Adjustments': 'Ajustes',
  'Metadata': 'Metadatos',
  'Image encoding': 'Codificación de imagen',
  'Document info': 'Información del documento',
  'Word document': 'Documento de Word',
  'HTML output': 'Salida HTML',
  'Markdown output': 'Salida Markdown',
  'Text output': 'Salida de texto',
  'Word output': 'Salida de Word',
  'Trim & timing': 'Recorte y tiempos',
  'Rotate & crop': 'Rotar y recortar',
  'Volume': 'Volumen',
  'Tags': 'Etiquetas',
  'Visual': 'Visual',
  'Audio': 'Audio',
  'Video': 'Vídeo',
  'Animation': 'Animación',
  'Frames': 'Fotogramas',
  'Advanced video': 'Vídeo avanzado',
  'Filters': 'Filtros',
  'Subtitles': 'Subtítulos',
  'PDF export': 'Exportación PDF',
  'CSV export': 'Exportación CSV',
  'Image export': 'Exportación de imagen',
  'Page layout': 'Diseño de página',
  'Pages': 'Páginas',
  'Compression': 'Compresión',
  'Security': 'Seguridad',
  'Vectorise': 'Vectorizar',

  // Fields & labels
  'Quality': 'Calidad',
  'Bitrate': 'Tasa de bits',
  'Resolution': 'Resolución',
  'Width': 'Ancho',
  'Height': 'Alto',
  'Scale': 'Escala',
  'Orientation': 'Orientación',
  'Portrait': 'Vertical',
  'Landscape': 'Horizontal',
  'Paper size': 'Tamaño de papel',
  'Margins': 'Márgenes',
  'Top': 'Superior',
  'Right': 'Derecha',
  'Bottom': 'Inferior',
  'Left': 'Izquierda',
  'Password': 'Contraseña',
  'Archive password': 'Contraseña del archivo',
  'Encryption': 'Cifrado',
  'Encrypt file names': 'Cifrar nombres de archivo',
  'Solid archive': 'Archivo sólido',
  'Method': 'Método',
  'Color': 'Color',
  'Background': 'Fondo',
  'Transparent': 'Transparente',
  'Transparent background': 'Fondo transparente',
  'Crop': 'Recortar',
  'Rotate': 'Rotar',
  'Flip': 'Voltear',
  'Brightness': 'Brillo',
  'Contrast': 'Contraste',
  'Saturation': 'Saturación',
  'Grayscale': 'Escala de grises',
  'Codec': 'Códec',
  'Frame rate': 'Fotogramas por segundo',
  'Speed': 'Velocidad',
  'Start at': 'Iniciar en',
  'End at': 'Finalizar en',
  'Fade in': 'Aparición gradual',
  'Fade out': 'Desvanecimiento',
  'Normalize volume': 'Normalizar volumen',
  'Title': 'Título',
  'Author': 'Autor',
  'Delimiter': 'Delimitador',
  'Header': 'Encabezado',
  'First row is a header': 'La primera fila es encabezado',
  'Detect numbers & booleans': 'Detectar números y booleanos',
  'Run JavaScript': 'Ejecutar JavaScript',
  'Print backgrounds': 'Imprimir fondos',
  'Header & footer': 'Encabezado y pie de página',
  'Page numbers': 'Números de página',
  'Title, date & page numbers': 'Título, fecha y números de página',
  'Fit to content (one page)': 'Ajustar al contenido (una página)',
  'Custom size…': 'Tamaño personalizado…',
  'Fastest': 'Más rápido',
  'Normal': 'Normal',
  'Maximum': 'Máximo',
  'Deflate (most compatible)': 'Deflate (más compatible)',
  'Auto': 'Automático',
  'None': 'Ninguno',
  'Small': 'Pequeño',
  'Large': 'Grande',
  'Custom…': 'Personalizado…',
  'Detect automatically': 'Detectar automáticamente',
  'Comma ,': 'Coma ,',
  'Semicolon ;': 'Punto y coma ;',
  'Tab': 'Tabulación',
  'Pipe |': 'Barra vertical |',
  'Keep attributes': 'Conservar atributos',
  'Attribute prefix': 'Prefijo de atributo',
  'Remove namespace prefixes': 'Eliminar prefijos de espacio de nombres',
  'Bookmarks from headings': 'Marcadores desde encabezados',
  'Use page size defined by the document': 'Usar tamaño de página del documento',
  'CSS media': 'Medio CSS',
  'Print': 'Impresión',
  'Screen': 'Pantalla',
  'Extra wait': 'Espera adicional',
  'Viewport width': 'Ancho del visor',
  'Viewport height': 'Alto del visor',
  'Capture full page': 'Capturar página completa',
  'Pixel density': 'Densidad de píxeles',
  'Emulate dark mode': 'Emular modo oscuro',
  'Kindle format': 'Formato Kindle',
  'Old + KF8 (most compatible)': 'Antiguo + KF8 (más compatible)',
  'Old MOBI only': 'Solo MOBI antiguo',
  'KF8 only': 'Solo KF8',
  'EPUB version': 'Versión de EPUB',
  'Do not generate a default cover': 'No generar portada predeterminada',
  'Formatting': 'Formato',
  'Plain': 'Texto plano',
  'Layout': 'Disposición',
  'Paragraphs': 'Párrafos',
  'Preformatted (keep spacing)': 'Preformateado (mantener espaciado)',
  'LibreOffice exports the first page or slide. For every page, convert to PDF first, then PDF to images.': 'LibreOffice exporta la primera página o diapositiva. Para todas las páginas, convierte primero a PDF y luego el PDF a imágenes.',
};

const ERROR_PATTERNS_ES = [
  [/^The server no longer knows this job/i, 'El servidor ya no reconoce esta tarea (¿se ha reiniciado?)'],
  [/^The server no longer knows this download/i, 'El servidor ya no reconoce esta descarga (¿se ha reiniciado?)'],
  [/^No file received/i, 'No se recibió ningún archivo'],
  [/^Download not found/i, 'Descarga no encontrada'],
  [/^Upload not found/i, 'Subida no encontrada'],
  [/^Download cancelled/i, 'Descarga cancelada'],
  [/^The download produced no file/i, 'La descarga no generó ningún archivo'],
  [/^This file has no audio track/i, 'Este archivo no tiene pista de audio'],
  [/^This file has no video stream/i, 'Este archivo no tiene flujo de vídeo'],
  [/^This document is password-protected.*enter its password/i, 'Este documento está protegido por contraseña — introdúcela en los ajustes'],
  [/^The password is not correct/i, 'La contraseña no es correcta'],
  [/^The archive is damaged or not in a supported format/i, 'El archivo comprimido está dañado o no tiene un formato compatible'],
  [/^The archive is empty/i, 'El archivo comprimido está vacío'],
  [/^The page range is invalid/i, 'El rango de páginas no es válido para este documento'],
  [/^The crop area lies outside/i, 'El área de recorte queda fuera de la imagen'],
  [/^This workbook is password-protected/i, 'Este libro de cálculo está protegido por contraseña'],
  [/^The workbook has no sheets/i, 'El libro de cálculo no tiene hojas'],
  [/^This video has no subtitle tracks/i, 'Este vídeo no tiene pistas de subtítulos'],
  [/^Tracing failed/i, 'Error al vectorizar'],
  [/is not available/i, 'no está disponible'],
  [/is larger than/i, 'es más grande que'],
];

export function t(key, params = {}) {
  const dict = STRINGS[current] || STRINGS.en;
  let text = dict[key] ?? STRINGS.en[key] ?? key;
  if (typeof text !== 'string') return text;

  // Simple interpolation
  for (const [k, v] of Object.entries(params)) {
    text = text.replaceAll(`{${k}}`, String(v));
  }
  // Pluralization helpers if {count} or {files} is present
  if ('count' in params) {
    const n = Number(params.count);
    text = text.replaceAll('{s}', current === 'es' ? (n === 1 ? '' : 's') : (n === 1 ? '' : 's'));
    text = text.replaceAll('{n}', current === 'es' ? (n === 1 ? '' : 'n') : '');
  }
  if ('files' in params) {
    const n = Number(params.files);
    text = text.replaceAll('{filesS}', current === 'es' ? (n === 1 ? '' : 's') : (n === 1 ? '' : 's'));
  }
  return text;
}

export function tCategory(catId) {
  return CATEGORIES[current]?.[catId] || CATEGORIES.en[catId] || catId;
}

export function tFormatName(fmt, fallback = '') {
  if (current === 'es' && FORMAT_NAMES.es[fmt]) {
    return FORMAT_NAMES.es[fmt];
  }
  return fallback || fmt?.toUpperCase() || '';
}

export function tSchema(text) {
  if (current !== 'es' || !text) return text;
  if (SCHEMA_ES[text]) return SCHEMA_ES[text];
  // Dynamic group titles like "ZIP archive" -> "Archivo ZIP", "PNG output" -> "Salida PNG"
  const mOut = text.match(/^([A-Z0-9.\-]+)\s+output$/i);
  if (mOut) return `Salida ${mOut[1].toUpperCase()}`;
  const mIn = text.match(/^([A-Z0-9.\-]+)\s+input$/i);
  if (mIn) return `Entrada ${mIn[1].toUpperCase()}`;
  const mArc = text.match(/^([A-Z0-9.\-]+)\s+archive$/i);
  if (mArc) return `Archivo ${mArc[1].toUpperCase()}`;
  const mAudio = text.match(/^([A-Z0-9.\-]+)\s+audio$/i);
  if (mAudio) return `Audio ${mAudio[1].toUpperCase()}`;
  return text;
}

export function tError(msg) {
  if (current !== 'es' || !msg) return msg;
  const str = String(msg);
  for (const [regex, translation] of ERROR_PATTERNS_ES) {
    if (regex.test(str)) return translation;
  }
  return str;
}
