#!/usr/bin/env node
// MCP server for ExCas-Analyzer over stdio. Its seven tools run the WebAssembly core
// (docs/kmer_align.wasm) and read back the files it writes; no analysis is done here.
// Start with: node local/mcp/server.mjs

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { StdioServer, RpcError, INVALID_PARAMS, PROTOCOL_VERSIONS, LATEST_PROTOCOL } from './lib/rpc.mjs';
import { runAnalysis, DEFAULTS } from './lib/engine.mjs';
import { readReference, resolveLocation, singleLineFasta, parseFasta, PAMS } from './lib/reference.mjs';
import { parseMutationSummary, summaryTable, headline } from './lib/summary.mjs';
import { pileupFromRun, profile } from './lib/pileup.mjs';
import { newRunId, runDir, runFile, writeManifest, readManifest, listRuns, isInside, RUNS_ROOT } from './lib/runs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(await fsp.readFile(path.join(HERE, '..', '..', 'package.json'), 'utf8'));

const log = (msg) => process.stderr.write(`[excas-mcp] ${msg}\n`);

// stdout carries protocol messages only, so console output goes to stderr.
for (const level of ['log', 'info', 'debug', 'warn']) {
  console[level] = (...a) => process.stderr.write(a.map(String).join(' ') + '\n');
}

// ---- path handling ----

// Relative paths resolve against EXCAS_MCP_DATA, or else the working directory.
const DATA_ROOT = path.resolve(process.env.EXCAS_MCP_DATA || process.cwd());

// Optional allow-list from EXCAS_MCP_ALLOW_DIR, separated like PATH (';' on Windows,
// ':' elsewhere). When set, every path that goes through resolveInput() (reference,
// FASTQs, output_dir) must lie inside one of these folders. Unset means no limit.
const ALLOW_ROOTS = (process.env.EXCAS_MCP_ALLOW_DIR || '')
  .split(path.delimiter).filter(Boolean).map((p) => path.resolve(p));

function resolveInput(p, label) {
  if (typeof p !== 'string' || !p.trim()) throw new RpcError(INVALID_PARAMS, `${label} is required.`);
  const abs = path.resolve(DATA_ROOT, p);
  if (ALLOW_ROOTS.length) {
    const ok = ALLOW_ROOTS.some((root) => isInside(root, abs));
    if (!ok) {
      throw new RpcError(INVALID_PARAMS,
        `${label}: "${p}" is outside the permitted directories (${ALLOW_ROOTS.join(', ')}).`);
    }
  }
  return abs;
}

async function mustExist(abs, label) {
  try {
    const st = await fsp.stat(abs);
    if (!st.isFile()) throw new Error('not a file');
    return st;
  } catch {
    throw new RpcError(INVALID_PARAMS, `${label}: "${abs}" does not exist or is not a readable file.`);
  }
}

// ---- schema fragments ----

const PAM_IDS = PAMS.map((p) => p.id);

const REF_PROPS = {
  reference: { type: 'string', description: 'Path to the reference FASTA (.fa, .fasta, .gz). Only the first record is used.' },
  reference_sequence: { type: 'string', description: 'The reference as a plain sequence, instead of a file path.' }
};

const TARGET_PROPS = {
  target_sequence: { type: 'string', description: 'The protospacer (sgRNA spacer) without the PAM. Both strands are searched.' },
  pam: { type: 'string', enum: PAM_IDS, default: 'NGG', description: 'PAM next to the target. "none" skips the PAM check; then cleavage_offset is required.' },
  cleavage_offset: { type: 'integer', description: 'Cut position as an offset from target_start, not a coordinate. Overrides the PAM default.' }
};

