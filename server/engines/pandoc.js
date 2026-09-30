// Markup & document formats via Pandoc (optional — enabled when pandoc is installed).
import path from 'node:path';
import { f, group } from '../schema.js';
import { tools, versionOf } from '../tools.js';
import { run, UserError, opt, clamp } from '../util.js';

const READERS = { md: 'markdown', html: 'html', xhtml: 'html', docx: 'docx', odt: 'odt', epub: 'epub', rst: 'rst', tex: 'latex', org: 'org', textile: 'textile', wiki: 'mediawiki', txt: 'markdown', ipynb: 'ipynb', rtf: 'rtf', fb2: 'fb2', opml: 'opml', typ: 'typst', man: 'man' };
const WRITERS = { md: 'markdown', html: 'html5', docx: 'docx', odt: 'odt', rtf: 'rtf', epub: 'epub3', tex: 'latex', rst: 'rst', org: 'org', textile: 'textile', wiki: 'mediawiki', adoc: 'asciidoc', txt: 'plain', ipynb: 'ipynb', pptx: 'pptx', fb2: 'fb2', opml: 'opml', typ: 'typst', man: 'man' };
const BINARY_OUT = ['docx', 'odt', 'epub', 'pptx'];
let pandocVersion = '0';
const versionAtLeast = (v, major, minor) => {
  const [a = 0, b = 0] = String(v).split('.').map(Number);
  return a > major || (a === major && b >= minor);
};

function schema({ from, to }) {
  const fields = [
    to !== 'md' && !BINARY_OUT.includes(to) && to !== 'txt' ? f.toggle('standalone', 'Complete document (with header)', true) : null,
    ['html', 'docx', 'odt', 'epub', 'md', 'tex', 'rst', 'typ', 'pptx'].includes(to) ? f.toggle('toc', 'Table of contents') : null,
    f.select('tocDepth', 'Contents depth', ['1', '2', '3', '4', '5'], '3', { showIf: { toc: [true] } }),
    ['html', 'docx', 'odt', 'epub', 'tex', 'typ', 'pptx'].includes(to) ? f.toggle('numberSections', 'Number sections') : null,
    f.range('shiftHeadings', 'Shift heading levels', -3, 3, 1, 0),
    !BINARY_OUT.includes(to) ? f.select('wrap', 'Line wrapping', [{ value: 'auto', label: 'Wrap' }, { value: 'none', label: 'No wrapping' }, { value: 'preserve', label: 'Preserve' }], 'none') : null,
    !BINARY_OUT.includes(to) ? f.number('columns', 'Wrap at column', { min: 20, max: 400, default: 80, showIf: { wrap: ['auto'] } }) : null,
    to === 'md' ? f.select('mdFlavor', 'Markdown flavour', [{ value: 'gfm', label: 'GitHub (GFM)' }, { value: 'markdown', label: 'Pandoc Markdown' }, { value: 'commonmark', label: 'CommonMark' }, { value: 'markdown_strict', label: 'Original Markdown' }], 'gfm') : null,
    to === 'html' ? f.toggle('embed', 'Embed images & CSS (single file)', true) : null,
    to === 'html' || to === 'epub' ? f.select('math', 'Math rendering', [{ value: 'mathml', label: 'MathML' }, { value: 'mathjax', label: 'MathJax' }, { value: 'katex', label: 'KaTeX' }, { value: 'plain', label: 'Plain text' }], 'mathml') : null,
    f.text('title', 'Title'),
    f.text('author', 'Author'),
  ];
  return [group('pandoc', `${to.toUpperCase()} output`, fields)];
}

async function convert({ input, from, to, o, outDir, baseName, signal }) {
  if (!tools.pandoc) throw new UserError('Pandoc is not installed');
  const out = path.join(outDir, `${baseName}.${to}`);
  const writer = to === 'md' ? o.mdFlavor || 'gfm' : WRITERS[to];
  const args = ['-f', READERS[from], '-t', writer, '-o', out];
  if (opt.bool(o.standalone, true) && !BINARY_OUT.includes(to)) args.push('--standalone');
  if (opt.bool(o.toc)) args.push('--toc', `--toc-depth=${clamp(opt.num(o.tocDepth, 3), 1, 6)}`);
  if (opt.bool(o.numberSections)) args.push('--number-sections');
  const shift = opt.num(o.shiftHeadings, 0);
  if (shift) args.push(`--shift-heading-level-by=${shift}`);
  if (!BINARY_OUT.includes(to)) {
    args.push(`--wrap=${o.wrap || 'none'}`);
    if (o.wrap === 'auto') args.push(`--columns=${clamp(opt.num(o.columns, 80), 20, 400)}`);
  }
  if (to === 'html' && opt.bool(o.embed, true)) args.push(versionAtLeast(pandocVersion, 2, 19) ? '--embed-resources' : '--self-contained', '--standalone');
  if (to === 'html' || to === 'epub') {
    const allowed = ['mathml', 'mathjax', 'katex'];
    const m = o.math || 'mathml';
    if (allowed.includes(m)) args.push(`--${m}`);
  }
  if (opt.str(o.title).trim()) args.push('--metadata', `title=${o.title.trim()}`);
  else if (to === 'html' || to === 'epub') args.push('--metadata', `pagetitle=${baseName}`);
  if (opt.str(o.author).trim()) args.push('--metadata', `author=${o.author.trim()}`);
  args.push(`--resource-path=${path.dirname(input)}`, input);
  await run(tools.pandoc, args, { signal, cwd: path.dirname(input), timeoutMs: 10 * 60 * 1000, errorMessage: 'Pandoc could not convert this document' });
  return [out];
}

export default {
  id: 'pandoc',
  label: 'Pandoc',
  optional: { install: 'winget install JohnMacFarlane.Pandoc', url: 'https://pandoc.org/installing.html', adds: 'reStructuredText, LaTeX, Org, AsciiDoc, Textile, MediaWiki, Typst, Jupyter, EPUB and higher-fidelity Word conversions' },
  async detect() {
    if (!tools.pandoc) return { available: false };
    const v = await versionOf(tools.pandoc, ['--version'], /pandoc(?:\.exe)? ([\d.]+)/);
    pandocVersion = v || '0';
    return { available: true, version: `Pandoc ${v || ''}`.trim() };
  },
  routes: () => {
    const ins = Object.keys(READERS);
    return [
      { from: ins, to: ['docx', 'odt', 'rtf', 'epub', 'pptx', 'fb2', 'ipynb', 'rst', 'tex', 'org', 'textile', 'wiki', 'adoc', 'typ', 'man', 'opml'], cost: 0.95 },
      { from: ins, to: ['md', 'html', 'txt'], cost: 1.3 },
      { from: ['docx', 'odt', 'epub', 'rtf', 'ipynb'], to: ['md', 'txt'], cost: 0.95 },
    ];
  },
  schema,
  convert,
};
