import { readFile, writeFile, mkdir, readdir, copyFile, chmod } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRadar, validateSnapshot } from './dashboard/engine.js';
import { buildDossier } from './vendor/makefun-board.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_CAP_BYTES = 4 * 1024 * 1024;
const DOSSIER_CAP_BYTES = 1572864;
const SOURCE_CAP_BYTES = 65536;
const SCREENSHOT_CAP_BYTES = 524288;
const MAX_INPUT_BYTES = 8 * 1024 * 1024;

function argumentsOf(args: string[]) {
  const options = { input: '/input/snapshot.json', output: process.env.MAKEFUN_OUTPUT_DIR ?? '/output', preview: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--preview') options.preview = true;
    else if (arg === '--input' || arg === '--output') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a file or directory.`);
      options[arg.slice(2) as 'input' | 'output'] = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.input.endsWith('.json')) options.input = join(options.input, 'snapshot.json');
  const output = resolve(options.output);
  const isInside = (directory: string) => output === directory || output.startsWith(directory + '/');
  if (output === HERE || output === '/' || isInside(join(HERE, 'dashboard'))
    || isInside(join(HERE, 'screenshots')) || resolve(options.input).startsWith(output + '/')) {
    throw new Error('Choose an output directory separate from input and source files.');
  }
  return options;
}

async function copyDirectory(from: string, to: string) {
  await mkdir(to, { recursive: true, mode: 0o755 });
  for (const entry of (await readdir(from, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(entry.name)) throw new Error(`Unsafe asset filename: ${entry.name}`);
    const target = join(to, entry.name);
    if (entry.isDirectory()) await copyDirectory(join(from, entry.name), target);
    else if (entry.isFile()) {
      await copyFile(join(from, entry.name), target);
      await chmod(target, 0o644);
    } else throw new Error(`Asset must be a regular file: ${entry.name}`);
  }
}

async function main() {
  process.umask(0o022);
  const options = argumentsOf(process.argv.slice(2));
  const input = await readFile(options.input);
  if (input.byteLength > MAX_INPUT_BYTES) throw new Error('Snapshot exceeds the 8 MiB input limit.');
  const snapshot = validateSnapshot(JSON.parse(input.toString('utf8')));
  const radar = buildRadar(snapshot);
  const out = resolve(options.output);
  await mkdir(out, { recursive: true, mode: 0o755 });
  await writeFile(join(out, 'board.json'), JSON.stringify({ model: radar.version, as_of: radar.as_of, rows: radar.rows }) + '\n', { mode: 0o644 });
  // Keep the frozen input outside dashboard/: its source stays readable within the dossier's 64 KiB.
  const safeJSON = JSON.stringify(snapshot).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  await writeFile(join(out, 'data.js'), `window.FIELDNOTE_SNAPSHOT=${safeJSON};\n`, { mode: 0o644 });
  await copyFile(join(HERE, 'research-data.js'), join(out, 'research-data.js'));
  await chmod(join(out, 'research-data.js'), 0o644);
  await copyDirectory(join(HERE, 'dashboard'), join(out, 'dashboard'));
  await copyDirectory(join(HERE, 'lib'), join(out, 'lib'));
  const summary = {
    model: radar.version, as_of: radar.as_of, protocols: radar.universe_size,
    candidates: radar.rows.length, watchlist_covered: radar.rows.filter(p => p.watchlist).length,
    peers: radar.model.peer_count, validation: radar.model.validation,
  };
  await writeFile(join(out, 'validation.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o644 });
  if (options.preview) {
    console.log(JSON.stringify({ ...summary, preview_only: true, page: join(out, 'dashboard/index.html'),
      notice: 'Preview mode writes no dossier. Run a full build with real browser captures for artifact validation.' }, null, 2));
    return;
  }
  try {
    const files = await readdir(join(HERE, 'screenshots'), { withFileTypes: true });
    if (files.length < 3 || files.length > 4 || files.some(f => !f.isFile() || !/\.(png|jpe?g)$/i.test(f.name))) {
      throw new Error('Need 3–4 real PNG/JPEG browser captures: board, detail and filtered view.');
    }
  } catch (error) {
    throw new Error(`Screenshots not ready. Use --preview for local development. ${(error as Error).message}`);
  }
  await copyDirectory(join(HERE, 'screenshots'), join(out, 'screenshots'));
  const dossier = buildDossier(out, { text_max_bytes: SOURCE_CAP_BYTES,
    screenshots: { max: 4, max_bytes: SCREENSHOT_CAP_BYTES },
    dashboard: { max_files: 400, max_bytes: DASHBOARD_CAP_BYTES } });
  if (dossier.byteLength > DOSSIER_CAP_BYTES) throw new Error('Dossier exceeds the bounty-specific 1.5 MiB cap.');
  await writeFile(join(out, 'dossier.json'), dossier, { mode: 0o644 });
  console.log(JSON.stringify({ ...summary, dossier_bytes: dossier.byteLength }, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(`FIELDNOTE: ${(error as Error).message}`);
  process.exitCode = 1;
}
