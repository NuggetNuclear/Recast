// 3D models via the Assimp command-line tool (optional — included in the Docker image).
import fsp from 'node:fs/promises';
import path from 'node:path';
import { f, group } from '../schema.js';
import { tools, versionOf } from '../tools.js';
import { run, UserError, opt } from '../util.js';

const IN = ['stl', 'obj', 'ply', 'gltf', 'glb', 'fbx', 'dae', '3ds', '3mf', 'off'];
const OUT = ['stl', 'obj', 'ply', 'gltf', 'glb', 'fbx', 'dae', '3ds', '3mf', 'x3d'];
// Assimp 5.4 crashes when these exporters get joined vertices (-jiv).
const NO_JOIN = ['gltf', 'glb', 'ply'];
// Assimp exporter ids; the second one is the ASCII / binary alternative where there is a choice.
const EXPORTER = {
  stl: ['stlb', 'stl'], ply: ['plyb', 'ply'], fbx: ['fbx', 'fbxa'],
  obj: ['obj'], gltf: ['gltf2'], glb: ['glb2'], dae: ['collada'], '3ds': ['3ds'], '3mf': ['3mf'], x3d: ['x3d'],
};

function schema({ to }) {
  const fields = [
    EXPORTER[to]?.length > 1 ? f.select('encoding', 'Encoding', [{ value: 'binary', label: 'Binary (smaller)' }, { value: 'ascii', label: 'Text (ASCII)' }], 'binary', { finalOnly: true }) : null,
    f.toggle('triangulate', 'Triangulate faces', ['stl', '3mf', '3ds'].includes(to)),
    NO_JOIN.includes(to) ? null : f.toggle('joinVertices', 'Merge identical vertices', true),
    f.toggle('normals', 'Generate smooth normals if missing'),
    f.toggle('flipUV', 'Flip texture coordinates (V)'),
  ];
  return [group('model', `${to.toUpperCase()} output`, fields)];
}

async function convert({ input, from, to, o, outDir, baseName, signal, progress }) {
  if (!tools.assimp) throw new UserError('Assimp is not installed');
  // Assimp picks the importer from the extension, so give the input its real one.
  let src = input;
  if (path.extname(input).toLowerCase() !== `.${from}`) {
    src = path.join(path.dirname(input), `${baseName}-input.${from}`);
    await fsp.copyFile(input, src);
  }
  const out = path.join(outDir, `${baseName}.${to}`);
  const [binary, ascii] = EXPORTER[to];
  const args = ['export', src, out, `-f${o.encoding === 'ascii' && ascii ? ascii : binary}`];
  if (opt.bool(o.triangulate, ['stl', '3mf', '3ds'].includes(to))) args.push('-tri');
  if (!NO_JOIN.includes(to) && opt.bool(o.joinVertices, true)) args.push('-jiv');
  if (opt.bool(o.normals)) args.push('-gsn');
  if (opt.bool(o.flipUV)) args.push('-fuv');
  progress(0.2);
  await run(tools.assimp, args, { signal, cwd: outDir, timeoutMs: 20 * 60 * 1000, errorMessage: 'Assimp could not convert this model' });
  // Some exporters write companions next to the model (OBJ → .mtl, glTF → .bin, textures).
  const produced = (await fsp.readdir(outDir)).filter((n) => n.startsWith(baseName)).map((n) => path.join(outDir, n));
  if (!produced.includes(out)) throw new UserError('Assimp produced no model');
  return [out, ...produced.filter((p) => p !== out)];
}

function installHint() {
  if (process.platform === 'darwin') return 'brew install assimp';
  if (process.platform === 'win32') return 'docker compose up -d --build';
  return 'sudo apt install assimp-utils';
}

export default {
  id: 'model',
  label: '3D models',
  optional: { install: installHint(), url: 'https://github.com/assimp/assimp', adds: 'STL, OBJ, PLY, glTF/GLB, FBX, COLLADA, 3DS, 3MF and X3D models' },
  async detect() {
    if (!tools.assimp) return { available: false };
    const v = await versionOf(tools.assimp, ['version'], /Version ([\d.]+)/i);
    return { available: true, version: `Assimp ${v && v !== 'unknown' ? v : ''}`.trim() };
  },
  routes: () => [{ from: IN, to: OUT, cost: 1 }],
  schema,
  convert,
};
