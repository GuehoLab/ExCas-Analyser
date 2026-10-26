// Web worker: copies the input files into the core's in-memory filesystem, runs the
// WebAssembly analysis off the main thread and posts back the files it writes to /out.
// In:  { type:'run', params, files:{ref,ctr1,ctr2,mut1,mut2}, labels }
// Out: { type:'progress'|'done'|'error', … }; progress carries stage, frac (0..1 or
//      null), message and files { done, total, current, next } for the result files.
importScripts('kmer_align.js', 'vendor/fflate.min.js');

function post(type, payload) { self.postMessage(Object.assign({ type: type }, payload)); }

// Identify compressed input by its magic bytes rather than its name.
async function sniff(blob) {
  const h = new Uint8Array(await blob.slice(0, 6).arrayBuffer());
  if (h[0] === 0x1f && h[1] === 0x8b) return 'gzip';
  if (h[0] === 0x42 && h[1] === 0x5a && h[2] === 0x68) return 'bzip2';
  if (h[0] === 0xfd && h[1] === 0x37 && h[2] === 0x7a && h[3] === 0x58 && h[4] === 0x5a) return 'xz';
  if (h[0] === 0x28 && h[1] === 0xb5 && h[2] === 0x2f && h[3] === 0xfd) return 'zstd';
  return 'plain';
}

// Copy a file into the in-memory filesystem chunk by chunk, unzipping gzip on the way;
// other compression formats are rejected. onBytes(n) gets the input bytes read.
// Returns { bytes: bytes written, compressed: whether the input was gzip }.
async function stageFile(FS, path, blob, label, onBytes) {
  const kind = await sniff(blob);
  if (kind !== 'plain' && kind !== 'gzip') {
    throw new Error(label + ': ' + kind + ' compression is not supported in the browser. ' +
                    'Re-compress as gzip (.gz) or upload the file uncompressed.');
  }
  const stream = FS.open(path, 'w');
  let pos = 0;
  const write = (chunk) => {
    if (!chunk.length) return;
    FS.write(stream, chunk, 0, chunk.length, pos);
    pos += chunk.length;
  };
  let inflater = null;
  // fflate rather than DecompressionStream, which fails on multi-member gzip
  if (kind === 'gzip') inflater = new fflate.Gunzip((chunk) => write(chunk));

  const reader = blob.stream().getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (inflater) inflater.push(value, false); else write(value);
      onBytes(value.length);
    }
    if (inflater) inflater.push(new Uint8Array(0), true);
  } catch (e) {
    throw new Error(label + ': could not decompress (' + (e.message || e) + '). ' +
                    'The file may be corrupt or truncated.');
  } finally {
    FS.close(stream);
  }
  return { bytes: pos, compressed: kind === 'gzip' };
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (!msg || msg.type !== 'run') return;
  const { params, files, labels } = msg;

  try {
    let stdout = '';
    let watch = null;           // set once the core runs; see watchCore()
    const t0 = performance.now();

    post('progress', { stage: 'load', message: 'Loading analysis module…' });
    // A new module per run: the C++ core keeps state in globals it never resets.
    const Module = await CrisprLargeDel({
      print: (line) => {
        stdout += line + '\n';
        const stage = mapStage(line);
        if (stage && watch) watch.setStage(stage);
      },
      printErr: (line) => { stdout += line + '\n'; }
    });

    const FS = Module.FS;
    FS.mkdir('/work');
    FS.mkdir('/out');

    const names = {
      ref: 'reference.fa',
      ctr1: 'ctr_1.fastq', ctr2: 'ctr_2.fastq',
      mut1: 'mut_1.fastq', mut2: 'mut_2.fastq'
    };
    const total = Object.keys(names).reduce((a, k) => a + files[k].size, 0) || 1;
    let done = 0, lastPost = 0;
    const staged = {};
    for (const key of Object.keys(names)) {
      staged[key] = await stageFile(FS, '/work/' + names[key], files[key], labels[key], (n) => {
        done += n;
        const now = performance.now();
        if (now - lastPost > 120) {
          lastPost = now;
          post('progress', { stage: 'stage', frac: done / total,
                             message: 'Preparing input files… ' + Math.round(100 * done / total) + '%' });
        }
      });
      files[key] = null;
    }

    // The core reports only when a stage ends; watchCore() fills in between from its
    // file access, posting at most every 120 ms.
    const prefix = params.gene + '_' + params.sample;
    watch = watchCore(FS, expectedOutputs(prefix, params.report), (p) => {
      post('progress', { stage: p.stage, frac: p.frac, files: p.files,
                         message: progressMessage(p.stage, p.frac, p.files) });
    });
    watch.setStage('hash');

    // params are 1-based; the core takes a 0-based target start/end. The cleavage
    // offset is counted from the target start, so it needs no change.
    let rc;
    try {
      rc = Module.ccall(
        'run_analysis', 'number',
        ['string', 'string', 'string', 'string', 'string',
         'number', 'number', 'number',
         'string', 'string', 'number', 'string', 'number', 'number',
         'number', 'number', 'number', 'number', 'number', 'number',
         'number', 'number', 'number'],
        ['/work/' + names.ref, '/work/' + names.ctr1, '/work/' + names.ctr2,
         '/work/' + names.mut1, '/work/' + names.mut2,
         params.targetStart - 1, params.targetEnd - 1, params.cleavage,
         params.gene, params.sample, params.k, '/out',
         params.distCut, params.fullSam ? 1 : 0,
         params.minGap, params.anchorMin, params.cutBetween ? 1 : 0,
         params.insFix ? 1 : 0, params.insMax, params.report ? 1 : 0,
         params.largeDelLen, params.clipRescue ? 1 : 0,
         params.commonMode === 'kmeans' ? 1 : 0]);
    } finally {
      watch.stop();
    }

    if (rc !== 0) {
      // The core prints the reason; show its error lines, or the end of its output.
      const why = stdout.split('\n').filter((l) => /error/i.test(l)).join('\n');
      throw new Error('The analysis did not start (argument error).\n' + (why || stdout.slice(-2000)));
    }

    const out = {};
    const dec = new TextDecoder();
    const listed = FS.readdir('/out').filter((n) => n !== '.' && n !== '..');
    listed.forEach((name, i) => {
      post('progress', { stage: 'collect', frac: i / listed.length,
                         message: 'Collecting results (' + (i + 1) + '/' + listed.length + '): ' + name });
      const data = FS.readFile('/out/' + name);
      out[name] = { size: data.length, text: dec.decode(data) };
    });

    const refLenM = stdout.match(/\[ref\] .*?: (\d+) bp/);
    post('done', {
      stdout,
      metrics: parseMetrics(stdout),
      outputs: out,
      refLen: refLenM ? +refLenM[1] : 0,
      staged,
      elapsedMs: performance.now() - t0
    });
  } catch (err) {
    post('error', { message: String((err && err.message) || err) });
  }
};