const ANALYSIS_OPTIONS = {
  k: { type: 'integer', minimum: 7, maximum: 16, default: DEFAULTS.k, description: 'k-mer size for the alignment index.' },
  dist_cut: { type: 'integer', default: DEFAULTS.distCut, description: 'Furthest a deletion breakpoint may be from the cut, in bp.' },
  min_gap: { type: 'integer', default: DEFAULTS.minGap, description: 'Smallest gap between the mates of a non-split pair for it to count as a large deletion, in bp.' },
  anchor_min: { type: 'integer', default: DEFAULTS.anchorMin, description: 'Lowest anchor score for a split read (length − 4 × mismatches). 0 turns it off; 16 is strict.' },
  cut_between: { type: 'boolean', default: DEFAULTS.cutBetween, description: 'A large deletion needs the cut to lie between the two mates.' },
  ins_fix: { type: 'boolean', default: DEFAULTS.insFix, description: 'Record read-side gaps as insertions. Off loses most insertions of 9 bp or more.' },
  ins_max: { type: 'integer', default: DEFAULTS.insMax, description: 'Longest insertion to keep; 0 means no limit.' },
  report: { type: 'boolean', default: DEFAULTS.report, description: 'Write the HTML report and TSV tables.' },
  large_del_len: { type: 'integer', default: DEFAULTS.largeDelLen, description: 'Shortest deletion inside one read that counts as large, in bp; shorter ones are small indels. 100 is the paper\'s definition.' },
  clip_rescue: { type: 'boolean', default: DEFAULTS.clipRescue, description: 'Re-call a small indel within 13 bp of a read end, seen only as a soft clip, as the allele seen with full anchors in at least 3 pairs.' },
  common_mode: { type: 'string', enum: ['local', 'kmeans'], default: DEFAULTS.commonMode, description: 'How a large deletion is judged common with the control: "local" compares read pairs (breakpoints within max(20 bp, 2% of length)); "kmeans" compares cluster centres (the paper\'s method).' },
  full_sam: { type: 'boolean', default: DEFAULTS.fullSam, description: 'Also write the full alignment SAM (about 110 MB per 150k read pairs).' }
};

// ---- tools ----

const TOOLS = [];
const register = (def, run) => { TOOLS.push({ def, run }); };

register({
  name: 'locate_target',
  title: 'Locate the target and cleavage site',
  description:
    'Find a protospacer in a reference and work out the cut site from the PAM. ' +
    'Returns 1-based target_start / target_end and the cleavage offset. ' +
    'Use it before run_analysis when you only know the guide. ' +
    'Fails if the target is missing, has no matching PAM, or occurs more than once.',
  inputSchema: {
    type: 'object',
    properties: { ...REF_PROPS, ...TARGET_PROPS },
    required: ['target_sequence']
  }
}, async (a) => {
  const { sequence, name } = await loadReference(a);
  const loc = resolveLocation(sequence, cleanTarget(a.target_sequence), a.pam ?? 'NGG', a.cleavage_offset);
  return {
    reference: name,
    reference_length: sequence.length,
    target_start: loc.st,
    target_end: loc.ed,
    strand: loc.strand,
    pam_match: loc.pam,
    pam: loc.pamId,
    enzyme: loc.enzyme,
    cleavage_offset: loc.cle,
    cut_site: loc.cut,
    note: '1-based. cleavage_offset is relative to target_start; cut_site = target_start + cleavage_offset (the first base after the cut).'
  };
});

register({
  name: 'inspect_reference',
  title: 'Inspect a reference FASTA',
  description:
    'Name, length, GC content and record count of a reference FASTA. ' +
    'Warns about extra records (only the first is used); refuses bzip2, xz and zstd.',
  inputSchema: {
    type: 'object',
    properties: { reference: REF_PROPS.reference },
    required: ['reference']
  }
}, async (a) => {
  const file = resolveInput(a.reference, 'reference');
  await mustExist(file, 'reference');
  const ref = await readReference(file);
  return {
    path: file,
    record_name: ref.name,
    length_bp: ref.length,
    gc_percent: ref.gcPercent,
    records: ref.records,
    warning: ref.records > 1
      ? `This FASTA holds ${ref.records} records; only the first is analysed, as in the core.`
      : null,
    head: ref.sequence.slice(0, 60),
    tail: ref.sequence.slice(-60)
  };
});

