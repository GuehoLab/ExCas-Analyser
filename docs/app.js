// app.js: the page controller. Drives the three views (input, progress, results):
// example data, input checks, target location, the analysis run and the result figures.

(function () {
  'use strict';

  console.log('[app.js] initialising…');

  // ---- DOM references ----
  var pages = {
    input:    document.getElementById('inputPage'),
    progress: document.getElementById('progressPage'),
    results:  document.getElementById('resultsPage')
  };

  // input form
  var form       = document.getElementById('analysisForm');
  var fileCtrR1  = document.getElementById('file-ctr-r1');
  var fileCtrR2  = document.getElementById('file-ctr-r2');
  var fileMutR1  = document.getElementById('file-mut-r1');
  var fileMutR2  = document.getElementById('file-mut-r2');
  var fullseqTA  = document.getElementById('fullseq');
  var refFileIn  = document.getElementById('reffile');
  var refLenSpan = document.getElementById('reflen');
  var rgenseqIn  = document.getElementById('rgenseq');
  var pamsSelect = document.getElementById('pams');
  var geneIn     = document.getElementById('genename');
  var sampleIn   = document.getElementById('samplename');
  var kIn        = document.getElementById('K');
  var cleIn      = document.getElementById('cle');
  var submitBtn  = document.getElementById('submit');
  var errDiv     = document.getElementById('errorAlert');
  var errList    = document.getElementById('errorAlertList');
  var demoNote   = document.getElementById('demo-note');

  // progress page
  var ctrBar    = document.getElementById('ctr-bar');
  var mutBar    = document.getElementById('mut-bar');
  var stageEl   = document.getElementById('stage');
  var cancelBtn = document.getElementById('cancelBtn');

  // results page
  var backBtn   = document.getElementById('backToInput');

  // target summary box on the progress page
  var summaryBox = document.getElementById('summary-box');
  var seqCtx     = document.getElementById('seqctx');

  // Warn at load time about any element the page is missing.
  var _critical = {submitBtn:submitBtn, errDiv:errDiv, demoNote:demoNote,
                   fullseqTA:fullseqTA, rgenseqIn:rgenseqIn, geneIn:geneIn,
                   sampleIn:sampleIn, pamsSelect:pamsSelect, kIn:kIn, cleIn:cleIn};
  Object.keys(_critical).forEach(function (k) {
    if (!_critical[k]) console.warn('[app.js] missing DOM element:', k);
  });

  // run state
  var client        = null;
  var lastRun       = null;   // the worker's 'done' payload for the last run
  var refSequence   = '';
  var _exampleFiles = null;  // the loaded example's files; null once the user picks a file

  function numOpt(id, fallback) {
    var el = document.getElementById(id);
    if (!el) return fallback;
    var raw = String(el.value).trim();
    if (raw === '') return fallback;
    var v = parseInt(raw, 10);
    return isNaN(v) ? fallback : v;
  }

  function boolOpt(id, fallback) {
    var el = document.getElementById(id);
    return el ? !!el.checked : fallback;
  }

  function setBar(bar, pct) {
    if (!bar) return;
    var p = Math.max(0, Math.min(100, Math.round(pct)));
    bar.style.width = p + '%';
    bar.textContent = p + '%';
    if (p >= 100) bar.classList.remove('progress-bar-animated');
    else bar.classList.add('progress-bar-animated');
  }

  // ---- page navigation ----
  function showPage(name) {
    Object.keys(pages).forEach(function (k) {
      if (pages[k]) pages[k].classList.toggle('active', k === name);
    });
    window.scrollTo(0, 0);
  }

  // ---- error alert ----
  // msgs: a string or an array of strings.
  function showError(msgs) {
    var list = (msgs instanceof Array) ? msgs : [msgs];
    console.error('[app.js] showError:', list.join(' | '));
    if (!errDiv) return;

    if (errList) {
      errList.innerHTML = '';
      list.forEach(function (m) {
        var li = document.createElement('li');
        li.textContent = m;
        errList.appendChild(li);
      });
    } else {
      errDiv.textContent = list.join(' ');
    }
    errDiv.classList.remove('d-none');

    // Submit is at the bottom of a long form, so the alert at the top would be off-screen.
    // Scroll to it on the next frame, once the page has resized, leaving room for the
    // sticky navbar.
    var NAV_H = 72;
    requestAnimationFrame(function () {
      var top = errDiv.getBoundingClientRect().top + window.pageYOffset - NAV_H;
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      if (errDiv.focus) errDiv.focus({ preventScroll: true });
    });
  }

  function clearError() {
    if (errDiv) errDiv.classList.add('d-none');
    if (errList) errList.innerHTML = '';
  }

  // ---- file inputs ----
  function wireDropZone(inputEl) {
    if (!inputEl) return;
    var box = inputEl.closest('.file-box');
    if (!box) return;
    var nameEl = box.querySelector('.file-name');

    ['dragenter', 'dragover'].forEach(function (ev) {
      box.addEventListener(ev, function (e) { e.preventDefault(); box.classList.add('drag-over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      box.addEventListener(ev, function (e) { e.preventDefault(); box.classList.remove('drag-over'); });
    });
    box.addEventListener('drop', function (e) {
      if (e.dataTransfer.files.length) {
        inputEl.files = e.dataTransfer.files;
        inputEl.dispatchEvent(new Event('change'));
      }
    });
    inputEl.addEventListener('change', function () {
      if (inputEl.files.length && nameEl) {
        nameEl.textContent = inputEl.files[0].name + ' (' +
          (inputEl.files[0].size / 1024).toFixed(1) + ' KB)';
      } else if (nameEl) {
        nameEl.textContent = '';
      }
    });
  }
  wireDropZone(fileCtrR1);
  wireDropZone(fileCtrR2);
  wireDropZone(fileMutR1);
  wireDropZone(fileMutR2);

  // Reference upload. Read as bytes so a .gz file can be unzipped first; read as text it
  // would fill the box with binary noise.
  if (refFileIn) {
    refFileIn.addEventListener('change', function () {
      if (!refFileIn.files.length) return;
      var file = refFileIn.files[0];
      var reader = new FileReader();

      reader.onload = function () {
        var bytes = new Uint8Array(reader.result);
        var text;
        try {
          text = decodeReference(bytes, file.name);
        } catch (e) {
          showError(e.message);
          refFileIn.value = '';
          return;
        }
        clearError();
        setReferenceText(text);
      };
      reader.onerror = function () { showError('Could not read ' + file.name + '.'); };
      reader.readAsArrayBuffer(file);
    });
  }

  // Detects compression by magic bytes, as the worker's sniff() does: gzip is unzipped,
  // bzip2, xz and zstd are refused with a message.
  function decodeReference(bytes, name) {
    var dec = new TextDecoder();
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      if (typeof fflate === 'undefined' || !fflate.gunzipSync) {
        throw new Error(name + ' is gzipped, but the decompressor could not be loaded.');
      }
      try {
        return dec.decode(fflate.gunzipSync(bytes));
      } catch (e) {
        throw new Error(name + ': could not decompress (' + (e.message || e) + ').');
      }
    }
    if (bytes[0] === 0x42 && bytes[1] === 0x5a && bytes[2] === 0x68) {
      throw new Error(name + ': bzip2 is not supported. Use gzip (.gz) or an uncompressed FASTA.');
    }
    if (bytes[0] === 0xfd && bytes[1] === 0x37 && bytes[2] === 0x7a) {
      throw new Error(name + ': xz is not supported. Use gzip (.gz) or an uncompressed FASTA.');
    }
    if (bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd) {
      throw new Error(name + ': zstd is not supported. Use gzip (.gz) or an uncompressed FASTA.');
    }
    return dec.decode(bytes);
  }

  function setReferenceText(text) {
    var seq = parseFasta(text);
    if (fullseqTA) fullseqTA.value = seq;
    refSequence = seq;
    if (refLenSpan) {
      var extra = countFastaRecords(text) - 1;
      refLenSpan.textContent = seq.length.toLocaleString() + ' bp' +
        (extra > 0 ? ' (first record only; ' + extra + ' more ignored)' : '');
    }
  }

  function countFastaRecords(text) {
    var n = 0;
    String(text).split(/\r?\n/).forEach(function (l) { if (l.charAt(0) === '>') n++; });
    return n || 1;
  }

  if (fullseqTA) {
    fullseqTA.addEventListener('input', function () {
      var seq = parseFasta(fullseqTA.value);
      refSequence = seq;
      if (refLenSpan) refLenSpan.textContent = seq.length ? seq.length.toLocaleString() + ' bp' : '';
    });
  }

  // The first record's sequence, uppercased, whitespace removed. Stops at the second '>':
  // the core only uses the first record.
  function parseFasta(text) {
    var out = [], started = false;
    var lines = String(text).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (l.charAt(0) === ';') continue;              // FASTA comment line
      if (l.charAt(0) === '>') {
        if (started) break;                           // second record: stop
        started = true;
        continue;
      }
      if (!l.trim()) continue;
      out.push(l);
      started = true;                                 // bare sequence, no header
    }
    return out.join('').replace(/\s+/g, '').toUpperCase();
  }

  // ---- target location and cleavage site ----
  // st, ed and cut are 1-based reference positions. `cut` is the first base after the cut,
  // whichever strand the target is on; the ▼ is drawn before it.
  // cle = cut − st is an offset, not a position: 3 for a 20-nt NGG guide on the minus
  // strand, 17 on the plus strand.
  // The core takes 0-based start/end; worker.js passes st − 1, ed − 1 and cle unchanged.
  // The PAM must match the reference, and a target found at more than one site is an error.

  var IUPAC = { A:'A', C:'C', G:'G', T:'T',
    R:'AG', Y:'CT', S:'CG', W:'AT', K:'GT', M:'AC',
    B:'CGT', D:'AGT', H:'ACT', V:'ACG', N:'ACGT' };

  function revcomp(s) {
    var m = { A:'T', C:'G', G:'C', T:'A', N:'N' }, o = '';
    for (var i = s.length - 1; i >= 0; i--) o += (m[s[i]] || 'N');
    return o;
  }

  function matchIUPAC(seq, pattern) {
    if (seq.length !== pattern.length) return false;
    for (var i = 0; i < pattern.length; i++) {
      var allowed = IUPAC[pattern[i]];
      if (!allowed || allowed.indexOf(seq[i]) < 0) return false;
    }
    return true;
  }

  function findAll(hay, needle) {
    var out = [], i = hay.indexOf(needle);
    while (i >= 0) { out.push(i); i = hay.indexOf(needle, i + 1); }
    return out;
  }

  // Returns {st, ed, strand, pam, cut, cle} with st/ed/cut 1-based. side: 3 or 5 when the
  // PAM sits 3' or 5' of the protospacer, 0 for no PAM.
  function locateTarget(ref, target, pam, side, cutOff) {
    var hits = [];
    findAll(ref, target).forEach(function (i) { hits.push({ i: i, strand: '+' }); });
    var rc = revcomp(target);
    if (rc !== target) findAll(ref, rc).forEach(function (i) { hits.push({ i: i, strand: '-' }); });
    if (!hits.length) throw new Error('Target sequence not found in the reference (searched both strands).');

    var L = target.length, P = pam ? pam.length : 0, ok = [];
    hits.forEach(function (h) {
      var s = h.i + 1, e = h.i + L, pamSeq = null, valid = !pam;
      if (pam) {
        // on the minus strand the PAM lies on the other side in reference coordinates,
        // reverse-complemented
        var pamAtRight = (side === 3) === (h.strand === '+');
        if (pamAtRight) {
          pamSeq = ref.substr(e, P);
          if (pamSeq.length === P) valid = matchIUPAC(h.strand === '+' ? pamSeq : revcomp(pamSeq), pam);
        } else {
          pamSeq = ref.substr(s - 1 - P, P);
          if (pamSeq.length === P) valid = matchIUPAC(h.strand === '+' ? pamSeq : revcomp(pamSeq), pam);
        }
      }
      if (valid) ok.push({ s: s, e: e, strand: h.strand, pam: pamSeq });
    });

    if (pam && !ok.length)
      throw new Error('The target sequence was found, but no adjacent ' + pam +
        ' PAM matches. Check the PAM selection, or choose "No PAM" and set the cleavage offset manually.');
    if (ok.length > 1)
      throw new Error('The target sequence occurs at ' + ok.length +
        ' positions in the reference. Narrow the reference or use a longer target.');

    var h2 = ok.length ? ok[0] : { s: hits[0].i + 1, e: hits[0].i + L, strand: hits[0].strand, pam: null };
    // The cut is cutOff bases in from the PAM end of the protospacer. First base after it:
    // s + cutOff when the PAM is on the left, e − cutOff + 1 when it is on the right.
    var cut = null;
    if (cutOff !== null && cutOff !== undefined && side !== 0) {
      if (side === 3) cut = (h2.strand === '+') ? h2.e - cutOff + 1 : h2.s + cutOff;
      else            cut = (h2.strand === '+') ? h2.s + cutOff : h2.e - cutOff + 1;
    }
    return { st: h2.s, ed: h2.e, strand: h2.strand, pam: h2.pam,
             cut: cut, cle: cut === null ? null : cut - h2.s };
  }

  // The selected PAM, the end it sits on and its cleavage offset, from the option's
  // data-side and data-cut.
  function pamSettings() {
    var opt = pamsSelect ? pamsSelect.selectedOptions[0] : null;
    if (!opt) return { pam: '', side: 0, cutOff: null };
    return {
      pam:    opt.value,
      side:   parseInt(opt.dataset.side, 10),
      cutOff: opt.dataset.cut === '' ? null : parseInt(opt.dataset.cut, 10)
    };
  }

  // locateTarget() plus the manual cleavage-offset override. Throws on any problem.
  function resolveLocation(ref, target) {
    var ps  = pamSettings();
    var loc = locateTarget(ref, target, ps.pam, ps.side, ps.cutOff);
    loc.pamSide = ps.side;

    var manual = cleIn ? String(cleIn.value).trim() : '';
    if (manual !== '') {
      loc.cle = parseInt(manual, 10);
      loc.cut = loc.st + loc.cle;        // the field is an offset from st, not a position
    }
    if (loc.cle === null || isNaN(loc.cle)) {
      throw new Error('The cleavage site could not be derived. Enter a cleavage offset manually.');
    }
    return loc;
  }

  // ---- input validation ----

  // .gz is unzipped in the worker; bzip2, xz and zstd are refused there.
  var FASTQ_EXT = ['.fastq', '.fq', '.fastq.gz', '.fq.gz', '.gz'];

  function hasExt(name, exts) {
    var lower = String(name || '').toLowerCase();
    for (var i = 0; i < exts.length; i++) {
      if (lower.slice(-exts[i].length) === exts[i]) return true;
    }
    return false;
  }

  // Returns null if the file is an acceptable FASTQ, else a message.
  function fastqProblem(file, label) {
    if (!file) return label + ': no file selected.';
    if (!hasExt(file.name, FASTQ_EXT)) {
      return label + ': "' + file.name + '" is not a FASTQ file. ' +
             'Accepted extensions are .fastq, .fq and their .gz forms.';
    }
    if (file.size === 0) {
      return label + ': "' + file.name + '" is empty (0 bytes).';
    }
    return null;
  }

  // Checks a file as soon as it is chosen. accept="" only filters the file picker; it does
  // not stop drag-and-drop or "All files".
  function wireFileTypeGuard(inputEl, label) {
    if (!inputEl) return;
    inputEl.addEventListener('change', function () {
      // a manual selection replaces any example data that was loaded
      if (inputEl.files.length) _exampleFiles = null;

      if (!inputEl.files.length) return;
      var problem = fastqProblem(inputEl.files[0], label);
      if (problem) {
        showError(problem);
        inputEl.value = '';
        var box = inputEl.closest('.file-box');
        var nameEl = box ? box.querySelector('.file-name') : null;
        if (nameEl) nameEl.textContent = '';
      } else {
        clearError();
      }
    });
  }
  wireFileTypeGuard(fileCtrR1, 'Control Read 1');
  wireFileTypeGuard(fileCtrR2, 'Control Read 2');
  wireFileTypeGuard(fileMutR1, 'Cas9-treated Read 1');
  wireFileTypeGuard(fileMutR2, 'Cas9-treated Read 2');

  // The distinct characters in seq other than A, T, C, G and N. Expects whitespace already
  // stripped.
  function badBases(seq) {
    var bad = {};
    for (var i = 0; i < seq.length; i++) {
      if ('ATCGN'.indexOf(seq[i]) < 0) bad[seq[i]] = true;
    }
    return Object.keys(bad);
  }

  function intProblem(el, label, min, max) {
    if (!el) return null;
    var raw = String(el.value || '').trim();
    if (raw === '') return null;                       // blank = use default
    if (!/^[+-]?\d+$/.test(raw)) return label + ' must be a whole number.';
    var v = parseInt(raw, 10);
    if (v < min || v > max) {
      return label + ' must be between ' + min + ' and ' + max + ' (got ' + v + ').';
    }
    return null;
  }

  // Collects every problem at once, so they can be fixed in one go. An empty list means
  // the inputs are usable.
  function validateInputs() {
    var errs = [];

    // files
    var picks = _exampleFiles ? [
      { f: _exampleFiles.ctrR1, label: 'Control Read 1' },
      { f: _exampleFiles.ctrR2, label: 'Control Read 2' },
      { f: _exampleFiles.mutR1, label: 'Cas9-treated Read 1' },
      { f: _exampleFiles.mutR2, label: 'Cas9-treated Read 2' }
    ] : [
      { f: fileCtrR1 && fileCtrR1.files[0], label: 'Control Read 1' },
      { f: fileCtrR2 && fileCtrR2.files[0], label: 'Control Read 2' },
      { f: fileMutR1 && fileMutR1.files[0], label: 'Cas9-treated Read 1' },
      { f: fileMutR2 && fileMutR2.files[0], label: 'Cas9-treated Read 2' }
    ];

    var missing = picks.filter(function (p) { return !p.f; });
    if (missing.length === picks.length) {
      errs.push('No FASTQ files selected. Upload paired reads for both the ' +
                'control and the Cas9-treated sample, or click "Load example".');
    } else {
      picks.forEach(function (p) {
        var problem = fastqProblem(p.f, p.label);
        if (problem) errs.push(problem);
      });
    }

    // sequences
    var seq    = refSequence || (fullseqTA ? parseFasta(fullseqTA.value) : '');
    var target = rgenseqIn ? parseFasta(rgenseqIn.value) : '';

    if (!seq) {
      errs.push('Full reference sequence is required.');
    } else {
      var badRef = badBases(seq);
      if (badRef.length) {
        errs.push('Reference sequence contains invalid characters: ' +
                  badRef.join(', ') + '. Only A, T, C, G and N are allowed.');
      }
    }

    if (!target) {
      errs.push('Target DNA sequence (protospacer) is required.');
    } else {
      var badTgt = badBases(target);
      if (badTgt.length) {
        errs.push('Target DNA sequence contains invalid characters: ' +
                  badTgt.join(', ') + '. Only A, T, C, G and N are allowed.');
      } else if (target.length < 10) {
        errs.push('Target DNA sequence is too short (' + target.length +
                  ' bp); a protospacer is normally 17–25 bp.');
      }
    }

    // Once both sequences are valid, run the same target search the run uses, so PAM and
    // cut-site problems show here, not mid-run.
    if (seq && target && !badBases(seq).length && !badBases(target).length) {
      try {
        var loc = resolveLocation(seq, target);
        if (loc.cut !== null && (loc.cut < 1 || loc.cut > seq.length)) {
          errs.push('The cleavage site derived from this offset falls at ' +
                    loc.cut + ', outside the ' + seq.length.toLocaleString() +
                    ' bp reference.');
        }
      } catch (e) {
        errs.push(e.message);
      }
    }

    if (geneIn && !geneIn.value.trim())   errs.push('Gene name is required.');
    if (sampleIn && !sampleIn.value.trim()) errs.push('Sample name is required.');

    // numeric options
    var kErr = intProblem(kIn, 'k-mer size (K)', 7, 16);
    if (kErr) errs.push(kErr);

    // The offset may be negative. Whether the cut lands inside the reference is checked
    // above.
    var cleRaw = cleIn ? String(cleIn.value).trim() : '';
    if (cleRaw !== '' && !/^[+-]?\d+$/.test(cleRaw)) {
      errs.push('Cleavage offset must be a whole number.');
    }

    return errs;
  }

  // ---- example data: the bundled HPRT1 set, or a synthetic one ----

  // The bundled example is a simulated HPRT1 amplicon.
  var EXAMPLE = {
    gene:   'HPRT1',
    sample: 'SIM',
    target: 'AGCCCCCCTTGAGCACACAG',   // sgRNA spacer, minus strand, NGG PAM
    // synthetic fallback only: target + pam go on the plus strand, with the cut before
    // 0-based index `cut`
    pam:    'TGG',
    cut:    4654,
    refLen: 9411
  };

  // ---- synthetic fallback ----
  // If testdata/ cannot be fetched (not deployed, or opened over file://), a small example
  // is built in memory instead and labelled as synthetic. Fixed seeds give the same data
  // every time.

  // mulberry32: a small seeded PRNG returning floats in [0, 1).
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function synthReference(rnd) {
    var B = 'ACGT', out = [];
    for (var i = 0; i < EXAMPLE.refLen; i++) out.push(B[(rnd() * 4) | 0]);
    // Place protospacer + PAM so the cut falls 3 bases before the PAM, just before
    // 0-based index EXAMPLE.cut.
    var site = EXAMPLE.cut - (EXAMPLE.target.length - 3);
    var ins  = EXAMPLE.target + EXAMPLE.pam;
    for (var j = 0; j < ins.length; j++) out[site + j] = ins[j];
    return out.join('');
  }

  function fq(name, seq) {
    return '@' + name + '\n' + seq + '\n+\n' + new Array(seq.length + 1).join('I') + '\n';
  }

  // Paired-end 150 bp reads from 300–499 bp fragments around the cut. A fraction `ldFrac`
  // of the pairs carry a large deletion across the cut. Returns [R1 text, R2 text].
  function synthSample(ref, prefix, nPairs, ldFrac, rnd) {
    var READ = 150, r1 = [], r2 = [];
    for (var i = 0; i < nPairs; i++) {
      var frag = 300 + ((rnd() * 200) | 0);
      var seq  = ref;
      var start;

      if (rnd() < ldFrac) {
        // large deletion: 200–1999 bp, starting up to 119 bp before the cut, so it always
        // spans the cut
        var delLen = 200 + ((rnd() * 1800) | 0);
        var delSt  = EXAMPLE.cut - ((rnd() * 120) | 0);
        seq = ref.slice(0, delSt) + ref.slice(delSt + delLen);
        start = Math.max(0, delSt - frag + READ + ((rnd() * 40) | 0));
      } else {
        start = Math.max(0, EXAMPLE.cut - frag + ((rnd() * frag) | 0));
      }
      if (start + frag > seq.length) start = Math.max(0, seq.length - frag);

      var fwd = seq.substr(start, READ);
      var rev = revcomp(seq.substr(start + frag - READ, READ));
      if (fwd.length < READ || rev.length < READ) continue;

      var nm = prefix + ':' + (i + 1);
      r1.push(fq(nm, fwd));
      r2.push(fq(nm, rev));
    }
    return [r1.join(''), r2.join('')];
  }

  function buildSyntheticExample() {
    var rnd = mulberry32(20260928);
    var ref = synthReference(rnd);
    var con = synthSample(ref, 'con', 2000, 0.01, mulberry32(1));
    var mut = synthSample(ref, 'mut', 2000, 0.18, mulberry32(2));
    var g   = EXAMPLE.gene;

    function mk(text, name) {
      return new File([new Blob([text], { type: 'text/plain' })], name,
                      { type: 'text/plain' });
    }
    return {
      ref:   mk('>' + g + '\n' + ref + '\n', g + '.fa'),
      ctrR1: mk(con[0], g + '_con_1.fastq'),
      ctrR2: mk(con[1], g + '_con_2.fastq'),
      mutR1: mk(mut[0], g + '_mut_1.fastq'),
      mutR2: mk(mut[1], g + '_mut_2.fastq'),
      synthetic: true
    };
  }

  // Fetches the bundled example. On any failure it resolves to the synthetic one instead;
  // it never rejects.
  function fetchExample(gene) {
    var base = 'testdata/' + gene + '/';
    // Reads are gzipped, like a real .fastq.gz upload. The reference is plain text, read
    // straight into the sequence box.
    var want = [
      { url: base + gene + '.fa',             key: 'ref'   },
      { url: base + gene + '_con_1.fastq.gz', key: 'ctrR1' },
      { url: base + gene + '_con_2.fastq.gz', key: 'ctrR2' },
      { url: base + gene + '_mut_1.fastq.gz', key: 'mutR1' },
      { url: base + gene + '_mut_2.fastq.gz', key: 'mutR2' }
    ];

    if (typeof fetch !== 'function' || location.protocol === 'file:') {
      console.warn('[app.js] cannot fetch example data over ' + location.protocol +
                   ' — generating a synthetic dataset instead');
      return Promise.resolve(buildSyntheticExample());
    }

    return Promise.all(want.map(function (f) {
      return fetch(f.url).then(function (resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status + ' for ' + f.url);
        return resp.blob();
      }).then(function (blob) {
        if (!blob.size) throw new Error('empty file: ' + f.url);
        return { key: f.key, file: new File([blob], f.url.split('/').pop(),
                                            { type: 'text/plain' }) };
      });
    })).then(function (parts) {
      var out = { synthetic: false };
      parts.forEach(function (p) { out[p.key] = p.file; });
      return out;
    }).catch(function (err) {
      console.warn('[app.js] example fetch failed (' + err.message +
                   ') — generating a synthetic dataset instead');
      return buildSyntheticExample();
    });
  }

  // Puts the example files into the file inputs, so the form shows what will run. Returns
  // false if the browser cannot set an input's files.
  function injectFiles(loaded) {
    var map = [
      [fileCtrR1, loaded.ctrR1], [fileCtrR2, loaded.ctrR2],
      [fileMutR1, loaded.mutR1], [fileMutR2, loaded.mutR2]
    ];
    var ok = typeof DataTransfer === 'function';
    map.forEach(function (pair) {
      var input = pair[0], file = pair[1];
      if (!input || !file) return;
      if (ok) {
        try {
          var dt = new DataTransfer();
          dt.items.add(file);
          input.files = dt.files;
        } catch (e) { ok = false; }
      }
      input.dispatchEvent(new Event('change'));
    });
    // Set after dispatching, because the change handler clears it. The run reads the
    // example from here, not from the file inputs.
    _exampleFiles = loaded;
    return ok;
  }

  // ---- example buttons ----

  // Loads the example into the form, ready to submit. It does not start the run.
  function runAction(gene, sample, target) {
    gene   = gene   || EXAMPLE.gene;
    sample = sample || EXAMPLE.sample;
    target = target || EXAMPLE.target;

    clearError();
    if (demoNote) demoNote.textContent = 'Loading example data…';
    if (submitBtn) submitBtn.disabled = true;

    return fetchExample(gene).then(function (loaded) {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () {
          var seq = parseFasta(reader.result);
          console.log('[app.js] example reference length:', seq.length);

          if (fullseqTA)  fullseqTA.value = seq;
          refSequence = seq;
          if (refLenSpan) refLenSpan.textContent = seq.length.toLocaleString() + ' bp';

          injectFiles(loaded);

          if (geneIn)    geneIn.value    = gene;
          if (sampleIn)  sampleIn.value  = sample;
          if (rgenseqIn) rgenseqIn.value = target;

          if (demoNote) {
            demoNote.textContent = loaded.synthetic
              ? 'Synthetic example loaded ✓ (bundled data unavailable)'
              : 'Example loaded ✓';
          }
          if (submitBtn) submitBtn.disabled = false;
          resolve(loaded);
        };
        reader.onerror = function () {
          reject(new Error('could not read the example reference FASTA'));
        };
        reader.readAsText(loaded.ref);
      });
    }).catch(function (err) {
      showError('Failed to load example data: ' + err.message);
      if (demoNote) demoNote.textContent = '';
      if (submitBtn) submitBtn.disabled = false;
      throw err;
    });
  }

  // Downloads the five example files, a quarter-second apart.
  function downloadAction(gene) {
    gene = gene || EXAMPLE.gene;
    clearError();
    if (demoNote) demoNote.textContent = 'Preparing example download…';

    return fetchExample(gene).then(function (loaded) {
      ['ref', 'ctrR1', 'ctrR2', 'mutR1', 'mutR2'].forEach(function (k, i) {
        if (loaded[k]) setTimeout(function () { saveBlob(loaded[k], loaded[k].name); }, i * 250);
      });
      if (demoNote) {
        demoNote.textContent = loaded.synthetic
          ? 'Downloading 5 synthetic example files…'
          : 'Downloading 5 example files…';
      }
      return loaded;
    }).catch(function (err) {
      showError('Failed to prepare the example download: ' + err.message);
      if (demoNote) demoNote.textContent = '';
      throw err;
    });
  }

  var exButtons = document.querySelectorAll('.ex');
  var dlButtons = document.querySelectorAll('.ex-dl');
  console.log('[app.js] found', exButtons.length, 'example button(s),',
              dlButtons.length, 'download button(s)');

  Array.prototype.forEach.call(exButtons, function (btn) {
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      runAction(btn.dataset.gene, btn.dataset.sample, btn.dataset.target)
        .catch(function () {});
    });
  });

  Array.prototype.forEach.call(dlButtons, function (btn) {
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      downloadAction(btn.dataset.gene).catch(function () {});
    });
  });

  // ---- submit: validate and start the analysis ----
  // Starts a run. Returns false if the inputs failed validation. Also exposed as
  // window.main() for the tests.
  function main() {
    console.log('[app.js] Submit clicked');
    clearError();

    // Check everything first; stay on the input page if anything is wrong.
    var problems = validateInputs();
    if (problems.length) {
      showError(problems);
      return false;
    }

    {
      var seq    = refSequence;
      var target = rgenseqIn ? rgenseqIn.value.trim().toUpperCase() : '';
      var gene   = geneIn ? geneIn.value.trim() : '';
      var sample = sampleIn ? sampleIn.value.trim() : '';
      var K      = kIn ? (parseInt(kIn.value) || 11) : 11;

      // files come from the loaded example if there is one, else from the file inputs
      var ctrR1, ctrR2, mutR1, mutR2, rFile;
      if (_exampleFiles) {
        ctrR1 = _exampleFiles.ctrR1;
        ctrR2 = _exampleFiles.ctrR2;
        mutR1 = _exampleFiles.mutR1;
        mutR2 = _exampleFiles.mutR2;
        rFile = _exampleFiles.ref;
      } else {
        ctrR1 = fileCtrR1 && fileCtrR1.files[0] ? fileCtrR1.files[0] : null;
        ctrR2 = fileCtrR2 && fileCtrR2.files[0] ? fileCtrR2.files[0] : null;
        mutR1 = fileMutR1 && fileMutR1.files[0] ? fileMutR1.files[0] : null;
        mutR2 = fileMutR2 && fileMutR2.files[0] ? fileMutR2.files[0] : null;
        rFile = refFileIn && refFileIn.files[0]  ? refFileIn.files[0] : null;
      }

      // validateInputs() has already checked that this resolves
      var loc = resolveLocation(seq, target);

      // 1-based; worker.js converts st and ed to the core's 0-based form.
      var st  = loc.st;
      var ed  = loc.ed;
      var cle = loc.cle;

      // The reference always goes to the core as a one-line FASTA of `seq` (first record
      // only), the sequence the target was located in, not the uploaded file.
      rFile = new File([new Blob(['>' + gene + '\n' + seq + '\n'], { type: 'text/plain' })],
                       gene + '.fa', { type: 'text/plain' });

      console.log('[app.js] starting analysis: gene=%s st=%d ed=%d cle=%d K=%d', gene, st, ed, cle, K);

      showPage('progress');
      if (ctrBar) { ctrBar.style.width = '0%'; ctrBar.textContent = '0%'; }
      if (mutBar) { mutBar.style.width = '0%'; mutBar.textContent = '0%'; }
      if (stageEl) stageEl.textContent = 'Preparing…';
      fillSummary(seq, loc, K);
      lastRun = null;

      // Options are the core's CLI arguments #13–#22, falling back to its defaults. #15
      // (output format) is fixed to SAM by the wasm entry point.
      var params = {
        gene:        gene,
        sample:      sample,
        targetStart: st,
        targetEnd:   ed,
        cleavage:    cle,
        k:           K,
        distCut:     numOpt('distCut', 1000),
        // always off: the full alignment SAM is too large to hold in a browser tab
        fullSam:     false,
        minGap:      numOpt('minGap', 400),
        anchorMin:   numOpt('anchorMin', 13),
        cutBetween:  boolOpt('cutBetween', true),
        insFix:      boolOpt('insFix', true),
        insMax:      numOpt('insMax', 0),
        report:      boolOpt('report', true),
        largeDelLen: numOpt('largeDelLen', 100)
      };

      // Passed as File objects; the worker reads and unzips them. labels name each file in
      // error messages.
      var files = { ref: rFile, ctr1: ctrR1, ctr2: ctrR2, mut1: mutR1, mut2: mutR2 };
      var labels = {
        ref:  'Reference FASTA (' + rFile.name + ')',
        ctr1: 'Control Read 1 (' + ctrR1.name + ')',
        ctr2: 'Control Read 2 (' + ctrR2.name + ')',
        mut1: 'Cas9-treated Read 1 (' + mutR1.name + ')',
        mut2: 'Cas9-treated Read 2 (' + mutR2.name + ')'
      };

      console.log('[app.js] starting analysis', params);

      client = new AnalysisClient({
        onProgress: function (pct, message) {
          // Both samples run in one call: the control bar shows the first half of the
          // progress, the treated bar the second.
          var p = Math.max(0, Math.min(100, pct));
          setBar(ctrBar, Math.min(100, p * 2));
          setBar(mutBar, Math.max(0, (p - 50) * 2));
          if (stageEl) stageEl.textContent = message || '';
        },
        onDone: function (result) {
          console.log('[app.js] analysis complete in', (result.elapsedMs / 1000).toFixed(1), 's');
          setBar(ctrBar, 100); setBar(mutBar, 100);
          if (stageEl) stageEl.textContent = 'Done!';
          lastRun = result;
          finishResults(result, params);
        },
        onError: function (msg) {
          showError('Analysis error: ' + msg);
          if (submitBtn) submitBtn.disabled = false;
          showPage('input');
        }
      });

      client.start(params, files, labels);
    }
    return true;
  }

  if (submitBtn) submitBtn.addEventListener('click', function () { main(); });

  // Enter in a text field submits the form; route that to main() too, instead of letting
  // the browser reload the page.
  if (form) {
    form.addEventListener('submit', function (e) { e.preventDefault(); main(); });
  }

  // ---- cancel and back buttons ----
  if (cancelBtn) {
    cancelBtn.addEventListener('click', function () {
      if (client) client.cancel();
      showPage('input');
    });
  }

  if (backBtn) {
    backBtn.addEventListener('click', function () {
      showPage('input');
      _exampleFiles = null;
      if (demoNote) demoNote.textContent = '';
    });
  }

  // ---- target summary (progress page) ----
  // Shows the 1-based coordinates and the cut with its offset, and the target ±40 bp with
  // the target and PAM highlighted and a ▼ before the cut base.
  function fillSummary(seq, loc, K) {
    if (summaryBox) summaryBox.classList.remove('d-none');

    var setEl = function (id, text) {
      var el = document.getElementById(id);
      if (el) el.textContent = text;
    };
    setEl('s-reflen', seq.length.toLocaleString() + ' bp');
    setEl('s-pos',    loc.st.toLocaleString() + '–' + loc.ed.toLocaleString());
    setEl('s-strand', loc.strand === '+' ? '+ (forward)' : '− (reverse)');
    setEl('s-pam',    loc.pam || '–');
    setEl('s-cut',    loc.cut === null ? '–'
                      : loc.cut.toLocaleString() + ' (offset ' + loc.cle + ')');
    setEl('s-k',      String(K));

    if (!seqCtx) return;

    var pad = 40;
    var lo  = Math.max(0, loc.st - 1 - pad);
    var hi  = Math.min(seq.length, loc.ed + pad);
    var out = '';
    for (var i = lo; i < hi; i++) {
      var pos = i + 1, ch = esc(seq[i]), cls = '';
      if (pos >= loc.st && pos <= loc.ed) cls = 'tgt';
      if (loc.pam) {
        var pamRight = (loc.strand === '+') === (loc.pamSide === 3);
        var ps = pamRight ? loc.ed + 1 : loc.st - loc.pam.length;
        if (pos >= ps && pos < ps + loc.pam.length) cls = 'pam';
      }
      if (loc.cut !== null && pos === loc.cut) out += '<span class="cut">&#9660;</span>';
      out += cls ? '<span class="' + cls + '">' + ch + '</span>' : ch;
    }
    seqCtx.innerHTML = out;
  }

  function esc(c) {
    return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c;
  }

  // ---- alignment summary chart (Figure 1, Plotly) ----
  // All reads, Aligned and Used per sample, in read pairs. Used can be far smaller than
  // Aligned, so bars are labelled and a log scale is offered. The numbers come from the
  // same sources as the summary table, so the two agree.

  var CHART_EL   = 'summary-chart';
  var chartScale = 'linear';
  var chartData  = null;

  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v && v.trim()) || fallback;
  }

  function plotlyAvailable() {
    return typeof window.Plotly !== 'undefined' && window.Plotly &&
           typeof window.Plotly.react === 'function';
  }

  function renderSummaryChart() {
    var mount    = document.getElementById(CHART_EL);
    var fallback = document.getElementById('summary-chart-fallback');
    if (!mount || !chartData) return;

    if (!plotlyAvailable()) {
      mount.classList.add('d-none');
      if (fallback) fallback.classList.remove('d-none');
      console.warn('[app.js] Plotly unavailable — summary chart skipped');
      return;
    }
    mount.classList.remove('d-none');
    if (fallback) fallback.classList.add('d-none');

    var ink   = cssVar('--text-primary',   '#111827');
    var muted = cssVar('--text-secondary', '#6b7280');
    var grid  = cssVar('--border',         '#e5e7eb');

    var groups = ['All reads', 'Aligned', 'Used'];
    var series = [
      { name: 'Control',      key: 'ctr', color: '#5b9bd5' },
      { name: 'Cas9-treated', key: 'mut', color: '#ff6b6b' }
    ];

    var traces = series.map(function (sp) {
      var b = chartData[sp.key] || {};
      var y = [b.total, b.aligned, b.used].map(function (v) {
        return (typeof v === 'number' && isFinite(v)) ? v : null;
      });
      return {
        type: 'bar',
        name: sp.name,
        x: groups,
        y: y,
        marker: { color: sp.color, line: { width: 0 } },
        text: y.map(function (v) { return v === null ? '–' : v.toLocaleString(); }),
        textposition: 'outside',
        textfont: { size: 11, color: muted },
        cliponaxis: false,
        hovertemplate: '%{fullData.name}<br>%{x}: %{y:,} read pairs<extra></extra>'
      };
    });

    var layout = {
      barmode: 'group',
      bargap: 0.28,
      bargroupgap: 0.08,
      margin: { l: 64, r: 16, t: 16, b: 48 },
      height: 320,
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor:  'rgba(0,0,0,0)',
      font: { family: 'Inter, system-ui, sans-serif', size: 12, color: ink },
      xaxis: { title: { text: 'Reads', standoff: 12 }, tickfont: { color: muted },
               showgrid: false, zeroline: false, linecolor: grid },
      yaxis: { title: { text: 'Read pairs', standoff: 10 },
               type: chartScale,
               rangemode: 'tozero',
               tickfont: { color: muted },
               gridcolor: grid, zeroline: false, automargin: true },
      legend: { orientation: 'h', y: 1.12, x: 0, font: { size: 11 } },
      showlegend: true
    };

    // A log axis cannot show 0 (a sample with no reads used, say), so zero bars drop out
    // rather than plotting as -Infinity.
    if (chartScale === 'log') {
      var max = 1;
      traces.forEach(function (t) {
        t.y.forEach(function (v) { if (v != null && v > max) max = v; });
        t.y = t.y.map(function (v) { return (v === null || v <= 0) ? null : v; });
      });
      layout.yaxis.rangemode  = 'normal';
      layout.yaxis.dtick      = 1;                 // powers of ten only
      layout.yaxis.tickformat = ',d';
      // log-axis range is in log10 units: from 1 to just above the tallest bar
      layout.yaxis.range = [0, Math.log(max) / Math.LN10 + 0.15];
    }

    window.Plotly.react(mount, traces, layout, {
      responsive: true,
      displaylogo: false,
      modeBarButtonsToRemove: ['select2d', 'lasso2d', 'autoScale2d'],
      toImageButtonOptions: { filename: 'excas-alignment-summary', scale: 2 }
    });
  }

  // metrics: read counts parsed from the core's log. patterns: the parsed
  // mutation_summary.tsv, whose total_analyzed row is the Used count.
  function updateSummaryChart(metrics, patterns) {
    if (!metrics) return;
    var analysed = function (which) {
      var row = patterns && patterns[which] && patterns[which].total_analyzed;
      return row ? row.n : null;
    };
    chartData = {
      ctr: { total: metrics.ctrTotal, aligned: metrics.ctrAligned, used: analysed('control') },
      mut: { total: metrics.mutTotal, aligned: metrics.mutAligned, used: analysed('treated') }
    };
    renderSummaryChart();
  }

  (function wireScaleToggle() {
    var lin = document.getElementById('scale-linear');
    var log = document.getElementById('scale-log');
    if (!lin || !log) return;
    function set(mode) {
      chartScale = mode;
      lin.classList.toggle('active', mode === 'linear');
      log.classList.toggle('active', mode === 'log');
      renderSummaryChart();
    }
    lin.addEventListener('click', function () { set('linear'); });
    log.addEventListener('click', function () { set('log'); });
  })();

  // ---- results: summary table, pie charts, per-base figures ----
  // Built only from the core's output: its log and mutation_summary.tsv for the counts,
  // its SAM files for the per-base figures.

  // The classes the core reports. Large insertions, inversions, complex events and
  // precise / partial editing are left out, not shown as zero: the core does not detect
  // them.
  var CLASSES = [
    { key: 'wt',                         label: 'WT',       colour: '#9aa5b1' },
    { key: 'small_insertion',            label: 'Ins',      colour: '#2ca02c' },
    { key: 'small_deletion',             label: 'Del',      colour: '#d62728' },
    { key: 'substitution',               label: 'Sub',      colour: '#9467bd' },
    { key: 'large_deletion',             label: 'LargeDel', colour: '#e3116c' },
    { key: 'terminal_insertion_clipped', label: 'TermIns',  colour: '#ff7f0e' }
  ];

  // Rows after the header: sample, class, count, percent. Returns {control, treated}, each
  // mapping class -> {n, pct}.
  function parseMutationSummary(text) {
    var v = { control: {}, treated: {} };
    if (!text) return v;
    text.trim().split('\n').slice(1).forEach(function (line) {
      var f = line.split('\t');
      if (v[f[0]]) v[f[0]][f[1]] = { n: parseInt(f[2], 10) || 0, pct: f[3] };
    });
    return v;
  }

  // ---- Table 1: summary table ----
  function fillSummaryTable(pat, metrics) {
    var body = document.getElementById('summary-body');
    var note = document.getElementById('summary-note');
    if (!body) return;

    var rows = [
      { which: 'control', label: 'Control',      total: metrics.ctrTotal, aligned: metrics.ctrAligned },
      { which: 'treated', label: 'Cas9-treated', total: metrics.mutTotal, aligned: metrics.mutAligned }
    ];

    body.innerHTML = '';
    rows.forEach(function (r) {
      var v    = pat[r.which] || {};
      var used = v.total_analyzed ? v.total_analyzed.n : 0;
      var tr   = document.createElement('tr');

      var cells = [
        { text: r.label, head: true },
        { text: num(r.total) },
        { text: countPct(r.total - r.aligned, r.total) },
        { text: countPct(used, r.total) }
      ];
      CLASSES.forEach(function (c) {
        var x = v[c.key];
        cells.push({ text: x ? countPct(x.n, used) : '—' });
      });

      cells.forEach(function (c) {
        var td = document.createElement('td');
        td.textContent = c.text;
        td.className = c.head ? 'text-start' : 'num';
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });

    if (note) {
      note.textContent =
        'Table 1. Read pairs per sample. Unmapped and Reads used are shares of Total ' +
        'reads; the six classes are shares of Reads used. Classes this core does not ' +
        'call \u2014 large insertions, inversions, complex \u2014 are omitted, not zeroed.';
    }
  }

  function num(v) { return (v == null) ? '—' : v.toLocaleString(); }

  function countPct(n, denom) {
    if (n == null) return '—';
    if (!denom) return n.toLocaleString();
    return n.toLocaleString() + ' (' + (n / denom * 100).toFixed(1) + '%)';
  }

  // ---- Figure 2: mutation pattern pies ----
  function renderPies(pat) {
    [['control', 'pie-ctr', 'Control'], ['treated', 'pie-mut', 'Cas9-treated']]
      .forEach(function (spec) {
        renderPie(spec[1], spec[2], pat[spec[0]] || {});
      });
  }

  function renderPie(mountId, title, v) {
    var el = document.getElementById(mountId);
    if (!el) return;
    if (!plotlyAvailable()) { el.textContent = ''; return; }

    var labels = [], values = [], colours = [];
    CLASSES.forEach(function (c) {
      var x = v[c.key];
      if (!x || !x.n) return;                 // omit empty slices entirely
      labels.push(c.label);
      values.push(x.n);
      colours.push(c.colour);
    });

    var used = v.total_analyzed ? v.total_analyzed.n : 0;
    if (!values.length) {
      window.Plotly.purge(el);
      el.textContent = '';
      return;
    }

    window.Plotly.react(el, [{
      type: 'pie',
      labels: labels,
      values: values,
      marker: { colors: colours, line: { color: '#fff', width: 1 } },
      textinfo: 'percent',
      textposition: 'inside',
      insidetextorientation: 'horizontal',
      hovertemplate: '%{label}<br>%{value:,} pairs (%{percent})<extra></extra>',
      sort: false,
      direction: 'clockwise'
    }], {
      title: { text: title + ' · ' + used.toLocaleString() + ' pairs', font: { size: 13 } },
      height: 300,
      margin: { l: 10, r: 10, t: 40, b: 10 },
      paper_bgcolor: 'rgba(0,0,0,0)',
      font: { family: 'Inter, system-ui, sans-serif', size: 12, color: cssVar('--text-primary', '#111827') },
      legend: { orientation: 'h', y: -0.05, font: { size: 11 } },
      showlegend: true
    }, { responsive: true, displaylogo: false, displayModeBar: false });
  }

  // ---- Figures 3-5: per-base pileup and nucleotide composition ----

  var NT_COLOUR = { A: '#2ca02c', C: '#ff7f0e', G: '#ffd92f', T: '#9467bd' };
  var DEL_LOCAL_COLOUR = '#111111';   // deletion at the cut
  var DEL_SPAN_COLOUR  = '#b6bcc6';   // a split read's long deletion spanning the base
  var INS_COLOUR       = '#8c564b';

  // The SAM files behind each sample's per-base figures: the reads the summary table
  // counts as used, plus the *_common deletions the table leaves out. 'large' marks the
  // split-read files, whose deletions are counted separately.
  var NT_SOURCES = {
    control: [
      { suffix: '_site_ctr.sam',      kind: 'local' },
      { suffix: '_site_ctr_sm.sam',   kind: 'local' },
      { suffix: '_site_ctr_clip.sam', kind: 'local' },
      { suffix: '_ctr_only.sam',      kind: 'large' },
      { suffix: '_ctr_common.sam',    kind: 'large' }
    ],
    treated: [
      { suffix: '_site_mut.sam',      kind: 'local' },
      { suffix: '_site_mut_sm.sam',   kind: 'local' },
      { suffix: '_site_mut_clip.sam', kind: 'local' },
      { suffix: '_mut_only.sam',      kind: 'large' },
      { suffix: '_mut_common.sam',    kind: 'large' }
    ]
  };

  var ntState = { pileups: null, sample: 'treated', halfWidth: 30, cut: null, ref: '' };

  // Walks each read's CIGAR and counts, per 1-based reference position: coverage, the
  // base each read shows, deletions, and insertions just after the position.
  function buildPileup(sources, refLen) {
    var cov = new Int32Array(refLen + 2);
    // Deletions from the 'large' (split-read) files are counted apart from those at the
    // cut, or their long spans would bury the local signal under a flat band.
    var delLarge = new Int32Array(refLen + 2);
    var delLocal = new Int32Array(refLen + 2);
    var ins = new Int32Array(refLen + 2);
    var base = { A: new Int32Array(refLen + 2), C: new Int32Array(refLen + 2),
                 G: new Int32Array(refLen + 2), T: new Int32Array(refLen + 2) };
    // Length sums, for the mean indel length per position. Float64 because long deletions
    // summed over many reads can overflow an Int32.
    var insSum   = new Float64Array(refLen + 2), insN   = new Int32Array(refLen + 2);
    var delSumLo = new Float64Array(refLen + 2), delNLo = new Int32Array(refLen + 2);
    var delSumHi = new Float64Array(refLen + 2), delNHi = new Int32Array(refLen + 2);
    var reads = 0;

    sources.forEach(function (src) {
      var text = src.text;
      if (!text) return;
      var large  = (src.kind === 'large');
      var del    = large ? delLarge : delLocal;
      var delSum = large ? delSumHi : delSumLo;
      var delN   = large ? delNHi   : delNLo;
      text.split('\n').forEach(function (line) {
        if (!line || line.charAt(0) === '@') return;
        var f = line.split('\t');
        if (f.length < 11) return;

        var pos = parseInt(f[3], 10);          // SAM POS: 1-based leftmost aligned base
        var cigar = f[5], seq = f[9];
        if (!pos || !cigar || cigar === '*') return;
        reads++;

        var ref = pos, q = 0, re = /(\d+)([MIDNSHP=X])/g, m;
        while ((m = re.exec(cigar)) !== null) {
          var len = parseInt(m[1], 10), op = m[2];
          if (op === 'M' || op === '=' || op === 'X') {
            for (var i = 0; i < len; i++, ref++, q++) {
              if (ref < 1 || ref > refLen) continue;
              cov[ref]++;
              var c = seq.charAt(q);
              if (base[c]) base[c][ref]++;
            }
          } else if (op === 'D' || op === 'N') {
            for (var j = 0; j < len; j++, ref++) {
              if (ref < 1 || ref > refLen) continue;
              cov[ref]++;
              del[ref]++;
              // every base the deletion covers carries that deletion's length
              delSum[ref] += len;
              delN[ref]++;
            }
          } else if (op === 'I') {
            // an insertion sits between bases; credit it to the position just before
            if (ref - 1 >= 1 && ref - 1 <= refLen) {
              ins[ref - 1]++;
              insSum[ref - 1] += len;
              insN[ref - 1]++;
            }
            q += len;
          } else if (op === 'S') {
            q += len;
          }
          // H and P consume neither the reference nor the read
        }
      });
    });
    return { cov: cov, delLarge: delLarge, delLocal: delLocal, ins: ins,
             base: base, reads: reads,
             insSum: insSum, insN: insN,
             delSumLo: delSumLo, delNLo: delNLo,
             delSumHi: delSumHi, delNHi: delNHi };
  }

  // For the three per-base figures: returns true if there is something to draw, else
  // clears the figure and says why.
  function pileupFigureReady(mount, empty, note, pile) {
    var why = (!pile || !pile.reads) ? 'No alignments available for this sample.'
            : !plotlyAvailable()    ? 'Plotly could not be loaded, so this plot is unavailable.'
            : null;
    if (!why) {
      if (empty) empty.classList.add('d-none');
      return true;
    }
    if (window.Plotly) window.Plotly.purge(mount);
    mount.innerHTML = '';
    if (empty) { empty.textContent = why; empty.classList.remove('d-none'); }
    if (note) note.textContent = '';
    return false;
  }

  function renderNucleotide() {
    var mount = document.getElementById('nt-chart');
    var empty = document.getElementById('nt-empty');
    var note  = document.getElementById('nt-note');
    if (!mount) return;

    var pile = ntState.pileups ? ntState.pileups[ntState.sample] : null;
    var ref  = ntState.ref;
    var cut  = ntState.cut;

    if (!pileupFigureReady(mount, empty, note, pile)) return;

    var lo = Math.max(1, cut - ntState.halfWidth);
    var hi = Math.min(ref.length, cut + ntState.halfWidth);

    var xs = [], tick = [], covAt = [];
    for (var p = lo; p <= hi; p++) { xs.push(p); tick.push(ref.charAt(p - 1) || '?'); covAt.push(pile.cov[p]); }

    var pctOf = function (arr) {
      return xs.map(function (p) {
        var c = pile.cov[p];
        return c ? arr[p] / c * 100 : 0;
      });
    };

    var traces = ['A', 'C', 'G', 'T'].map(function (b) {
      return {
        type: 'bar', name: b, x: xs, y: pctOf(pile.base[b]),
        marker: { color: NT_COLOUR[b], line: { width: 0 } },
        hovertemplate: '%{x}: ' + b + ' %{y:.1f}%<extra></extra>'
      };
    });
    traces.push({
      type: 'bar', name: 'Deletion (at the cut)', x: xs, y: pctOf(pile.delLocal),
      marker: { color: DEL_LOCAL_COLOUR, line: { width: 0 } },
      hovertemplate: '%{x}: deleted in %{y:.1f}% (local indel)<extra></extra>'
    });
    traces.push({
      type: 'bar', name: 'Deletion (spanning)', x: xs, y: pctOf(pile.delLarge),
      marker: { color: DEL_SPAN_COLOUR, line: { width: 0 } },
      hovertemplate: '%{x}: deleted in %{y:.1f}% (split-read large deletion)<extra></extra>'
    });
    // Insertions sit between bases, outside the 100% stack, so they get their own panel
    // and scale.
    traces.push({
      type: 'bar', name: 'Insertion', x: xs, y: pctOf(pile.ins),
      yaxis: 'y2',
      marker: { color: INS_COLOUR, line: { width: 0 } },
      hovertemplate: '%{x}: insertion after this base in %{y:.2f}%<extra></extra>'
    });

    var ink   = cssVar('--text-primary',   '#111827');
    var muted = cssVar('--text-secondary', '#6b7280');
    var grid  = cssVar('--border',         '#e5e7eb');

    window.Plotly.react(mount, traces, {
      barmode: 'stack',
      bargap: 0.08,
      height: 430,
      margin: { l: 58, r: 16, t: 60, b: 56 },
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      font: { family: 'Inter, system-ui, sans-serif', size: 11, color: ink },
      xaxis: {
        // no axis title: it would land on the insertion panel below
        tickmode: 'array', tickvals: xs, ticktext: tick,
        tickfont: { size: 9, family: 'IBM Plex Mono, monospace', color: muted },
        showgrid: false, zeroline: false, linecolor: grid
      },
      yaxis: { title: { text: '% of reads covering the base' },
               domain: [0.26, 1], range: [0, 100], ticksuffix: '%',
               gridcolor: grid, zeroline: false, tickfont: { color: muted } },
      yaxis2: { title: { text: 'insertion %', font: { size: 10 } },
                domain: [0, 0.19], rangemode: 'tozero', ticksuffix: '%',
                gridcolor: grid, zeroline: false,
                tickfont: { color: muted, size: 9 }, nticks: 3 },
      legend: { orientation: 'h', y: 1.22, x: 0, font: { size: 11 }, traceorder: 'normal' },
      shapes: [
        // The core's ±13 bp window (bases cut − 13 to cut + 13), drawn above the bars,
        // since the full-height stack would hide it.
        { type: 'rect', xref: 'x', yref: 'paper',
          x0: cut - 13.5, x1: cut + 13.5, y0: 1.005, y1: 1.045,
          fillcolor: 'rgba(37,99,235,0.35)', line: { width: 0 } },
        // the cut is just before base `cut`, so the line falls between two bars
        { type: 'line', xref: 'x', yref: 'paper',
          x0: cut - 0.5, x1: cut - 0.5, y0: 0, y1: 1.045,
          line: { color: '#c9302c', width: 1.5, dash: 'dash' } }
      ],
      annotations: [
        { x: cut - 0.5, y: 1.075, xref: 'x', yref: 'paper', text: 'cut', showarrow: false,
          font: { size: 10, color: '#c9302c' } }
      ]
    }, { responsive: true, displaylogo: false,
         modeBarButtonsToRemove: ['select2d', 'lasso2d'] });

    var minCov = Math.min.apply(null, covAt);
    var maxCov = Math.max.apply(null, covAt);
    if (note) {
      note.textContent =
        'Figure 3. Base composition at each position. Deletions: black at the cut, grey ' +
        'where a long split-read deletion spans the base. Lower panel: insertions, on ' +
        'their own scale. From ' +
        Math.round(pile.reads / 2).toLocaleString() + ' analysed read pairs, coverage ' +
        minCov.toLocaleString() + '\u2013' + maxCov.toLocaleString() + ' reads.' +
        (maxCov < 100 ? ' Too few for the percentages to be stable.' : '');
    }
  }

  // ---- Figure 4: indel size by position ----

  var INS_STEM   = '#c0392b';   // insertions
  var DEL_LO_STEM = '#5b53b8';  // deletions at the cut
  var DEL_HI_STEM = '#9ca3af';  // spanning split-read deletions

  // Plotly has no stem plot: the sticks are one line trace (null between each) and the
  // heads a marker trace. ys[i] == null leaves position i empty.
  function stemTraces(xs, ys, name, colour, axis) {
    var lx = [], ly = [], mx = [], my = [];
    for (var i = 0; i < xs.length; i++) {
      if (ys[i] == null) continue;
      lx.push(xs[i], xs[i], null);
      ly.push(0, ys[i], null);
      mx.push(xs[i]); my.push(ys[i]);
    }
    var common = axis ? { xaxis: axis.x, yaxis: axis.y } : {};
    return [
      Object.assign({
        type: 'scatter', mode: 'lines', x: lx, y: ly,
        line: { color: colour, width: 1 },
        hoverinfo: 'skip', showlegend: false, connectgaps: false
      }, common),
      Object.assign({
        type: 'scatter', mode: 'markers', name: name, x: mx, y: my,
        marker: { color: colour, size: 5 },
        hovertemplate: '%{x}: ' + name + ' mean %{y:.1f} bp<extra></extra>'
      }, common)
    ];
  }

  function renderIndelLengths() {
    var mount = document.getElementById('indel-chart');
    var empty = document.getElementById('indel-empty');
    var note  = document.getElementById('indel-note');
    if (!mount) return;

    var pile = ntState.pileups ? ntState.pileups[ntState.sample] : null;
    var ref  = ntState.ref;
    var cut  = ntState.cut;

    if (!pileupFigureReady(mount, empty, note, pile)) return;

    var lo = Math.max(1, cut - ntState.halfWidth);
    var hi = Math.min(ref.length, cut + ntState.halfWidth);

    var xs = [], insAvg = [], delLoAvg = [], delHiAvg = [];
    var mean = function (sum, n, p) { return n[p] ? sum[p] / n[p] : null; };
    for (var p = lo; p <= hi; p++) {
      xs.push(p);
      insAvg.push(mean(pile.insSum, pile.insN, p));
      delLoAvg.push(mean(pile.delSumLo, pile.delNLo, p));
      delHiAvg.push(mean(pile.delSumHi, pile.delNHi, p));
    }

    var traces = []
      .concat(stemTraces(xs, insAvg, 'Insertion', INS_STEM, { x: 'x',  y: 'y'  }))
      .concat(stemTraces(xs, delLoAvg, 'Deletion at the cut', DEL_LO_STEM, { x: 'x2', y: 'y2' }))
      .concat(stemTraces(xs, delHiAvg, 'Deletion (spanning)', DEL_HI_STEM, { x: 'x2', y: 'y2' }));

    var ink   = cssVar('--text-primary',   '#111827');
    var muted = cssVar('--text-secondary', '#6b7280');
    var grid  = cssVar('--border',         '#e5e7eb');
    var axis  = { showgrid: true, gridcolor: grid, zeroline: false,
                  tickfont: { color: muted, size: 10 } };

    // Indels at the cut are short; split-read deletions can run to several kb. A log axis
    // shows both. delMax sets its top, at least 10 bp.
    var delMax = 10;
    delLoAvg.concat(delHiAvg).forEach(function (v) { if (v != null && v > delMax) delMax = v; });

    // between base cut − 1 and base cut, as in the nucleotide figure
    var cutLine = function (ax) {
      return { type: 'line', xref: ax, yref: 'paper', x0: cut - 0.5, x1: cut - 0.5, y0: 0, y1: 1,
               line: { color: '#c9302c', width: 1, dash: 'dash' } };
    };

    window.Plotly.react(mount, traces, {
      height: 360,
      margin: { l: 58, r: 20, t: 46, b: 86 },
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      font: { family: 'Inter, system-ui, sans-serif', size: 11, color: ink },
      // same x range on both panels, so they line up
      xaxis:  Object.assign({}, axis, { domain: [0, 0.46], anchor: 'y',
                range: [lo - 0.5, hi + 0.5],
                title: { text: 'Reference position (bp)', standoff: 8 } }),
      yaxis:  Object.assign({}, axis, { anchor: 'x', rangemode: 'tozero',
                title: { text: 'Mean insertion length (bp)' } }),
      xaxis2: Object.assign({}, axis, { domain: [0.56, 1], anchor: 'y2',
                range: [lo - 0.5, hi + 0.5],
                title: { text: 'Reference position (bp)', standoff: 8 } }),
      yaxis2: Object.assign({}, axis, { anchor: 'x2', type: 'log',
                range: [0, Math.log(delMax) / Math.LN10 + 0.12],
                dtick: 1, tickformat: ',d',
                title: { text: 'Mean deletion length (bp, log)' } }),
      legend: { orientation: 'h', y: -0.26, x: 0, font: { size: 11 } },
      shapes: [cutLine('x'), cutLine('x2')],
      // Panel titles are annotations pinned to each panel's own domain, so margins cannot
      // shift them.
      annotations: [
        { text: 'Insertion size by position',
          xref: 'x domain',  x: 0.5, xanchor: 'center',
          yref: 'y domain',  y: 1,   yanchor: 'bottom', yshift: 10,
          showarrow: false, font: { size: 12 } },
        { text: 'Deletion size by position',
          xref: 'x2 domain', x: 0.5, xanchor: 'center',
          yref: 'y2 domain', y: 1,   yanchor: 'bottom', yshift: 10,
          showarrow: false, font: { size: 12 } }
      ]
    }, { responsive: true, displaylogo: false,
         modeBarButtonsToRemove: ['select2d', 'lasso2d'] });

    if (note) {
      note.textContent =
        'Figure 4. Mean length of the indels at each reference position \u2014 height is ' +
        'length, not how often. Deletions use a log axis: indigo at the cut, grey for ' +
        'split reads whose deletion spans the base.';
    }
  }

  // ---- Figure 5: mutation position distribution ----

  var MUT_COLOUR = {
    ins:   '#1a9850',   // insertions
    delLo: '#d73027',   // deletions at the cut
    delHi: '#f0a8a0',   // spanning split-read deletions
    sub:   '#3b5bdb'    // substitutions
  };

  function renderMutationPositions() {
    var mount = document.getElementById('mutpos-chart');
    var empty = document.getElementById('mutpos-empty');
    var note  = document.getElementById('mutpos-note');
    if (!mount) return;

    var pile = ntState.pileups ? ntState.pileups[ntState.sample] : null;
    var ref  = ntState.ref;
    var cut  = ntState.cut;

    if (!pileupFigureReady(mount, empty, note, pile)) return;

    var lo = Math.max(1, cut - ntState.halfWidth);
    var hi = Math.min(ref.length, cut + ntState.halfWidth);

    var xs = [], fIns = [], fDelLo = [], fDelHi = [], fSub = [], covAt = [];
    for (var p = lo; p <= hi; p++) {
      var c = pile.cov[p];
      xs.push(p);
      covAt.push(c);

      // substitutions: aligned bases here that differ from the reference base
      var refBase = ref.charAt(p - 1);
      var matched = pile.base.A[p] + pile.base.C[p] + pile.base.G[p] + pile.base.T[p];
      var same    = pile.base[refBase] ? pile.base[refBase][p] : 0;
      var subs    = Math.max(0, matched - same);

      var pct = function (n) { return c ? n / c * 100 : 0; };
      fIns.push(pct(pile.ins[p]));
      fDelLo.push(pct(pile.delLocal[p]));
      fDelHi.push(pct(pile.delLarge[p]));
      fSub.push(pct(subs));
    }

    var line = function (name, y, colour, rank, width, dash) {
      return {
        type: 'scatter', mode: 'lines', name: name, x: xs, y: y,
        legendrank: rank,
        line: { color: colour, width: width, dash: dash || 'solid', shape: 'linear' },
        hovertemplate: '%{x}: ' + name + ' %{y:.1f}%<extra></extra>'
      };
    };

    // Drawn in array order, so insertions (last) sit on top near the cut. legendrank sets
    // the legend order separately.
    var traces = [
      line('Deletions (spanning)',   fDelHi, MUT_COLOUR.delHi, 3, 1.4, 'dot'),
      line('Deletions (at the cut)', fDelLo, MUT_COLOUR.delLo, 2, 1.8),
      line('Substitutions',          fSub,   MUT_COLOUR.sub,   4, 1.4),
      line('Insertions',             fIns,   MUT_COLOUR.ins,   1, 2.2)
    ];

    var ink   = cssVar('--text-primary',   '#111827');
    var muted = cssVar('--text-secondary', '#6b7280');
    var grid  = cssVar('--border',         '#e5e7eb');

    window.Plotly.react(mount, traces, {
      height: 360,
      margin: { l: 62, r: 20, t: 40, b: 76 },
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      font: { family: 'Inter, system-ui, sans-serif', size: 11, color: ink },
      xaxis: { title: { text: 'Reference position (bp)', standoff: 8 },
               range: [lo - 0.5, hi + 0.5],
               showgrid: true, gridcolor: grid, zeroline: false,
               tickfont: { color: muted, size: 10 } },
      yaxis: { title: { text: 'Frequency (% of reads covering the base)' },
               rangemode: 'tozero', ticksuffix: '%',
               gridcolor: grid, zeroline: false, tickfont: { color: muted, size: 10 } },
      legend: { orientation: 'h', y: -0.22, x: 0, font: { size: 11 },
                traceorder: 'normal' },
      shapes: [
        // the core's ±13 bp window, shaded
        { type: 'rect', xref: 'x', yref: 'paper',
          x0: cut - 13.5, x1: cut + 13.5, y0: 0, y1: 1,
          fillcolor: 'rgba(107,114,128,0.10)',
          line: { color: 'rgba(107,114,128,0.45)', width: 1, dash: 'dash' },
          layer: 'below' },
        // between base cut − 1 and base cut, as in the nucleotide figure
        { type: 'line', xref: 'x', yref: 'paper', x0: cut - 0.5, x1: cut - 0.5, y0: 0, y1: 1,
          line: { color: '#c9302c', width: 1, dash: 'dash' } }
      ],
      annotations: [
        { x: cut - 0.5, y: 1.04, xref: 'x', yref: 'paper', text: 'cut', showarrow: false,
          font: { size: 10, color: '#c9302c' } }
      ]
    }, { responsive: true, displaylogo: false,
         modeBarButtonsToRemove: ['select2d', 'lasso2d'] });

    if (note) {
      note.textContent =
        'Figure 5. How often each change occurs at each position, as a share of the reads ' +
        'covering it. Shaded: the \u00b113 bp window the core treats as on-target. Dotted: ' +
        'spanning split-read deletions.';
    }
  }

  // ---- tabs for Figures 4 and 5 ----
  var indelTab = 'size';

  function renderIndelTab() {
    // A hidden pane has zero width, so draw only the visible tab, and redraw on switching.
    if (indelTab === 'size') renderIndelLengths();
    else renderMutationPositions();
  }

  (function wireIndelTabs() {
    var tabs = [
      { btn: 'indel-tab-size', pane: 'indel-pane-size', key: 'size' },
      { btn: 'indel-tab-pos',  pane: 'indel-pane-pos',  key: 'pos'  }
    ];
    tabs.forEach(function (t) {
      var b = document.getElementById(t.btn);
      if (!b) return;
      b.addEventListener('click', function () {
        indelTab = t.key;
        tabs.forEach(function (o) {
          var ob = document.getElementById(o.btn);
          var op = document.getElementById(o.pane);
          if (ob) { ob.classList.toggle('active', o.key === t.key);
                    ob.setAttribute('aria-selected', String(o.key === t.key)); }
          if (op) op.classList.toggle('d-none', o.key !== t.key);
        });
        renderIndelTab();
      });
    });
  })();

  function updateNucleotide(outputs, prefix, params, refSeq) {
    ntState.ref = refSeq || '';
    ntState.cut = params.targetStart + params.cleavage;  // 1-based first base after the cut
    ntState.pileups = {};
    Object.keys(NT_SOURCES).forEach(function (which) {
      var sources = NT_SOURCES[which].map(function (src) {
        var o = outputs[prefix + src.suffix];
        return { text: o ? o.text : '', kind: src.kind };
      });
      ntState.pileups[which] = buildPileup(sources, ntState.ref.length || 1);
    });
    renderNucleotide();
    renderIndelTab();
  }

  (function wireNucleotideControls() {
    var setSample = function (which) {
      ntState.sample = which;
      var c = document.getElementById('nt-ctr'), m = document.getElementById('nt-mut');
      if (c) c.classList.toggle('active', which === 'control');
      if (m) m.classList.toggle('active', which === 'treated');
      renderNucleotide();
      renderIndelTab();
    };
    var setWidth = function (w) {
      ntState.halfWidth = w;
      [['nt-w15', 15], ['nt-w30', 30], ['nt-w60', 60]].forEach(function (pair) {
        var el = document.getElementById(pair[0]);
        if (el) el.classList.toggle('active', pair[1] === w);
      });
      renderNucleotide();
      renderIndelTab();
    };
    var on = function (id, fn) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('click', fn);
    };
    on('nt-ctr', function () { setSample('control'); });
    on('nt-mut', function () { setSample('treated'); });
    on('nt-w15', function () { setWidth(15); });
    on('nt-w30', function () { setWidth(30); });
    on('nt-w60', function () { setWidth(60); });
  })();

  // ---- results page ----
  function finishResults(result, params) {
    showPage('results');

    var outputs = result.outputs || {};
    var prefix  = params.gene + '_' + params.sample;
    var pat     = parseMutationSummary((outputs[prefix + '_mutation_summary.tsv'] || {}).text);

    // in page order, labelled as the page captions them
    fillSummaryTable(pat, result.metrics);                    // Table 1
    updateSummaryChart(result.metrics, pat);                  // Figure 1
    renderPies(pat);                                          // Figure 2
    updateNucleotide(outputs, prefix, params, refSequence);   // Figures 3–5
    renderDownloads(outputs, prefix);                         // result files
    renderViewer(outputs, prefix, params, result.refLen);     // Figure 6
  }

  // ---- result file downloads ----

  var outputUrls = [];

  function releaseOutputUrls() {
    outputUrls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (_) {} });
    outputUrls = [];
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  // Saves a blob as a file through a temporary link. Used for the results zip and the
  // example download. The URL is revoked by releaseOutputUrls() when the next results are
  // rendered.
  function saveBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    outputUrls.push(url);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function renderDownloads(outputs, prefix) {
    var box    = document.getElementById('download-box');
    var list   = document.getElementById('dl-list');
    var note   = document.getElementById('dl-note');
    var allBtn = document.getElementById('dl-all');
    var toggle = document.getElementById('dl-toggle');
    if (!list || !box) return;

    releaseOutputUrls();
    list.innerHTML = '';
    list.classList.add('d-none');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');

    var names = Object.keys(outputs).filter(function (n) { return outputs[n].size > 0; }).sort();
    if (!names.length) { box.classList.add('d-none'); return; }
    box.classList.remove('d-none');

    var total = 0;
    names.forEach(function (n) {
      total += outputs[n].size;
      var type = /\.html$/.test(n) ? 'text/html'
               : /\.tsv$/.test(n)  ? 'text/tab-separated-values'
               : 'text/plain';
      var url = URL.createObjectURL(new Blob([outputs[n].text], { type: type }));
      outputUrls.push(url);

      var a = document.createElement('a');
      a.className = 'btn btn-outline-secondary btn-sm';
      a.href = url;
      a.download = n;
      a.textContent = n;
      var span = document.createElement('span');
      span.className = 'text-secondary ms-1';
      span.textContent = '(' + fmtBytes(outputs[n].size) + ')';
      a.appendChild(span);
      list.appendChild(a);
    });

    if (note) {
      note.textContent = names.length + ' files, ' + fmtBytes(total) +
        '. SAM files open in IGV as they are; ' + prefix +
        '_report.html is a standalone report.';
    }

    if (toggle) {
      toggle.onclick = function () {
        var hidden = list.classList.toggle('d-none');
        toggle.setAttribute('aria-expanded', String(!hidden));
      };
    }

    // zipSync comes from the vendored fflate bundle, the same one used for gunzip.
    if (allBtn) {
      allBtn.onclick = function () {
        if (typeof fflate === 'undefined' || !fflate.zipSync) {
          // no zip available: open the list of individual files instead
          list.classList.remove('d-none');
          if (note) note.textContent = 'Zip support is unavailable; download the files individually.';
          return;
        }
        var files = {};
        names.forEach(function (n) { files[n] = fflate.strToU8(outputs[n].text); });
        try {
          var zipped = fflate.zipSync(files, { level: 6 });
          saveBlob(new Blob([zipped], { type: 'application/zip' }), prefix + '_results.zip');
        } catch (e) {
          showError('Could not build the zip: ' + (e.message || e));
        }
      };
    }
  }

  // ---- Figure 6: alignment viewer ----
  var viewer = null;

  var TRACKS = [
    { suffix: '_mut_only.sam',    label: 'Treated-only large deletions', hint: 'Judged CRISPR-induced' },
    { suffix: '_mut_common.sam',  label: 'Common (removed)',             hint: 'Also in the control, so treated as a PCR artefact' },
    { suffix: '_ctr_only.sam',    label: 'Control-only',                 hint: 'Deletions seen only in the control' },
    { suffix: '_site_mut.sam',    label: 'Treated reads at the cut',     hint: 'Normal reads spanning the cleavage site' },
    { suffix: '_site_mut_sm.sam', label: 'Treated small indels',         hint: 'Indels / substitutions within ±13 bp of the cut' }
  ];

  function renderViewer(outputs, prefix, params, refLen) {
    var mount = document.getElementById('viewer-mount');
    var bar   = document.getElementById('viewer-tracks');
    var tools = document.getElementById('viewer-tools');
    if (!mount || !window.ExCasViewer) return;

    var available = [];
    TRACKS.forEach(function (t) {
      var o = outputs[prefix + t.suffix];
      if (!o || !o.text.trim()) return;
      var recs = window.ExCasViewer.parseSam(o.text);
      if (recs.length) available.push({ def: t, records: recs });
    });

    mount.innerHTML = '';
    if (bar) bar.innerHTML = '';
    if (!available.length) {
      if (tools) tools.classList.add('d-none');
      var p = document.createElement('p');
      p.className = 'form-help mb-0';
      p.textContent = 'No alignments to display.';
      mount.appendChild(p);
      return;
    }
    if (tools) tools.classList.remove('d-none');

    var canvas = document.createElement('canvas');
    canvas.width = 900; canvas.height = 340;
    mount.appendChild(canvas);

    viewer = new window.ExCasViewer.AlignmentViewer(canvas, {
      refLen: refLen || 10000,
      cut:    params.targetStart + params.cleavage,
      target: [params.targetStart, params.targetEnd],
      onHover: showViewerTip
    });
    viewer.setTheme(false);
    wireViewerControls();

    available.forEach(function (entry, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-outline-secondary' + (i === 0 ? ' active' : '');
      b.title = entry.def.hint;
      b.textContent = entry.def.label + ' (' + Math.round(entry.records.length / 2).toLocaleString() + ')';
      b.addEventListener('click', function () {
        if (bar) bar.querySelectorAll('button').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        selectTrack(entry, refLen);
      });
      if (bar) bar.appendChild(b);
    });
    selectTrack(available[0], refLen);
  }

  function selectTrack(entry, refLen) {
    viewer.setData(entry.records, refLen || 10000);
    updateViewInfo();
  }

  var _viewerWired = false;
  function wireViewerControls() {
    if (_viewerWired) return;
    _viewerWired = true;

    var on = function (id, ev, fn) {
      var el = document.getElementById(id);
      if (el) el.addEventListener(ev, fn);
    };
    on('vw-pairs',  'change', function (e) { if (viewer) viewer.setViewPairs(e.target.checked); });
    on('vw-colour', 'change', function (e) { if (viewer) viewer.setColourBy(e.target.value); });
    on('vw-zin',    'click',  function () { if (viewer) { viewer.zoom(0.65); updateViewInfo(); } });
    on('vw-zout',   'click',  function () { if (viewer) { viewer.zoom(1.55); updateViewInfo(); } });
    on('vw-reset',  'click',  function () { if (viewer) { viewer.resetView(); updateViewInfo(); } });
    window.addEventListener('resize', function () { if (viewer) viewer.draw(); });

    var mount = document.getElementById('viewer-mount');
    if (mount) {
      mount.addEventListener('wheel', function () { setTimeout(updateViewInfo, 0); }, { passive: true });
      mount.addEventListener('mouseup', updateViewInfo);
      mount.addEventListener('mouseleave', function () { showViewerTip(null); });
    }
  }

  function updateViewInfo() {
    var el = document.getElementById('vw-info');
    if (!el || !viewer) return;
    el.textContent = Math.round(viewer.viewStart).toLocaleString() + ' – ' +
                     Math.round(viewer.viewEnd).toLocaleString() + ' bp (' +
                     Math.round(viewer.viewEnd - viewer.viewStart).toLocaleString() + ' bp window)';
  }

  // Hover card over a read: what its SAM record says. Without rec and ev it hides the card.
  function showViewerTip(rec, ev) {
    var tip = document.getElementById('viewer-tip');
    var mount = document.getElementById('viewer-mount');
    if (!tip) return;
    if (!rec || !ev) { tip.classList.add('d-none'); return; }

    var rows = [];
    var add = function (k, v) {
      if (v === undefined || v === null || v === '') return;
      rows.push({ k: k, v: String(v) });
    };
    add('Position', rec.refStart.toLocaleString() + ' – ' + rec.refEnd.toLocaleString());
    add('CIGAR', rec.cigarText);
    var dels = (rec.dels || []).filter(function (d) { return d.len >= 50; });
    if (dels.length) {
      add('Deletions', dels.map(function (d) { return d.len.toLocaleString() + ' bp'; }).join(', '));
    }
    add('Strand', rec.reverse ? '− (reverse)' : '+ (forward)');
    add('Distance to cut', rec.tags.Dist);
    add('Mismatches', rec.tags.XM);
    add('Call', rec.tags.XV);

    tip.textContent = '';
    var name = document.createElement('b');
    name.textContent = rec.name;
    tip.appendChild(name);
    rows.forEach(function (r) {
      var d = document.createElement('div');
      d.className = 'r';
      var a = document.createElement('span'); a.textContent = r.k;
      var b = document.createElement('span'); b.textContent = r.v;
      d.appendChild(a); d.appendChild(b);
      tip.appendChild(d);
    });

    tip.classList.remove('d-none');
    // keep the card inside the mount so it cannot push the page sideways
    var w = mount ? mount.clientWidth : 0;
    var x = Math.min(Math.max(0, (ev.offsetX || 0) + 14), Math.max(0, w - tip.offsetWidth - 8));
    tip.style.left = x + 'px';
    tip.style.top  = ((ev.offsetY || 0) + 14) + 'px';
  }

  // ---- repository links ----
  // On <owner>.github.io/<repo>/, point the GitHub and issue links at that repository.
  // Elsewhere they keep index.html's links.
  (function linkRepository() {
    var host = /^([a-z0-9-]+)\.github\.io$/i.exec(location.hostname);
    if (!host) return;
    var first = location.pathname.split('/').filter(Boolean)[0];
    var repo  = first && !/\.html?$/i.test(first) ? first : host[1] + '.github.io';
    var url   = 'https://github.com/' + host[1] + '/' + repo;
    var gh = document.getElementById('link-github');
    var issues = document.getElementById('link-issues');
    if (gh) gh.href = url;
    if (issues) issues.href = url + '/issues';
  })();

  // ---- public API ----
  // Everything above is private to this closure. These are the entry points for the
  // console and the tests.
  window.main           = main;
  window.runAction      = runAction;
  window.downloadAction = downloadAction;
  window.validateInputs = validateInputs;
  window.ExCas = {
    main: main,
    runAction: runAction,
    downloadAction: downloadAction,
    validateInputs: validateInputs,
    showPage: showPage,
    showError: showError,
    clearError: clearError,
    // so the tests can read what the page computed
    lastRun: function () { return lastRun; },
    outputs: function () { return lastRun ? lastRun.outputs : null; },
    parseMutationSummary: parseMutationSummary
  };

  console.log('[app.js] initialisation complete');
})();
