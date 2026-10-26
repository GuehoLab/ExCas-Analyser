// Web worker: copies the input files into the core's in-memory filesystem, runs the
// WebAssembly analysis off the main thread and posts back the files it writes to /out.
// In:  { type:'run', params, files:{ref,ctr1,ctr2,mut1,mut2}, labels }
// Out: { type:'progress'|'done'|'error', … }
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
    const t0 = performance.now();

    post('progress', { stage: 'load', message: 'Loading analysis module…' });
    // A new module per run: the C++ core keeps state in globals it never resets.
    const Module = await CrisprLargeDel({
      print: (line) => {
        stdout += line + '\n';
        const m = mapStage(line);
        if (m) post('progress', { stage: m.stage, message: m.message });
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

    post('progress', { stage: 'run', message: 'Building the k-mer hash table…' });
    // params are 1-based; the core takes a 0-based target start/end. The cleavage
    // offset is counted from the target start, so it needs no change.
    const rc = Module.ccall(
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

    if (rc !== 0) {
      // The core prints the reason; show its error lines, or the end of its output.
      const why = stdout.split('\n').filter((l) => /error/i.test(l)).join('\n');
      throw new Error('The analysis did not start (argument error).\n' + (why || stdout.slice(-2000)));
    }

    post('progress', { stage: 'collect', message: 'Collecting results…' });
    const out = {};
    const dec = new TextDecoder();
    for (const name of FS.readdir('/out')) {
      if (name === '.' || name === '..') continue;
      const data = FS.readFile('/out/' + name);
      out[name] = { size: data.length, text: dec.decode(data) };
    }

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

function mapStage(line) {
  if (line.includes('k-mer hashtable finished')) return { stage: 'run',    message: 'Aligning the control sample…' };
  if (line.includes('Control sample alignment end')) return { stage: 'run2', message: 'Aligning the Cas9-treated sample…' };
  if (line.includes('Cas9 Mutation sample alignment end')) return { stage: 'post', message: 'Removing deletions common with the control…' };
  if (line.includes('post process end')) return { stage: 'report', message: 'Writing the report…' };
  return null;
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