register({
  name: 'run_analysis',
  title: 'Run the large-deletion analysis',
  description:
    'Run the control-vs-treated analysis on four FASTQ files (.fastq or .fastq.gz) and save it. ' +
    'Give target_sequence (with pam), or target_start, target_end and cleavage_offset. ' +
    'Returns the summary, headline rates and a run_id. ' +
    'Takes about a minute per million read pairs.',
  inputSchema: {
    type: 'object',
    properties: {
      ...REF_PROPS,
      control_r1: { type: 'string', description: 'Control sample, read 1 FASTQ.' },
      control_r2: { type: 'string', description: 'Control sample, read 2 FASTQ.' },
      treated_r1: { type: 'string', description: 'Cas9-treated sample, read 1 FASTQ.' },
      treated_r2: { type: 'string', description: 'Cas9-treated sample, read 2 FASTQ.' },
      gene: { type: 'string', description: 'Gene name; starts the output file names. Default: the FASTA record name.' },
      sample: { type: 'string', default: 'MCP', description: 'Sample name; second part of the output file names.' },
      ...TARGET_PROPS,
      target_start: { type: 'integer', description: '1-based first base of the protospacer. Instead of target_sequence.' },
      target_end: { type: 'integer', description: '1-based last base of the protospacer.' },
      ...ANALYSIS_OPTIONS,
      output_dir: { type: 'string', description: 'Where to write the output files. Default: a new folder in runs/.' }
    },
    required: ['control_r1', 'control_r2', 'treated_r1', 'treated_r2']
  }
}, async (a, ctx) => {
  const { sequence, name } = await loadReference(a);

  // Coordinates come from the guide or are given directly. Both are 1-based, and
  // cut = target_start + cleavage_offset is the first base after the cut.
  let loc;
  if (a.target_sequence) {
    loc = resolveLocation(sequence, cleanTarget(a.target_sequence), a.pam ?? 'NGG', a.cleavage_offset);
  } else {
    if (!Number.isInteger(a.target_start) || !Number.isInteger(a.target_end)) {
      throw new RpcError(INVALID_PARAMS,
        'Give either target_sequence (with a pam), or both target_start and target_end.');
    }
    if (!Number.isInteger(a.cleavage_offset)) {
      throw new RpcError(INVALID_PARAMS,
        'cleavage_offset is required when coordinates are given directly. It is an offset from ' +
        'target_start, not an absolute position.');
    }
    if (a.target_start < 1 || a.target_end > sequence.length || a.target_start > a.target_end) {
      throw new RpcError(INVALID_PARAMS,
        `target_start/target_end (${a.target_start}-${a.target_end}) fall outside the ` +
        `${sequence.length} bp reference.`);
    }
    loc = { st: a.target_start, ed: a.target_end, cle: a.cleavage_offset,
            cut: a.target_start + a.cleavage_offset, strand: null, pam: null, pamId: null, enzyme: null };
  }

  if (loc.cut < 1 || loc.cut > sequence.length) {
    throw new RpcError(INVALID_PARAMS,
      `The cleavage site derived from this offset falls at ${loc.cut}, outside the ` +
      `${sequence.length} bp reference. cleavage_offset is relative to target_start (${loc.st}).`);
  }

  const gene = (a.gene || name || 'GENE').replace(/[^A-Za-z0-9._-]+/g, '_');
  const sample = (a.sample || 'MCP').replace(/[^A-Za-z0-9._-]+/g, '_');

  const files = {
    control1: resolveInput(a.control_r1, 'control_r1'),
    control2: resolveInput(a.control_r2, 'control_r2'),
    treated1: resolveInput(a.treated_r1, 'treated_r1'),
    treated2: resolveInput(a.treated_r2, 'treated_r2')
  };
  const sizes = {};
  for (const [key, file] of Object.entries(files)) {
    sizes[key] = (await mustExist(file, key)).size;
  }
  if (files.control1 === files.control2 || files.treated1 === files.treated2) {
    throw new RpcError(INVALID_PARAMS, 'Read 1 and read 2 must be different files.');
  }

  const runId = newRunId(gene, sample);
  const outDir = a.output_dir ? resolveInput(a.output_dir, 'output_dir') : runDir(runId);

  const job = {
    referenceFasta: singleLineFasta(gene, sequence),
    ...files,
    gene, sample,
    targetStart: loc.st, targetEnd: loc.ed, cleavage: loc.cle,
    outDir,
    k: a.k ?? DEFAULTS.k,
    distCut: a.dist_cut ?? DEFAULTS.distCut,
    minGap: a.min_gap ?? DEFAULTS.minGap,
    anchorMin: a.anchor_min ?? DEFAULTS.anchorMin,
    cutBetween: a.cut_between ?? DEFAULTS.cutBetween,
    insFix: a.ins_fix ?? DEFAULTS.insFix,
    insMax: a.ins_max ?? DEFAULTS.insMax,
    report: a.report ?? DEFAULTS.report,
    largeDelLen: a.large_del_len ?? DEFAULTS.largeDelLen,
    clipRescue: a.clip_rescue ?? DEFAULTS.clipRescue,
    commonMode: a.common_mode ?? DEFAULTS.commonMode,
    fullSam: a.full_sam ?? DEFAULTS.fullSam
  };

  if (job.k < 7 || job.k > 16) throw new RpcError(INVALID_PARAMS, 'k must be between 7 and 16.');
  if (job.commonMode !== 'local' && job.commonMode !== 'kmeans') {
    throw new RpcError(INVALID_PARAMS, 'common_mode must be "local" or "kmeans".');
  }

  log(`run ${runId}: ${gene}/${sample} cut=${loc.cut} k=${job.k}`);
  const res = await runAnalysis(job, ctx.progress);

  const prefix = `${gene}_${sample}`;
  const tsv = res.outputs.find((o) => o.name === `${prefix}_mutation_summary.tsv`);
  const patterns = parseMutationSummary(tsv ? await fsp.readFile(tsv.path, 'utf8') : '');
  const table = summaryTable(patterns, res.metrics);
  const head = headline(res.metrics);

  const warnings = [];
  if (res.refLen && res.refLen !== sequence.length) {
    warnings.push(`The core read a ${res.refLen} bp reference where the input parsed to ${sequence.length} bp.`);
  }
  for (const row of table) {
    if (row.reads_used === 0) {
      warnings.push(`No ${row.label} reads survived to the analysed set — check the coordinates and the read pairing.`);
    } else if (row.reads_used_percent_of_total != null && row.reads_used_percent_of_total < 1) {
      warnings.push(`Only ${row.reads_used_percent_of_total}% of ${row.label} reads reached the cut site; ` +
                    'the class percentages rest on a small population.');
    }
  }

  const manifest = {
    run_id: runId,
    gene, sample, prefix,
    finished_at: new Date().toISOString(),
    engine: { wasm: 'docs/kmer_align.wasm', server: PKG.version ?? '0.0.0' },
    inputs: {
      reference: a.reference ? resolveInput(a.reference, 'reference') : '(inline sequence)',
      reference_length: sequence.length,
      control_r1: files.control1, control_r2: files.control2,
      treated_r1: files.treated1, treated_r2: files.treated2,
      input_bytes: {
        control_r1: sizes.control1, control_r2: sizes.control2,
        treated_r1: sizes.treated1, treated_r2: sizes.treated2
      }
    },
    coordinates: {
      target_start: loc.st, target_end: loc.ed, strand: loc.strand,
      pam: loc.pamId, pam_match: loc.pam, cleavage_offset: loc.cle, cut: loc.cut
    },
    options: {
      k: job.k, dist_cut: job.distCut, min_gap: job.minGap, anchor_min: job.anchorMin,
      cut_between: job.cutBetween, ins_fix: job.insFix, ins_max: job.insMax,
      report: job.report, large_del_len: job.largeDelLen, clip_rescue: job.clipRescue,
      common_mode: job.commonMode, full_sam: job.fullSam
    },
    output_dir: outDir,
    outputs: res.outputs.map((o) => ({ name: o.name, bytes: o.bytes })),
    // Numbers parsed from the core's log, unchanged. The summary table is built from
    // these and mutation_summary.tsv.
    metrics: res.metrics,
    summary: table,
    headline: head,
    warnings,
    elapsed_ms: res.elapsedMs
  };

  await writeManifest(runId, manifest);
  // Keep the core's log, and the exact reference it was given, which mutation_profile
  // needs. Both go in the run folder, even when output_dir points elsewhere.
  await fsp.writeFile(path.join(runDir(runId), 'stdout.log'), res.stdout);
  await fsp.writeFile(path.join(runDir(runId), 'reference.fa'), job.referenceFasta);

  return {
    run_id: runId,
    output_dir: outDir,
    coordinates: manifest.coordinates,
    summary: table,
    headline: head,
    outputs: manifest.outputs,
    warnings,
    elapsed_ms: res.elapsedMs,
    next: 'Use mutation_profile for per-position tallies, or read_output for any file above.'
  };
});

