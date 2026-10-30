// Runs the analysis core (docs/kmer_align.wasm) under Node: copies the inputs into its
// in-memory filesystem, calls run_analysis() and writes the output files to disk.

import { createRequire } from 'node:module';
import { createReadStream, promises as fsp } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DOCS_DIR = path.resolve(HERE, '..', '..', '..', 'docs');

const require_ = createRequire(import.meta.url);
// Puts the core's Korean HTML report into English; shared with the web page.
const reportEn = require_(path.join(DOCS_DIR, 'report-en.js'));

// The core's default options, except full_sam, which is off (that SAM is large).
export const DEFAULTS = Object.freeze({
  k: 11,
  distCut: 8000,
  fullSam: false,
  minGap: 400,
  anchorMin: 13,
  cutBetween: true,
  insFix: true,
  insMax: 0,
  report: true,
  largeDelLen: 50,
  clipRescue: true,
  commonMode: 'local'
});

// ---- input staging ----

// Compression type from the magic bytes, not the file name: 'plain', 'gzip', 'bzip2',
// 'xz' or 'zstd'.
export async function sniff(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(6);
    const { bytesRead } = await fh.read(buf, 0, 6, 0);
    const h = buf.subarray(0, bytesRead);
    if (h[0] === 0x1f && h[1] === 0x8b) return 'gzip';
    if (h[0] === 0x42 && h[1] === 0x5a && h[2] === 0x68) return 'bzip2';
    if (h[0] === 0xfd && h[1] === 0x37 && h[2] === 0x7a && h[3] === 0x58 && h[4] === 0x5a) return 'xz';
    if (h[0] === 0x28 && h[1] === 0xb5 && h[2] === 0x2f && h[3] === 0xfd) return 'zstd';
    return 'plain';
  } finally {
    await fh.close();
  }
}

// Copy a FASTQ file into the in-memory filesystem, gunzipping it if needed; other
// compression is refused. onBytes(n) gets the bytes read from disk, so progress matches
// the file sizes for .gz input too.
// Returns { bytes: bytes written, compressed: whether the input was gzip }.
async function stageFile(FS, memPath, diskPath, label, onBytes) {
  const kind = await sniff(diskPath);
  if (kind !== 'plain' && kind !== 'gzip') {
    throw new Error(`${label}: ${kind} compression is not supported. ` +
                    'Re-compress as gzip (.gz) or supply the file uncompressed.');
  }

  const stream = FS.open(memPath, 'w');
  let pos = 0;
  let firstByte = -1;
  const sink = async function (source) {
    for await (const chunk of source) {
      if (!chunk.length) continue;
      const u8 = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
      if (firstByte < 0) firstByte = u8[0];
      FS.write(stream, u8, 0, u8.length, pos);
      pos += u8.length;
    }
  };
  const counted = async function* (source) {
    for await (const chunk of source) {
      if (onBytes) onBytes(chunk.length);
      yield chunk;
    }
  };

  try {
    const src = createReadStream(diskPath);
    if (kind === 'gzip') await pipeline(src, counted, createGunzip(), sink);
    else await pipeline(src, counted, sink);
  } catch (e) {
    throw new Error(`${label}: could not read (${e.message || e}). ` +
                    'The file may be corrupt or truncated.');
  } finally {
    FS.close(stream);
  }

  if (pos === 0) throw new Error(`${label}: "${path.basename(diskPath)}" is empty.`);
  // FASTQ starts with '@'; this catches a FASTA passed as reads before the core runs.
  if (firstByte !== 0x40) {
    throw new Error(`${label}: "${path.basename(diskPath)}" does not look like FASTQ ` +
                    `(it starts with "${String.fromCharCode(firstByte)}", not "@").`);
  }
  return { bytes: pos, compressed: kind === 'gzip' };
}

// ---- stdout parsing ----

