#!/bin/sh
set -e

# Sites like YouTube change often; a stale yt-dlp is the usual reason downloads break.
if [ "${YTDLP_AUTO_UPDATE:-1}" = "1" ]; then
  echo "Updating yt-dlp…"
  timeout 120 /opt/yt-dlp/bin/pip install -q -U --no-cache-dir --disable-pip-version-check "yt-dlp[default,curl-cffi]" \
    || echo "yt-dlp update skipped (offline?)"
fi

exec "$@"