register({
  name: 'list_runs',
  title: 'List stored runs',
  description: 'Stored runs on this machine, newest first, with their cut site and large-deletion rate.',
  inputSchema: { type: 'object', properties: {} }
}, async () => ({ runs_root: RUNS_ROOT, runs: await listRuns() }));

register({
  name: 'get_run',
  title: 'Get a run\'s manifest',
  description: 'One run\'s details: inputs, coordinates, options, summary table and output files.',
  inputSchema: {
    type: 'object',
    properties: { run_id: { type: 'string', description: 'A run_id from run_analysis or list_runs.' } },
    required: ['run_id']
  }
}, async (a) => readManifest(a.run_id));

const READ_CAP = 200_000;
register({
  name: 'read_output',
  title: 'Read a file a run produced',
  description:
    'Read part of a run\'s output file: SAM, TSV, HTML report or log. ' +
    'Reads are size-capped; use head_lines, tail_lines or offset to move through a large file.',
  inputSchema: {
    type: 'object',
    properties: {
      run_id: { type: 'string', description: 'A run_id from run_analysis or list_runs.' },
      file: { type: 'string', description: 'A file name from the run, e.g. HPRT1_MCP_mutation_summary.tsv.' },
      head_lines: { type: 'integer', description: 'Return this many lines from the start.' },
      tail_lines: { type: 'integer', description: 'Return this many lines from the end.' },
      offset: { type: 'integer', default: 0, description: 'Byte to start from (when not using head_lines / tail_lines).' },
      max_bytes: { type: 'integer', default: 32768, maximum: READ_CAP, description: `Most bytes to return (limit ${READ_CAP}).` }
    },
    required: ['run_id', 'file']
  }
}, async (a) => {
  const m = await readManifest(a.run_id);
  // The core's files are in output_dir (usually the run folder); run.json, stdout.log
  // and reference.fa are always in the run folder. Try both.
  const bases = [m.output_dir || runDir(a.run_id), runDir(a.run_id)];
  let file = null, st = null;
  for (const base of bases) {
    const candidate = runFile(base, a.file, a.run_id);
    try {
      st = await fsp.stat(candidate);
      file = candidate;
      break;
    } catch { /* try the next base */ }
  }
  if (!file) {
    const extra = ['run.json', 'stdout.log', 'reference.fa'];
    throw new RpcError(INVALID_PARAMS,
      `Run "${a.run_id}" has no file "${a.file}". It has: ` +
      m.outputs.map((o) => o.name).concat(extra).join(', ') + '.');
  }

  const cap = Math.min(a.max_bytes ?? 32768, READ_CAP);
  const fh = await fsp.open(file, 'r');
  const readAt = async (offset, len) => {
    const n = Math.max(0, Math.min(len, st.size - offset));
    const buf = Buffer.alloc(n);
    if (n) await fh.read(buf, 0, n, offset);
    return { text: buf.toString('utf8'), bytes: n };
  };

  try {
    // SAM files can be large, so line mode reads a single 1 MiB window from the start
    // or the end (cap * 4 is always smaller). A file that fits is read whole.
    if (a.head_lines || a.tail_lines) {
      const window = Math.max(cap * 4, 1 << 20);
      const whole = st.size <= window;
      const wanted = a.tail_lines || a.head_lines;
      let lines, take;
      if (a.tail_lines) {
        const from = Math.max(0, st.size - window);
        lines = (await readAt(from, window)).text.split('\n');
        // a window that starts mid-file probably starts mid-line
        if (!whole) lines.shift();
        take = lines.slice(Math.max(0, lines.length - a.tail_lines));
      } else {
        lines = (await readAt(0, window)).text.split('\n');
        if (!whole) lines.pop();
        take = lines.slice(0, a.head_lines);
      }
      let text = take.join('\n');
      const clipped = text.length > cap;
      if (clipped) text = text.slice(0, cap);
      return {
        file: a.file,
        bytes_total: st.size,
        // known only when the window covered the whole file
        lines_total: whole ? lines.length : null,
        lines_returned: take.length,
        truncated: clipped || take.length < wanted,
        text
      };
    }

    const offset = Math.max(0, a.offset ?? 0);
    const { text, bytes } = await readAt(offset, cap);
    return {
      file: a.file,
      bytes_total: st.size,
      offset,
      bytes_returned: bytes,
      truncated: offset + bytes < st.size,
      text
    };
  } finally {
    await fh.close();
  }
});