// Pull the numbers out of the core's text log. The first total_align, total_read and
// alignment_rate lines are the control's, the second the treated sample's. The
// patterns copy the log text exactly, misspellings included.
export function parseMetrics(stdout) {
  const num = (re) => { const m = stdout.match(re); return m ? parseFloat(m[1]) : null; };
  const all = (re) => [...stdout.matchAll(re)].map((m) => parseFloat(m[1]));

  const aligned = all(/total_align: (\d+)/g);
  const totals = all(/total_read (\d+)/g);
  const rates = all(/alignment_rate ([\d.]+)/g);

  // Clip rescue prints one line per sample that had terminal-clip pairs; the control's
  // comes before the end of its alignment.
  const split = stdout.indexOf('Control sample alignment end');
  const rescue = (txt) => {
    const m = txt.match(/clip rescue: (\d+) of (\d+) terminal-clip pairs matched a small indel seen with full anchors \((\d+) deletion, (\d+) insertion\)/);
    return m ? { rescued: +m[1], clipped: +m[2], del: +m[3], ins: +m[4] } : null;
  };

  return {
    ctrRescue: split >= 0 ? rescue(stdout.slice(0, split)) : null,
    mutRescue: split >= 0 ? rescue(stdout.slice(split)) : null,
    ctrAligned: aligned[0] ?? null,
    ctrTotal: totals[0] ?? null,
    ctrAlignRate: rates[0] ?? null,
    mutAligned: aligned[1] ?? null,
    mutTotal: totals[1] ?? null,
    mutAlignRate: rates[1] ?? null,
    ctrSpanningPct: num(/Control sample Large Deletion Rate \(wihtout filtering\) : ([\d.]+)/),
    ctrSmallIndelPct: num(/Control sample small_indel rate: ([\d.]+)/),
    mutLargeDelPct: num(/Cas9 Mutation sample Large Deletion Rate \(removed false-postive\) : ([\d.]+)/),
    mutSmallIndelPct: num(/Cas9 Mutation sample small_indel rate: ([\d.]+)/),
    ctrAlignSec: num(/Control sample alignment time : ([\d.]+)/),
    mutAlignSec: num(/Cas9 Mutation sample alignment time : ([\d.]+)/),
    postSec: num(/post time : ([\d.]+)/),
    wholeSec: num(/whole time : ([\d.]+)/)
  };
}

function mapStage(line) {
  if (line.includes('k-mer hashtable finished')) return 'Aligning the control sample…';
  if (line.includes('Control sample alignment end')) return 'Aligning the Cas9-treated sample…';
  if (line.includes('Cas9 Mutation sample alignment end')) return 'Removing deletions common with the control…';
  if (line.includes('post process end')) return 'Writing the report…';
  return null;
}

// ---- the run ----

