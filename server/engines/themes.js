// Stylesheets for generated HTML documents (Markdown, text and Word → HTML/PDF).

const base = (font, size, width) => `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0 auto;padding:48px 28px;max-width:${width}px;font:${size}px/1.65 ${font};color:#1c1c1e;background:#fff;text-rendering:optimizeLegibility;-webkit-font-smoothing:antialiased}
h1,h2,h3,h4,h5,h6{line-height:1.25;margin:1.8em 0 .6em;font-weight:650;letter-spacing:-.01em;color:#111}
h1{font-size:2.1em;margin-top:.4em}h2{font-size:1.55em;padding-bottom:.25em;border-bottom:1px solid #e6e6e6}h3{font-size:1.25em}h4{font-size:1.05em}h5,h6{font-size:.95em;color:#444}
p,ul,ol,dl,blockquote,pre,table,figure{margin:0 0 1em}
a{color:#2456c9;text-decoration:none;border-bottom:1px solid rgba(36,86,201,.3)}
ul,ol{padding-left:1.6em}li+li{margin-top:.25em}li>ul,li>ol{margin:.25em 0 0}
blockquote{margin-left:0;padding:.1em 1.1em;border-left:3px solid #d8d8d8;color:#555}
code,kbd,samp{font:.88em/1.5 ui-monospace,SFMono-Regular,"Cascadia Mono",Menlo,Consolas,monospace;background:#f3f3f3;border-radius:4px;padding:.12em .35em}
pre{background:#f6f6f6;border:1px solid #ececec;border-radius:8px;padding:14px 16px;overflow:auto;line-height:1.5}
pre code{background:none;padding:0;font-size:.86em}
table{border-collapse:collapse;width:100%;font-size:.94em;display:block;overflow-x:auto}
th,td{border:1px solid #e2e2e2;padding:.5em .75em;text-align:left;vertical-align:top}
th{background:#fafafa;font-weight:600}
tr:nth-child(2n) td{background:#fcfcfc}
img{max-width:100%;height:auto}
hr{border:0;border-top:1px solid #e6e6e6;margin:2em 0}
input[type=checkbox]{margin-right:.45em}
.toc{background:#fafafa;border:1px solid #eee;border-radius:8px;padding:14px 20px;margin:0 0 2em}
.toc strong{display:block;font-size:.8em;text-transform:uppercase;letter-spacing:.06em;color:#777;margin-bottom:.4em}
.toc ul{list-style:none;padding-left:0;margin:0}.toc ul ul{padding-left:1.1em}
.toc a{border:0;color:#333}
@media print{body{padding:0;max-width:none}a{color:inherit;border:0}pre,blockquote,table,img,figure{break-inside:avoid}h1,h2,h3{break-after:avoid}}
`;

const FONTS = {
  modern: '-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,"Helvetica Neue",Arial,sans-serif',
  serif: 'Charter,"Bitstream Charter","Sitka Text",Cambria,Georgia,"Times New Roman",serif',
  mono: 'ui-monospace,SFMono-Regular,"Cascadia Mono",Menlo,Consolas,monospace',
};

export const THEMES = [
  { value: 'modern', label: 'Modern (sans-serif)' },
  { value: 'serif', label: 'Book (serif)' },
  { value: 'mono', label: 'Technical (monospace)' },
  { value: 'none', label: 'No styling' },
];

export function themeCss(theme = 'modern', { fontSize = 16, maxWidth = 780 } = {}) {
  if (theme === 'none') return '';
  const extra = theme === 'serif' ? 'h1,h2,h3,h4{font-family:' + FONTS.serif + ';font-weight:600}h2{border-bottom:0}' : theme === 'mono' ? 'h2{border-bottom:1px dashed #ccc}' : '';
  return base(FONTS[theme] || FONTS.modern, fontSize, maxWidth) + extra;
}

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function htmlDocument(body, { title = 'Document', theme = 'modern', fontSize, maxWidth, lang = 'en' } = {}) {
  const css = themeCss(theme, { fontSize, maxWidth });
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${css ? `<style>${css}</style>` : ''}
</head>
<body>
${body}
</body>
</html>
`;
}

export { escapeHtml };