register({
  name: 'mutation_profile',
  title: 'Per-position mutation profile',
  description:
    'For each position near the cut: coverage, bases, insertion, deletion and substitution rates, ' +
    'and mean indel lengths, from the run\'s SAM files. The numbers behind the page\'s per-base charts. ' +
    'Deletions at the cut and long split-read deletions are counted separately.',
  inputSchema: {
    type: 'object',
    properties: {
      run_id: { type: 'string', description: 'A run_id from run_analysis or list_runs.' },
      sample: { type: 'string', enum: ['treated', 'control'], default: 'treated', description: 'Which sample to profile.' },
      half_width: { type: 'integer', default: 30, minimum: 1, maximum: 500, description: 'How many bases on each side of the cut.' }
    },
    required: ['run_id']
  }
}, async (a) => {
  const m = await readManifest(a.run_id);
  const sample = a.sample ?? 'treated';
  const halfWidth = Math.min(500, Math.max(1, a.half_width ?? 30));

  // Use the reference saved with the run, so substitutions are called against the
  // bases the core aligned to.
  const fa = await fsp.readFile(path.join(runDir(a.run_id), 'reference.fa'), 'utf8').catch(() => null);
  if (!fa) {
    throw new RpcError(INVALID_PARAMS,
      `Run "${a.run_id}" has no stored reference, so substitutions cannot be derived. ` +
      'Re-run the analysis to produce one.');
  }
  const refSeq = parseFasta(fa);

  const { pileup, missing } = await pileupFromRun(
    m.output_dir || runDir(a.run_id), m.prefix, sample, refSeq.length);
  if (!pileup.reads) {
    return { run_id: a.run_id, sample, reads_in_pileup: 0, missing_sam_files: missing, positions: [],
             note: 'No alignments in this sample\'s SAM output, so there is nothing to profile.' };
  }

  const p = profile(pileup, refSeq, m.coordinates.cut, halfWidth);
  return { run_id: a.run_id, sample, missing_sam_files: missing, ...p };
});