// The stage that starts after a line of the core's log, or null.
function mapStage(line) {
  if (line.includes('k-mer hashtable finished')) return 'run';
  if (line.includes('Control sample alignment end')) return 'run2';
  if (line.includes('Cas9 Mutation sample alignment end')) return 'post';
  if (line.includes('post process end')) return 'report';
  return null;
}

// ---- progress inside the core ----
// run_analysis() is one blocking call, and the core prints only when a stage ends, so
// on its own the bar would sit still through each alignment and the report. Everything
// the core reads and writes goes through the in-memory filesystem, though: the read
// position in the stage's FASTQ files shows how far an alignment has got, and the
// files opened in /out show which result is being written.

// The FASTQ files each stage reads: the control's, then the treated sample's. The
// report reads all four again, one after another, to check insertions against the
// raw reads.
const STAGE_READS = {
  run:    ['ctr_1.fastq', 'ctr_2.fastq'],
  run2:   ['mut_1.fastq', 'mut_2.fastq'],
  report: ['ctr_1.fastq', 'ctr_2.fastq', 'mut_1.fastq', 'mut_2.fastq']
};

const STAGE_TEXT = {
  hash:   'Building the k-mer hash table…',
  run:    'Aligning the control sample…',
  run2:   'Aligning the Cas9-treated sample…',
  post:   'Removing deletions common with the control…',
  report: 'Writing results'
};

// The files the core writes to /out, in the order it writes them. full_sam, which the
// page always turns off, would add more; a file not listed here is counted when it opens.
function expectedOutputs(prefix, report) {
  const names = ['_site_ctr.sam', '_site_ctr_sm.sam', '_site_ctr_clip.sam',
                 '_site_mut.sam', '_site_mut_sm.sam', '_site_mut_clip.sam',
                 '_ctr_only.sam', '_ctr_common.sam', '_mut_only.sam', '_mut_common.sam',
                 '_mutation_summary.tsv'];
  if (report) names.push('_report.tsv', '_report.html');
  return names.map((s) => prefix + s);
}

