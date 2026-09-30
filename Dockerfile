# Recast with every engine: FFmpeg (with ffprobe), libvips, MuPDF, 7-Zip (with RAR), Chromium,
# LibreOffice, Pandoc, Calibre, ImageMagick 7 and yt-dlp.
FROM node:24-trixie-slim

ENV DEBIAN_FRONTEND=noninteractive
# contrib/non-free for the RAR codec of 7-Zip.
RUN sed -i 's/^Components: main$/Components: main contrib non-free/' /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      tini ca-certificates \
      ffmpeg \
      chromium \
      libreoffice-writer libreoffice-calc libreoffice-impress libreoffice-draw \
      pandoc calibre imagemagick 7zip 7zip-rar assimp-utils \
      python3 python3-venv \
      fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji fonts-liberation2 fonts-dejavu-core \
      fonts-crosextra-carlito fonts-crosextra-caladea \
 && rm -rf /var/lib/apt/lists/*

# yt-dlp in its own venv, owned by the app user so it can update itself on start.
RUN python3 -m venv /opt/yt-dlp \
 && /opt/yt-dlp/bin/pip install --no-cache-dir --disable-pip-version-check "yt-dlp[default,curl-cffi]" \
 && ln -s /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp \
 && chown -R node:node /opt/yt-dlp

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY server ./server
COPY public ./public
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh && mkdir -p /app/data && chown -R node:node /app/data

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/app/data \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe \
    BROWSER_PATH=/usr/bin/chromium \
    BROWSER_NO_SANDBOX=1 \
    QT_QPA_PLATFORM=offscreen \
    YTDLP_AUTO_UPDATE=1

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/meta').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["tini", "--", "entrypoint.sh"]
CMD ["node", "--no-experimental-webstorage", "server/index.js"]