// ---- shared helpers ----

async function loadReference(a) {
  if (a.reference_sequence) {
    const seq = parseFasta(a.reference_sequence);
    if (!seq) throw new RpcError(INVALID_PARAMS, 'reference_sequence contains no sequence.');
    const bad = seq.replace(/[ACGTN]/g, '');
    if (bad) throw new RpcError(INVALID_PARAMS,
      `reference_sequence contains characters other than A, C, G, T and N (first offender "${bad[0]}").`);
    return { sequence: seq, name: a.gene || 'REFERENCE' };
  }
  if (!a.reference) throw new RpcError(INVALID_PARAMS, 'Give either reference (a path) or reference_sequence.');
  const file = resolveInput(a.reference, 'reference');
  await mustExist(file, 'reference');
  const ref = await readReference(file);
  return { sequence: ref.sequence, name: ref.name };
}

function cleanTarget(t) {
  const s = String(t || '').replace(/\s+/g, '').toUpperCase();
  if (!s) throw new RpcError(INVALID_PARAMS, 'target_sequence is required.');
  const bad = s.replace(/[ACGTN]/g, '');
  if (bad) throw new RpcError(INVALID_PARAMS,
    `target_sequence contains characters other than A, C, G, T and N (first offender "${bad[0]}").`);
  if (s.length < 10) throw new RpcError(INVALID_PARAMS,
    `target_sequence is only ${s.length} bp; a protospacer that short will match many sites.`);
  return s;
}