// job:
//   referenceFasta          one-line FASTA text, written as is
//   control1/2, treated1/2  paths to FASTQ files, plain or gzip
//   gene, sample            labels; they start the output file names
//   targetStart, targetEnd  1-based, inclusive
//   cleavage                offset from targetStart, not a coordinate
//   outDir                  where the core's output files are written
//   DEFAULTS keys           the options; missing ones take the default
// onProgress(message, fraction): fraction is 0..1, or null when unknown.
export async function runAnalysis(job, onProgress = () => {}) {
  const opt = { ...DEFAULTS, ...job };
  const t0 = Date.now();

  onProgress('Loading the analysis module…', 0);
  const CrisprLargeDel = require_(path.join(DOCS_DIR, 'kmer_align.js'));
  const wasmBinary = await fsp.readFile(path.join(DOCS_DIR, 'kmer_align.wasm'));

  let stdout = '';
  // A fresh module for every run: the C++ keeps state in globals it never resets.
  const Module = await CrisprLargeDel({
    wasmBinary,
    print: (line) => {
      stdout += line + '\n';
      const m = mapStage(line);
      if (m) onProgress(m, null);
    },
    printErr: (line) => { stdout += line + '\n'; }
  });

  const FS = Module.FS;
  FS.mkdir('/work');
  FS.mkdir('/out');

  // already a one-line record (see singleLineFasta in reference.mjs)
  FS.writeFile('/work/reference.fa', opt.referenceFasta);

  const inputs = [
    ['ctr_1.fastq', opt.control1, 'Control Read 1'],
    ['ctr_2.fastq', opt.control2, 'Control Read 2'],
    ['mut_1.fastq', opt.treated1, 'Cas9-treated Read 1'],
    ['mut_2.fastq', opt.treated2, 'Cas9-treated Read 2']
  ];

  let totalBytes = 0;
  for (const [, disk] of inputs) totalBytes += (await fsp.stat(disk)).size;
  let seen = 0, lastPost = 0;

  const staged = {};
  for (const [name, disk, label] of inputs) {
    staged[name] = await stageFile(FS, '/work/' + name, disk, label, (n) => {
      seen += n;
      const now = Date.now();
      if (now - lastPost > 250) {
        lastPost = now;
        const frac = Math.min(1, seen / (totalBytes || 1));
        onProgress(`Preparing input files… ${Math.round(frac * 100)}%`, frac * 0.15);
      }
    });
  }

  onProgress('Building the k-mer hash table…', 0.15);
  // The core takes a 0-based target start/end. The cleavage offset counts from the
  // target start, so it needs no change.
  // The arguments are the CLI's positional ones in order, less #15 out_fmt, which the
  // wasm entry point fixes to SAM: up to full_sam argument n is the CLI's #n, and from
  // min_gap on it is #(n + 1), so min_gap, the 15th here, is the CLI's #16.
  const rc = Module.ccall(
    'run_analysis', 'number',
    ['string', 'string', 'string', 'string', 'string',
     'number', 'number', 'number',
     'string', 'string', 'number', 'string', 'number', 'number',
     'number', 'number', 'number', 'number', 'number', 'number',
     'number', 'number', 'number'],
    ['/work/reference.fa', '/work/ctr_1.fastq', '/work/ctr_2.fastq',
     '/work/mut_1.fastq', '/work/mut_2.fastq',
     opt.targetStart - 1, opt.targetEnd - 1, opt.cleavage,
     opt.gene, opt.sample, opt.k, '/out',
     opt.distCut, opt.fullSam ? 1 : 0,
     opt.minGap, opt.anchorMin, opt.cutBetween ? 1 : 0,
     opt.insFix ? 1 : 0, opt.insMax, opt.report ? 1 : 0,
     opt.largeDelLen, opt.clipRescue ? 1 : 0,
     opt.commonMode === 'kmeans' ? 1 : 0]);

  if (rc !== 0) {
    const why = stdout.split('\n').filter((l) => /error/i.test(l)).join('\n');
    throw new Error('The analysis did not start (argument error).\n' + (why || stdout.slice(-2000)));
  }

  onProgress('Collecting results…', 0.95);
  await fsp.mkdir(opt.outDir, { recursive: true });

  const outputs = [];
  for (const name of FS.readdir('/out')) {
    if (name === '.' || name === '..') continue;
    let data = FS.readFile('/out/' + name);
    // The core writes its HTML report in Korean; docs/report-en.js puts it into English.
    if (name.endsWith('_report.html')) {
      data = Buffer.from(reportEn.translate(Buffer.from(data).toString('utf8')), 'utf8');
    }
    const dest = path.join(opt.outDir, name);
    await fsp.writeFile(dest, data);
    outputs.push({ name, bytes: data.length, path: dest });
  }
  outputs.sort((a, b) => a.name.localeCompare(b.name));

  const refLenM = stdout.match(/\[ref\] .*?: (\d+) bp/);

  return {
    stdout,
    metrics: parseMetrics(stdout),
    outputs,
    staged,
    refLen: refLenM ? +refLenM[1] : 0,
    elapsedMs: Date.now() - t0
  };
}
