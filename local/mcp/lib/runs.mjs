// Stored runs: one folder per run under RUNS_ROOT, holding run.json (the manifest the
// other tools read) and, unless output_dir pointed elsewhere, the core's output files.

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const RUNS_ROOT = path.resolve(
  process.env.EXCAS_MCP_RUNS || path.join(HERE, '..', 'runs')
);

const slug = (s) => String(s || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'run';

// Is `abs` inside `root`? The isAbsolute check catches another drive on Windows.
export function isInside(root, abs) {
  const rel = path.relative(root, abs);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function newRunId(gene, sample) {
  const t = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  return `${slug(gene)}_${slug(sample)}_${t}`;
}

export function runDir(runId) {
  const dir = path.join(RUNS_ROOT, slug(runId));
  // slug() strips separators but keeps dots, so ".." would still leave RUNS_ROOT.
  if (!isInside(RUNS_ROOT, dir)) throw new Error(`Bad run id "${runId}".`);
  return dir;
}

export async function writeManifest(runId, manifest) {
  const dir = runDir(runId);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'run.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

export async function readManifest(runId) {
  const file = path.join(runDir(runId), 'run.json');
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`No run called "${runId}". Use list_runs to see what is stored.`);
    throw e;
  }
}

export async function listRuns() {
  let names;
  try {
    names = await fsp.readdir(RUNS_ROOT);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }

  const out = [];
  for (const name of names) {
    try {
      const m = JSON.parse(await fsp.readFile(path.join(RUNS_ROOT, name, 'run.json'), 'utf8'));
      out.push({
        run_id: m.run_id,
        gene: m.gene,
        sample: m.sample,
        finished_at: m.finished_at,
        reference: m.inputs?.reference ?? null,
        cut: m.coordinates?.cut ?? null,
        treated_large_deletion_percent: m.headline?.treated_large_deletion_percent ?? null,
        files: m.outputs?.length ?? 0
      });
    } catch { /* not a run directory, or a half-written one */ }
  }
  out.sort((a, b) => String(b.finished_at).localeCompare(String(a.finished_at)));
  return out;
}

// Path of a file inside baseDir (a run folder or its output_dir); refuses names that
// leave it.
export function runFile(baseDir, name, runId) {
  const dir = path.resolve(baseDir);
  const file = path.resolve(dir, name);
  if (!isInside(dir, file)) {
    throw new Error(`"${name}" is outside run "${runId}".`);
  }
  return file;
}