// ---- protocol handlers ----

const server = new StdioServer({
  onLog: log,
  serialize: ['tools/call'],
  onClose: () => { log('stdin closed, exiting'); process.exit(0); },
  handlers: {
    initialize(params) {
      const asked = params?.protocolVersion;
      const version = PROTOCOL_VERSIONS.includes(asked) ? asked : LATEST_PROTOCOL;
      log(`initialize from ${params?.clientInfo?.name || 'an unnamed client'} (protocol ${asked} → ${version})`);
      return {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'excas-analyzer', title: 'ExCas-Analyzer', version: PKG.version ?? '0.0.0' },
        instructions:
          'Runs the ExCas-Analyzer CRISPR large-deletion analysis (the same WebAssembly as the web ' +
          'page). Usual order: inspect_reference, locate_target (guide → coordinates), run_analysis, ' +
          'then mutation_profile or read_output with its run_id. cleavage_offset is an offset from ' +
          'target_start, not a coordinate. A run takes minutes: about one per million read pairs.'
      };
    },

    'notifications/initialized'() { /* nothing to do */ },
    'notifications/cancelled'() { /* the wasm call is not interruptible */ },

    ping() { return {}; },

    'tools/list'() {
      return { tools: TOOLS.map((t) => t.def) };
    },

    async 'tools/call'(params, msg) {
      const tool = TOOLS.find((t) => t.def.name === params?.name);
      if (!tool) {
        throw new RpcError(INVALID_PARAMS, `Unknown tool "${params?.name}".`);
      }
      const args = params.arguments || {};

      // Progress notifications go out only if the client sent a progressToken. They
      // come while the inputs load and at each stage of the core, not continuously.
      const token = params?._meta?.progressToken ?? msg?.params?._meta?.progressToken;
      const progress = (message, frac) => {
        if (token === undefined || token === null) return;
        server.notify('notifications/progress', {
          progressToken: token,
          progress: frac == null ? undefined : Math.round(frac * 100),
          total: frac == null ? undefined : 100,
          message
        });
      };

      try {
        const result = await tool.run(args, { progress });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        if (err instanceof RpcError) throw err;
        // Any other failure becomes an isError result, so the agent can read why.
        log(`${params.name} failed: ${err.stack || err.message}`);
        return {
          isError: true,
          content: [{ type: 'text', text: `${params.name} failed: ${err.message || String(err)}` }]
        };
      }
    }
  }
});

process.on('uncaughtException', (e) => { log(`uncaught: ${e.stack || e.message}`); });
process.on('unhandledRejection', (e) => { log(`unhandled rejection: ${e?.stack || e}`); });

server.start();
log(`ready — ${TOOLS.length} tools, runs in ${RUNS_ROOT}`);
if (ALLOW_ROOTS.length) log(`confined to ${ALLOW_ROOTS.join(', ')}`);