// Wraps the filesystem's read, open and close to follow the core. onChange gets
// { stage, frac, files }: frac is the share of the stage's FASTQ bytes read (null for a
// stage that reads none); files is { done, total, current, next }, current being the
// result file open now or null, next the first expected one not yet written. Reads are reported at most every 120 ms, file opens and closes
// at once. Returns { setStage(stage), stop() }; stop() puts the filesystem back.
function watchCore(FS, expected, onChange) {
  const orig = { read: FS.read, open: FS.open, close: FS.close };
  const sizes = {};             // input path -> bytes
  Object.keys(STAGE_READS).forEach((s) => STAGE_READS[s].forEach((f) => {
    sizes['/work/' + f] = FS.stat('/work/' + f).size;
  }));
  let pos = {};                 // input path -> furthest position read in this stage
  const files = { done: 0, total: expected.length, current: null };
  const written = new Set();
  let stage = 'hash', last = 0;

  const frac = () => {
    const list = STAGE_READS[stage];
    if (!list) return null;
    let got = 0, all = 0;
    list.forEach((f) => { got += pos['/work/' + f] || 0; all += sizes['/work/' + f]; });
    return all ? Math.min(1, got / all) : null;
  };
  const emit = (now) => {
    last = now;
    const next = expected.filter((n) => !written.has(n))[0] || null;
    onChange({ stage: stage, frac: frac(),
               files: { done: files.done, total: files.total, current: files.current, next: next } });
  };

  // A result file: opened for writing in /out. The core's .ka_tmp. scratch files are
  // not results, and the empty summary it creates before the hash table is not counted.
  const resultName = (stream) => {
    if (stage === 'hash' || (stream.flags & 3) === 0) return null;
    const m = /^\/out\/([^/]+)$/.exec(stream.path || '');
    return m && !/\.ka_tmp\./.test(m[1]) ? m[1] : null;
  };

  FS.read = function (stream) {
    const n = orig.read.apply(this, arguments);
    const p = stream.path;
    if (sizes[p] !== undefined && stream.position > (pos[p] || 0)) {
      pos[p] = stream.position;
      const now = performance.now();
      if (now - last > 120) emit(now);
    }
    return n;
  };
  FS.open = function () {
    const stream = orig.open.apply(this, arguments);
    const name = resultName(stream);
    if (name) {
      if (expected.indexOf(name) < 0) { expected.push(name); files.total++; }
      files.current = name;
      emit(performance.now());
    }
    return stream;
  };
  FS.close = function (stream) {
    const name = resultName(stream);
    const r = orig.close.apply(this, arguments);
    if (name) {
      written.add(name);
      files.done = written.size;
      if (files.current === name) files.current = null;
      emit(performance.now());
    }
    return r;
  };

  return {
    setStage: (s) => { stage = s; pos = {}; emit(performance.now()); },
    stop: () => { FS.read = orig.read; FS.open = orig.open; FS.close = orig.close; }
  };
}

// The progress line. A result file being written is named with its count; otherwise
// the stage, with how far it has read. In the report stage, before its files are
// written, the core checks insertions against the raw reads, which takes a while; that
// is shown against the report file it is for.
function progressMessage(stage, frac, files) {
  const pct = frac == null ? '' : ' ' + Math.round(frac * 100) + '%';
  const count = 'Writing results (' + Math.min(files.done + 1, files.total) + '/' + files.total + '): ';
  if (files.current) return count + files.current;
  if (stage === 'report') {
    if (files.done >= files.total || !files.next) return 'Writing results (' + files.done + '/' + files.total + ')';
    return count + files.next +
           (frac != null && frac < 1 ? ' \u2014 checking insertions against the raw reads…' + pct : '');
  }
  return (STAGE_TEXT[stage] || '') + ((stage === 'run' || stage === 'run2') ? pct : '');
}

// The core prints its summary as text; read the numbers back out. total_align,
// total_read and alignment_rate are printed once per sample, control first. The
// patterns copy the core's wording, typos included.
function parseMetrics(stdout) {
  const num = (re) => { const m = stdout.match(re); return m ? parseFloat(m[1]) : null; };
  const all = (re) => [...stdout.matchAll(re)].map((m) => parseFloat(m[1]));

  const aligned = all(/total_align: (\d+)/g);
  const totals  = all(/total_read (\d+)/g);
  const rates   = all(/alignment_rate ([\d.]+)/g);

  // Clip rescue prints one line per sample that had terminal-clip pairs; the control's
  // comes before the end of its alignment.
  const split  = stdout.indexOf('Control sample alignment end');
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
