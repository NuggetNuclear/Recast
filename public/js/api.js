// Thin client for the Recast HTTP API.

async function json(res) {
  let body = null;
  try { body = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error(body?.error || `Request failed (${res.status})`);
    err.details = body?.details;
    err.status = res.status;
    throw err;
  }
  return body;
}

const post = (url, data) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data ?? {}) }).then(json);

export const api = {
  meta: () => fetch('/api/meta').then(json),
  rescan: () => post('/api/engines/rescan'),
  route: ({ upload, from, to }) => fetch(`/api/route?${new URLSearchParams(upload ? { upload, to } : { from, to })}`).then(json),
  mergeSchema: () => fetch('/api/merge/schema').then(json),
  startImport: (url, mode, quality) => post('/api/imports', { url, mode, quality }),
  importStatus: (id) => fetch(`/api/imports/${id}`).then(json),
  cancelImport: (id) => fetch(`/api/imports/${id}`, { method: 'DELETE' }).catch(() => {}),
  deleteUpload: (id) => fetch(`/api/uploads/${id}`, { method: 'DELETE' }).catch(() => {}),
  createJob: (uploadId, to, options) => post('/api/jobs', { uploadId, to, options }),
  merge: (uploadIds, options, name) => post('/api/merge', { uploadIds, options, name }),
  jobs: (ids) => fetch(`/api/jobs?ids=${ids.join(',')}`).then(json),
  cancelJob: (id) => fetch(`/api/jobs/${id}/cancel`, { method: 'POST' }).catch(() => {}),
  deleteJob: (id) => fetch(`/api/jobs/${id}`, { method: 'DELETE' }).catch(() => {}),
  downloadUrl: (jobId) => `/api/jobs/${jobId}/download`,
  fileUrl: (jobId, i, inline) => `/api/jobs/${jobId}/files/${i}${inline ? '?inline=1' : ''}`,
  downloadAllUrl: (ids) => `/api/download?jobs=${ids.join(',')}`,

  /** Upload with progress. Returns { promise, abort }. */
  upload(file, onProgress) {
    const xhr = new XMLHttpRequest();
    const promise = new Promise((resolve, reject) => {
      xhr.open('POST', '/api/uploads');
      xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
      xhr.onload = () => {
        let body = null;
        try { body = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new Error(body?.error || `Upload failed (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error('Network error while uploading'));
      xhr.onabort = () => reject(Object.assign(new Error('Upload cancelled'), { aborted: true }));
      const fd = new FormData();
      fd.append('file', file, file.name);
      xhr.send(fd);
    });
    return { promise, abort: () => xhr.abort() };
  },
};
