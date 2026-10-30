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
  var ctrBar     = document.getElementById('ctr-bar');
  var mutBar     = document.getElementById('mut-bar');
  var resBar     = document.getElementById('res-bar');
  var stageEl    = document.getElementById('stage');
  var cancelBtn  = document.getElementById('cancelBtn');

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
  var clients       = [];     // the AnalysisClients still running
  var lastRun       = null;   // the worker's 'done' payload for the results on show
  var batchRuns     = [];     // per treated sample of the last batch: { params, result } or { params, error }
  var shownRun      = 0;      // index in batchRuns of the run on show
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

  // label: the text in the bar; the percent when left out.
  function setBar(bar, pct, label) {
    if (!bar) return;
    var p = Math.max(0, Math.min(100, Math.round(pct)));
    bar.style.width = p + '%';
    bar.textContent = label != null ? label : p + '%';
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
  // not stop drag-and-drop or "All files". label may be a function, for rows that get
  // renumbered. keepExample: an added treated row, which the example does not fill.
  function wireFileTypeGuard(inputEl, label, keepExample) {
    if (!inputEl) return;
    inputEl.addEventListener('change', function () {
      // a manual selection replaces any example data that was loaded
      if (inputEl.files.length && !keepExample) _exampleFiles = null;

      if (!inputEl.files.length) return;
      var problem = fastqProblem(inputEl.files[0], typeof label === 'function' ? label() : label);
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
  wireFileTypeGuard(fileMutR1, function () { return mutLabel(0, 1); });
  wireFileTypeGuard(fileMutR2, function () { return mutLabel(0, 2); });

  // ---- treated-sample rows (batch mode) ----
  // Row 1 is in index.html; more are cloned from #mut-row-template, up to MAX_SAMPLES.
  // Each row has its own sample name and Read 1 / Read 2; the control, reference and
  // target are shared.
  var MAX_SAMPLES = 4;
  var mutRowsEl = document.getElementById('mut-rows');
  var rowTpl    = document.getElementById('mut-row-template');
  var addRowBtn = document.getElementById('add-sample');
  var rowSerial = 1;   // makes the ids of added rows' inputs unique

  function mutRows() {
    return mutRowsEl ? Array.prototype.slice.call(mutRowsEl.querySelectorAll('.mut-row')) : [];
  }

  // 'Cas9-treated Read 1', with the sample number once there is more than one sample
  function mutLabel(i, read) {
    return 'Cas9-treated Read ' + read + (mutRows().length > 1 ? ' (sample ' + (i + 1) + ')' : '');
  }

  // Numbers the rows, and turns the add button off at MAX_SAMPLES.
  function renumberRows() {
    var rows = mutRows();
    rows.forEach(function (row, i) {
      var t = row.querySelector('.mut-row-title');
      if (t) t.textContent = 'Sample ' + (i + 1);
    });
    if (addRowBtn) addRowBtn.disabled = rows.length >= MAX_SAMPLES;
  }

  // The first SampleN not already taken, as an added row's default name.
  function freeSampleName() {
    var used = {};
    mutRows().forEach(function (r) { used[r.querySelector('.mut-name').value.trim().toLowerCase()] = true; });
    for (var n = mutRows().length + 1; ; n++) if (!used['sample' + n]) return 'Sample' + n;
  }

  function addMutRow() {
    if (!mutRowsEl || !rowTpl || mutRows().length >= MAX_SAMPLES) return null;
    var row  = rowTpl.content.firstElementChild.cloneNode(true);
    var id   = ++rowSerial;
    var name = row.querySelector('.mut-name');
    var r1   = row.querySelector('.mut-r1');
    var r2   = row.querySelector('.mut-r2');
    var lab  = row.querySelectorAll('label.form-label');
    name.id = 'samplename-' + id; r1.id = 'file-mut-r1-' + id; r2.id = 'file-mut-r2-' + id;
    lab[0].htmlFor = name.id; lab[1].htmlFor = r1.id; lab[2].htmlFor = r2.id;
    name.value = freeSampleName();
    mutRowsEl.appendChild(row);
    renumberRows();

    var index = function () { return mutRows().indexOf(row); };
    wireDropZone(r1);
    wireDropZone(r2);
    wireFileTypeGuard(r1, function () { return mutLabel(index(), 1); }, true);
    wireFileTypeGuard(r2, function () { return mutLabel(index(), 2); }, true);
    row.querySelector('.mut-remove').addEventListener('click', function () {
      row.parentNode.removeChild(row);
      renumberRows();
    });
    return row;
  }

  function removeAddedRows() {
    mutRows().slice(1).forEach(function (r) { r.parentNode.removeChild(r); });
    renumberRows();
  }

  if (addRowBtn) {
    addRowBtn.addEventListener('click', function () {
      var row = addMutRow();
      if (row) row.querySelector('.mut-name').select();
    });
  }

  // A row's Read 1 / Read 2: the loaded example's for row 1, else what the inputs hold.
  function rowFiles(row, i) {
    if (i === 0 && _exampleFiles) return { r1: _exampleFiles.mutR1, r2: _exampleFiles.mutR2 };
    var a = row.querySelector('.mut-r1'), b = row.querySelector('.mut-r2');
    return { r1: (a && a.files[0]) || null, r2: (b && b.files[0]) || null };
  }

  // Characters that cannot go in the output file and folder names.
  var BAD_NAME = /[\\\/:*?"<>|]/;

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

    // files: the shared control, then each treated row
    var picks = _exampleFiles ? [
      { f: _exampleFiles.ctrR1, label: 'Control Read 1' },
      { f: _exampleFiles.ctrR2, label: 'Control Read 2' }
    ] : [
      { f: fileCtrR1 && fileCtrR1.files[0], label: 'Control Read 1' },
      { f: fileCtrR2 && fileCtrR2.files[0], label: 'Control Read 2' }
    ];
    var rows = mutRows();
    if (rows.length > MAX_SAMPLES) errs.push('A batch holds at most ' + MAX_SAMPLES + ' treated samples.');
    rows.forEach(function (row, i) {
      var rf = rowFiles(row, i);
      picks.push({ f: rf.r1, label: mutLabel(i, 1) }, { f: rf.r2, label: mutLabel(i, 2) });
    });

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

    // Sample names name each run's files, and its folder in the batch zip, so they must be
    // present, unique and usable in a file name.
    var seen = {};
    rows.forEach(function (row, i) {
      var name = row.querySelector('.mut-name').value.trim();
      var who  = rows.length > 1 ? 'Sample ' + (i + 1) + ': sample name' : 'Sample name';
      if (!name) { errs.push(who + ' is required.'); return; }
      if (BAD_NAME.test(name)) errs.push(who + ' "' + name + '" cannot contain \\ / : * ? " < > |.');
      var key = name.toLowerCase();
      if (seen[key]) errs.push(who + ' "' + name + '" is already used by sample ' + seen[key] + '.');
      else seen[key] = i + 1;
    });

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

  // Bumped by resetInputs(), so an example still loading when the form is reset is dropped
  // instead of filling the form afterwards.
  var exampleToken = 0;

  // Loads the example into the form, ready to submit. It does not start the run.
  function runAction(gene, sample, target) {
    gene   = gene   || EXAMPLE.gene;
    sample = sample || EXAMPLE.sample;
    target = target || EXAMPLE.target;
    var token = exampleToken;

    clearError();
    if (demoNote) demoNote.textContent = 'Loading example data…';
    if (submitBtn) submitBtn.disabled = true;

    return fetchExample(gene).then(function (loaded) {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () {
          if (token !== exampleToken) { resolve(null); return; }   // reset meanwhile
          var seq = parseFasta(reader.result);
          console.log('[app.js] example reference length:', seq.length);

          if (fullseqTA)  fullseqTA.value = seq;
          refSequence = seq;
          if (refLenSpan) refLenSpan.textContent = seq.length.toLocaleString() + ' bp';

          // the example is a single treated sample
          removeAddedRows();
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
      if (token !== exampleToken) return null;   // reset meanwhile
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

  // ---- reset ----
  // Puts the input page back as it first loads: every field and option at its default,
  // one treated-sample row, no files, no example. Runs on every page load too, so a
  // refresh starts from an empty form rather than one the browser half put back.
  function resetInputs() {
    exampleToken++;
    removeAddedRows();
    var form = document.getElementById('analysisForm');
    if (form) form.reset();
    Array.prototype.forEach.call(document.querySelectorAll('#analysisForm .file-name'),
                                 function (el) { el.textContent = ''; });
    _exampleFiles = null;
    refSequence = '';
    if (refLenSpan) refLenSpan.textContent = '';
    if (demoNote) demoNote.textContent = '';
    if (submitBtn) submitBtn.disabled = false;
    clearError();
  }

  var resetBtn = document.getElementById('reset-inputs');
  if (resetBtn) resetBtn.addEventListener('click', resetInputs);
  resetInputs();

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
      // read as validateInputs() reads it: whitespace removed, uppercased
      var target = rgenseqIn ? parseFasta(rgenseqIn.value) : '';
      var gene   = geneIn ? geneIn.value.trim() : '';
      var K      = kIn ? (parseInt(kIn.value) || 11) : 11;

      // the control comes from the loaded example if there is one, else from the inputs
      var ctrR1, ctrR2, rFile;
      if (_exampleFiles) {
        ctrR1 = _exampleFiles.ctrR1;
        ctrR2 = _exampleFiles.ctrR2;
      } else {
        ctrR1 = fileCtrR1 && fileCtrR1.files[0] ? fileCtrR1.files[0] : null;
        ctrR2 = fileCtrR2 && fileCtrR2.files[0] ? fileCtrR2.files[0] : null;
      }

      // one job per treated row, run in order against the same control
      var jobs = mutRows().map(function (row, i) {
        var rf = rowFiles(row, i);
        return { sample: row.querySelector('.mut-name').value.trim(), mutR1: rf.r1, mutR2: rf.r2 };
      });

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
      fillSummary(seq, loc, K);
      lastRun = null;

      // Options are the core's CLI arguments #13–#24, falling back to its defaults. #15
      // (output format) is fixed to SAM by the wasm entry point.
      var commonSel = document.getElementById('commonMode');
      var base = {
        gene:        gene,
        targetStart: st,
        targetEnd:   ed,
        cleavage:    cle,
        k:           K,
        distCut:     numOpt('distCut', 8000),
        // always off: the full alignment SAM is too large to hold in a browser tab
        fullSam:     false,
        minGap:      numOpt('minGap', 400),
        anchorMin:   numOpt('anchorMin', 13),
        cutBetween:  boolOpt('cutBetween', true),
        insFix:      boolOpt('insFix', true),
        insMax:      numOpt('insMax', 0),
        report:      boolOpt('report', true),
        largeDelLen: numOpt('largeDelLen', 50),
        clipRescue:  boolOpt('clipRescue', true),
        commonMode:  commonSel && commonSel.value === 'kmeans' ? 'kmeans' : 'local'
      };

      runBatch(jobs, base, { ref: rFile, ctr1: ctrR1, ctr2: ctrR2 });
    }
    return true;
  }

  // How many samples run at once: the "Run at once" choice, or for Auto as many as fit
  // in memory and processors. A run needs about its uncompressed FASTQs plus 1 GB;
  // gzipped files are taken as 4 times their size. navigator.deviceMemory is the
  // browser's estimate in GB (Chrome reports 8 at most; elsewhere 4 is assumed).
  function parallelRuns(jobs, shared) {
    var sel  = document.getElementById('parallel');
    var pick = sel ? sel.value : 'auto';
    if (pick !== 'auto') return Math.max(1, Math.min(jobs.length, parseInt(pick, 10) || 1));

    var GB = 1024 * 1024 * 1024;
    var size = function (f) { return f ? f.size * (/\.gz$/i.test(f.name) ? 4 : 1) : 0; };
    var perRun = 0;
    jobs.forEach(function (j) {
      perRun = Math.max(perRun, size(shared.ctr1) + size(shared.ctr2) + size(j.mutR1) + size(j.mutR2) + GB);
    });
    var budget = (navigator.deviceMemory || 4) * 0.75 * GB;
    var cpus   = navigator.hardwareConcurrency || 2;
    return Math.max(1, Math.min(jobs.length, cpus, Math.floor(budget / perRun)));
  }

  // Runs the jobs, up to parallelRuns() at a time, each in its own worker; each run uses
  // one thread. The control is analysed again with each sample, because the core compares
  // the two in one run. A sample that fails is recorded and skipped while the others
  // carry on, as CRISPRessoBatch --skip_failed does.
  function runBatch(jobs, base, shared) {
    var parallel = parallelRuns(jobs, shared);
    var results  = new Array(jobs.length);   // { params, result } or { params, error }
    var started = 0, finished = 0;
    var rows = setupProgress(jobs, parallel);
    clients = [];

    function start(i) {
      var job = jobs[i];
      var params = Object.assign({}, base, { sample: job.sample });

      // Passed as File objects; the worker reads and unzips them. labels name each file
      // in error messages.
      var files = { ref: shared.ref, ctr1: shared.ctr1, ctr2: shared.ctr2,
                    mut1: job.mutR1, mut2: job.mutR2 };
      var labels = {
        ref:  'Reference FASTA (' + shared.ref.name + ')',
        ctr1: 'Control Read 1 (' + shared.ctr1.name + ')',
        ctr2: 'Control Read 2 (' + shared.ctr2.name + ')',
        mut1: 'Cas9-treated Read 1 (' + job.mutR1.name + ')',
        mut2: 'Cas9-treated Read 2 (' + job.mutR2.name + ')'
      };
      console.log('[app.js] starting analysis', params);
      rows[i].set(0, 'Preparing…');

      var c = new AnalysisClient({
        onProgress: function (pct, message, detail) { rows[i].set(pct, message, detail); },
        onDone: function (result) {
          console.log('[app.js] %s complete in %ss', job.sample, (result.elapsedMs / 1000).toFixed(1));
          rows[i].end(true, 'Done');
          results[i] = { params: params, result: result };
          ended();
        },
        onError: function (msg) {
          console.warn('[app.js] %s failed: %s', job.sample, msg);
          rows[i].end(false, 'Failed: ' + msg);
          results[i] = { params: params, error: msg };
          ended();
        }
      });
      clients.push(c);
      c.start(params, files, labels);
    }

    // keeps `parallel` runs going until every job has started
    function fill() {
      while (started < jobs.length && started - finished < parallel) start(started++);
    }

    function ended() {
      finished++;
      if (finished < jobs.length) { fill(); return; }
      clients = [];
      var failed = results.filter(function (r) { return r.error; });
      if (failed.length === jobs.length) {
        showError(jobs.length > 1
          ? failed.map(function (r) { return r.params.sample + ': ' + r.error; })
          : 'Analysis error: ' + failed[0].error);
        if (submitBtn) submitBtn.disabled = false;
        showPage('input');
        return;
      }
      finishBatch(results);
    }

    fill();
  }

  // The progress page's bars. One sample: the control and treated bars, since the core
  // aligns the control first, and the result files. A batch: one bar per sample, its
  // status line naming the result file being written. Returns a controller per job, with
  // set(pct, message, detail) and end(ok, message); detail is the worker's progress
  // message (see analysis-client.js).
  function setupProgress(jobs, parallel) {
    var single = document.getElementById('single-progress');
    var batch  = document.getElementById('batch-progress');
    var list   = document.getElementById('batch-progress-rows');
    var note   = document.getElementById('batch-progress-note');
    var many   = jobs.length > 1;
    if (single) single.classList.toggle('d-none', many);
    if (batch)  batch.classList.toggle('d-none', !many);

    if (!many) {
      // Control bar: up to the end of the control's alignment, input copying included.
      // Treated bar: the treated sample's alignment. Result bar: files done of total; in
      // the report stage, before its files open, it also moves with the raw-read check.
      var R = AnalysisClient.STAGE_RANGE;
      var span = function (pct, r0, r1) { return (pct - r0) / (r1 - r0) * 100; };
      var files = null;
      setBar(ctrBar, 0); setBar(mutBar, 0); setBar(resBar, 0, '0/0');
      if (stageEl) stageEl.textContent = 'Preparing…';
      return [{
        set: function (pct, message, detail) {
          var p = Math.max(0, Math.min(100, pct));
          setBar(ctrBar, Math.max(0, Math.min(100, span(p, 0, R.run[1]))));
          setBar(mutBar, Math.max(0, Math.min(100, span(p, R.run2[0], R.run2[1]))));
          if (detail && detail.files) {
            files = detail.files;
            var part = (detail.stage === 'report' && !files.current && detail.frac != null &&
                        files.done < files.total) ? detail.frac : 0;
            setBar(resBar, files.total ? (files.done + part) / files.total * 100 : 0,
                   files.done + '/' + files.total);
          }
          if (stageEl) stageEl.textContent = message || '';
        },
        end: function (ok, message) {
          if (ok) {
            setBar(ctrBar, 100); setBar(mutBar, 100);
            setBar(resBar, 100, files ? files.done + '/' + files.total : '100%');
          }
          if (stageEl) stageEl.textContent = ok ? 'Done!' : message;
        }
      }];
    }

    if (note) {
      note.textContent = jobs.length + ' samples, ' + parallel + ' at a time' +
        (parallel > 1 ? ' (each in its own worker).' : '.');
    }
    if (list) list.innerHTML = '';
    return jobs.map(function (job) {
      var row = document.createElement('div');
      row.className = 'batch-prog-row';
      var head = document.createElement('div');
      head.className = 'd-flex align-items-baseline gap-2';
      var name = document.createElement('span');
      name.className = 'progress-label mb-0';
      name.textContent = job.sample;
      var status = document.createElement('span');
      status.className = 'form-help ms-auto text-end';
      status.textContent = 'Waiting';
      head.appendChild(name); head.appendChild(status);
      var track = document.createElement('div');
      track.className = 'progress mb-2';
      track.style.height = '16px';
      var bar = document.createElement('div');
      bar.className = 'progress-bar';
      bar.setAttribute('role', 'progressbar');
      bar.style.width = '0%';
      track.appendChild(bar);
      row.appendChild(head); row.appendChild(track);
      if (list) list.appendChild(row);
      return {
        set: function (pct, message) { setBar(bar, pct); status.textContent = message || ''; },
        end: function (ok, message) {
          setBar(bar, 100);
          bar.classList.add(ok ? 'bg-success' : 'bg-danger');
          status.textContent = message;
          status.classList.toggle('text-danger', !ok);
        }
      };
    });
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
      clients.forEach(function (c) { c.cancel(); });
      clients = [];
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
  // All reads and Aligned per sample, in read pairs, from the core's log, as in the
  // summary table. Bars are labelled; a log scale is offered.

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

    var groups = ['All reads', 'Aligned'];
    var series = [
      { name: 'Control',      key: 'ctr', color: '#5b9bd5' },
      { name: 'Cas9-treated', key: 'mut', color: '#ff6b6b' }
    ];

    var traces = series.map(function (sp) {
      var b = chartData[sp.key] || {};
      var y = [b.total, b.aligned].map(function (v) {
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

    // A log axis cannot show 0 (a sample with no aligned reads, say), so zero bars drop
    // out rather than plotting as -Infinity.
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

  // metrics: read counts parsed from the core's log.
  function updateSummaryChart(metrics) {
    if (!metrics) return;
    chartData = {
      ctr: { total: metrics.ctrTotal, aligned: metrics.ctrAligned },
      mut: { total: metrics.mutTotal, aligned: metrics.mutAligned }
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

  // ---- terminal insertions (TermIns) ----
  // A terminal insertion runs off the end of the read and is soft-clipped, so where it
  // sits and how long it is stay uncertain. "Without TermIns" leaves those pairs out of
  // everything on the page: they leave Reads used, so the other classes become shares of
  // the pairs that remain, and their SAM files drop out of the figures and the viewer.
  // The core's files are not changed; the downloads gain a summary without them.
  var includeTermIns = true;

  // pat from parseMutationSummary(), or a copy without TermIns. In the copy each sample's
  // terminal_insertion_clipped is { n: 0, excluded: pairs left out }, total_analyzed is
  // the pairs that remain and the class percents are recomputed; keys keep their order.
  function applyTermIns(pat) {
    if (includeTermIns) return pat;
    var out = {};
    Object.keys(pat).forEach(function (which) {
      var v = pat[which] || {}, w = {};
      var t    = v.terminal_insertion_clipped ? v.terminal_insertion_clipped.n : 0;
      var used = (v.total_analyzed ? v.total_analyzed.n : 0) - t;
      Object.keys(v).forEach(function (k) { w[k] = v[k]; });
      if (v.total_analyzed) {
        CLASSES.forEach(function (c) {
          if (!v[c.key]) return;
          w[c.key] = { n: v[c.key].n, pct: used ? (v[c.key].n / used * 100).toFixed(2) : 'NA' };
        });
        w.total_analyzed = { n: used, pct: used ? '100.00' : 'NA' };
      }
      w.terminal_insertion_clipped = { n: 0, pct: 'NA', excluded: t };
      out[which] = w;
    });
    return out;
  }

  // The pairs left out of each sample, for the notes: 'N control and M Cas9-treated'.
  function excludedText(pat) {
    var n = function (which) {
      var x = pat[which] && pat[which].terminal_insertion_clipped;
      return (x && x.excluded ? x.excluded : 0).toLocaleString();
    };
    return n('control') + ' control and ' + n('treated') + ' Cas9-treated';
  }

  // The core's mutation_summary.tsv layout, written from an adjusted pattern. The TermIns
  // row becomes terminal_insertion_clipped_excluded, a count outside the percentages.
  function mutationSummaryTsv(pat) {
    var lines = ['sample\tpattern\tread_pairs\tpercent'];
    ['control', 'treated'].forEach(function (which) {
      var v = pat[which] || {};
      Object.keys(v).forEach(function (k) {
        var x = v[k];
        if (x.excluded != null) lines.push([which, k + '_excluded', x.excluded, 'NA'].join('\t'));
        else lines.push([which, k, x.n, x.pct].join('\t'));
      });
    });
    return lines.join('\n') + '\n';
  }

  // The core's output files, plus <prefix>_mutation_summary_no_termins.tsv when TermIns are
  // left out. pat: the adjusted pattern.
  function downloadFiles(outputs, prefix, pat) {
    if (includeTermIns) return outputs;
    var files = {};
    Object.keys(outputs).forEach(function (n) { files[n] = outputs[n]; });
    var text = mutationSummaryTsv(pat);
    files[prefix + '_mutation_summary_no_termins.tsv'] = { size: text.length, text: text };
    return files;
  }

  (function wireTermInsToggle() {
    var on  = document.getElementById('termins-on');
    var off = document.getElementById('termins-off');
    if (!on || !off) return;
    function set(include) {
      if (include === includeTermIns) return;
      includeTermIns = include;
      on.classList.toggle('active', include);
      off.classList.toggle('active', !include);
      // redraw what is on show: the batch summary, then the selected run
      if (!batchRuns.length) return;
      renderBatchSummary(batchRuns);
      showRun(shownRun);
    }
    on.addEventListener('click', function () { set(true); });
    off.addEventListener('click', function () { set(false); });
  })();

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
      body.appendChild(summaryRow(r.label, r.total, r.aligned, pat[r.which] || {}));
    });

    if (note) {
      note.textContent =
        'Table 1. Read pairs per sample. Unmapped is a share of Total reads; the six ' +
        'classes are shares of Reads used. Classes this core does not call \u2014 large ' +
        'insertions, inversions, complex \u2014 are omitted, not zeroed.' +
        (includeTermIns ? '' : ' Without TermIns: ' + excludedText(pat) + ' pairs with a ' +
         'terminal insertion are left out of Reads used and of every figure below.');
    }
  }

  // One table row: label, total, unmapped (with its share of total), reads used (a count),
  // then each class as a share of reads used. v: one sample's classes from
  // parseMutationSummary().
  function summaryRow(label, total, aligned, v) {
    var used = v.total_analyzed ? v.total_analyzed.n : 0;
    var tr   = document.createElement('tr');
    var cells = [
      { text: label, head: true },
      { text: num(total) },
      { text: countPct(total - aligned, total) },
      { text: num(used) }
    ];
    CLASSES.forEach(function (c) {
      var x = v[c.key];
      cells.push({ text: !x ? '—' : x.excluded != null ? 'excluded: ' + x.excluded.toLocaleString()
                                                     : countPct(x.n, used) });
    });
    cells.forEach(function (c) {
      var td = document.createElement('td');
      td.textContent = c.text;
      td.className = c.head ? 'text-start' : 'num';
      tr.appendChild(td);
    });
    return tr;
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
  // split-read files, whose deletions are counted separately; termIns the terminal
  // insertions, dropped without TermIns.
  var NT_SOURCES = {
    control: [
      { suffix: '_site_ctr.sam',      kind: 'local' },
      { suffix: '_site_ctr_sm.sam',   kind: 'local' },
      { suffix: '_site_ctr_clip.sam', kind: 'local', termIns: true },
      { suffix: '_ctr_only.sam',      kind: 'large' },
      { suffix: '_ctr_common.sam',    kind: 'large' }
    ],
    treated: [
      { suffix: '_site_mut.sam',      kind: 'local' },
      { suffix: '_site_mut_sm.sam',   kind: 'local' },
      { suffix: '_site_mut_clip.sam', kind: 'local', termIns: true },
      { suffix: '_mut_only.sam',      kind: 'large' },
      { suffix: '_mut_common.sam',    kind: 'large' }
    ]
  };

  // sizes and patterns feed Figure 5: per-sample indel lengths, and the (TermIns-adjusted)
  // class counts whose Reads used is its denominator.
  var ntState = { pileups: null, sizes: null, patterns: null, largeDelLen: 50,
                  sample: 'treated', halfWidth: 30, cut: null, ref: '' };

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

  // ---- Figure 5: indel length distribution ----
  // One length per read pair, from the SAM files whose pairs the summary table counts:
  //   small insertions and deletions (*_sm.sam): the CIGAR's I or D in either mate, else
  //     the length in the clip-rescue tag (XR:Z:clip_rescue:D10@…);
  //   terminal insertions (*_clip.sam): soft-clipped, so their length is unknown; they get
  //     a bar of their own, and drop out without TermIns;
  //   large deletions kept after the common-with-control test (*_only.sam): the split
  //     read's D. A deletion seen only as a gap between the mates has no exact length; it
  //     is estimated as the pair's span less the median insert size of the WT pairs at
  //     the cut (*_site_*.sam), and drawn apart.
  // The call is the core's XV tag. A pair is keyed by its read name without /1 or /2.

  var SIZE_SOURCES = {
    control: { sm: '_site_ctr_sm.sam', clip: '_site_ctr_clip.sam', large: '_ctr_only.sam', wt: '_site_ctr.sam' },
    treated: { sm: '_site_mut_sm.sam', clip: '_site_mut_clip.sam', large: '_mut_only.sam', wt: '_site_mut.sam' }
  };

  var SIZE_COLOUR = {
    ins:      '#2ca02c',   // small insertions, as in Figure 2
    termIns:  '#ff7f0e',   // terminal insertions, as in Figure 2
    del:      '#d62728',   // small deletions, as in Figure 2
    ldSplit:  '#e3116c',   // large deletions with a split read, as in Figure 2
    ldGap:    '#f4a6c8'    // large deletions estimated from the gap between the mates
  };

  // Gathers each pair of a SAM text into pairs[key] = { call, ins, del, rescue, span }:
  // the longest I and D in either mate's CIGAR, the clip-rescue tag and |TLEN|.
  function samPairs(text, pairs) {
    if (!text) return pairs;
    text.split('\n').forEach(function (line) {
      if (!line || line.charAt(0) === '@') return;
      var f = line.split('\t');
      if (f.length < 11) return;
      var key = f[0].replace(/\/[12](?=\||$)/, '');
      var p = pairs[key] || (pairs[key] = { call: '', ins: 0, del: 0, rescue: '', span: 0, first: false });
      for (var t = 11; t < f.length; t++) {
        if (f[t].slice(0, 5) === 'XV:Z:') p.call = f[t].slice(5);
        else if (f[t].slice(0, 5) === 'XR:Z:') p.rescue = f[t].slice(5);
      }
      var re = /(\d+)([MIDNSHP=X])/g, m;
      while ((m = re.exec(f[5])) !== null) {
        var len = parseInt(m[1], 10);
        if (m[2] === 'I' && len > p.ins) p.ins = len;
        if ((m[2] === 'D' || m[2] === 'N') && len > p.del) p.del = len;
      }
      var span = Math.abs(parseInt(f[8], 10) || 0);
      if (span > p.span) p.span = span;
    });
    return pairs;
  }

  // Median |TLEN| of the WT pairs: the usual insert size, for the gap estimate. 0 if none.
  function medianInsert(text) {
    var pairs = samPairs(text, Object.create(null)), spans = [];
    Object.keys(pairs).forEach(function (k) {
      if (pairs[k].call === 'WT' && pairs[k].span) spans.push(pairs[k].span);
    });
    if (!spans.length) return 0;
    spans.sort(function (a, b) { return a - b; });
    return spans[spans.length >> 1];
  }

  // One sample's lengths: counts by length for ins, del, ldSplit and ldGap; termIns and
  // the pairs whose length could not be read (unknownIns, unknownDel) as plain counts.
  function buildIndelSizes(outputs, prefix, which) {
    var src  = SIZE_SOURCES[which];
    var text = function (suffix) { var o = outputs[prefix + suffix]; return o ? o.text : ''; };
    var out  = { ins: {}, del: {}, ldSplit: {}, ldGap: {},
                 termIns: 0, unknownIns: 0, unknownDel: 0, insert: 0 };
    var add  = function (map, len) { map[len] = (map[len] || 0) + 1; };

    var small = samPairs(text(src.sm), Object.create(null));
    Object.keys(small).forEach(function (k) {
      var p = small[k], r = /([ID])(\d+)@/.exec(p.rescue);
      if (p.call === 'INS') {
        var li = p.ins || (r && r[1] === 'I' ? parseInt(r[2], 10) : 0);
        if (li) add(out.ins, li); else out.unknownIns++;
      } else if (p.call === 'DEL') {
        var ld = p.del || (r && r[1] === 'D' ? parseInt(r[2], 10) : 0);
        if (ld) add(out.del, ld); else out.unknownDel++;
      }
    });

    out.termIns = Object.keys(samPairs(text(src.clip), Object.create(null))).length;

    var large = samPairs(text(src.large), Object.create(null));
    out.insert = medianInsert(text(src.wt));
    Object.keys(large).forEach(function (k) {
      var p = large[k];
      if (p.del) { add(out.ldSplit, p.del); return; }
      var est = out.insert ? p.span - out.insert : 0;
      if (est > 0) add(out.ldGap, est); else out.unknownDel++;
    });
    return out;
  }

  // Categories for the x axis: each length below `exact` (the large-deletion length) on
  // its own, up to the longest seen; longer ones in bins that widen 1-2-5 per decade, up to
  // the one holding maxLen, so 3 bp and 3 kb fit on one axis. Each is { lo, hi, label }.
  var SIZE_EDGES = [100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];

  function sizeBins(lengths, exact) {
    var maxSmall = 0, maxLen = 0, bins = [];
    lengths.forEach(function (l) {
      if (l < exact && l > maxSmall) maxSmall = l;
      if (l > maxLen) maxLen = l;
    });
    for (var l = 1; l <= maxSmall; l++) bins.push({ lo: l, hi: l, label: String(l) });
    if (maxLen < exact) return bins;

    var kb = function (v) { return v >= 1000 ? (v / 1000) + ' kb' : v + ' bp'; };
    var edges = [exact].concat(SIZE_EDGES.filter(function (e) { return e > exact; }));
    for (var i = 0; i < edges.length && edges[i] <= maxLen; i++) {
      var lo = edges[i], next = edges[i + 1];
      if (next === undefined) { bins.push({ lo: lo, hi: Infinity, label: '≥' + kb(lo) }); break; }
      var label = lo >= 1000 ? (lo / 1000) + '–' + (next / 1000) + ' kb'
                             : lo + '–' + (next - 1);
      bins.push({ lo: lo, hi: next - 1, label: label });
    }
    return bins;
  }

  // Bar heights for one series over the bins: y as % of Reads used, counts for the hover.
  function binSeries(map, bins, used) {
    var n = bins.map(function () { return 0; });
    Object.keys(map).forEach(function (len) {
      var l = +len;
      for (var i = 0; i < bins.length; i++) {
        if (l >= bins[i].lo && l <= bins[i].hi) { n[i] += map[len]; break; }
      }
    });
    return { y: n.map(function (c) { return used ? c / used * 100 : 0; }), counts: n };
  }

  function renderIndelSizes() {
    var mount = document.getElementById('indelsize-chart');
    var empty = document.getElementById('indelsize-empty');
    var note  = document.getElementById('indelsize-note');
    if (!mount) return;

    var which = ntState.sample;
    var sz    = ntState.sizes ? ntState.sizes[which] : null;
    var v     = ntState.patterns ? (ntState.patterns[which] || {}) : {};
    var used  = v.total_analyzed ? v.total_analyzed.n : 0;
    var termIns = includeTermIns && sz ? sz.termIns : 0;

    var count = function (map) {
      return Object.keys(map || {}).reduce(function (a, k) { return a + map[k]; }, 0);
    };
    var nIns = sz ? count(sz.ins) + termIns + sz.unknownIns : 0;
    var nDel = sz ? count(sz.del) + count(sz.ldSplit) + count(sz.ldGap) + sz.unknownDel : 0;

    var why = (!sz || !used) ? 'No read pairs analysed for this sample.'
            : !(nIns + nDel)  ? 'No insertions or deletions in this sample.'
            : !plotlyAvailable() ? 'Plotly could not be loaded, so this plot is unavailable.'
            : null;
    if (why) {
      if (window.Plotly) window.Plotly.purge(mount);
      mount.innerHTML = '';
      if (empty) { empty.textContent = why; empty.classList.remove('d-none'); }
      if (note) note.textContent = '';
      return;
    }
    if (empty) empty.classList.add('d-none');

    var exact = ntState.largeDelLen;
    var keys  = function (map) { return Object.keys(map).map(Number); };
    var insBins = sizeBins(keys(sz.ins), exact);
    var delBins = sizeBins(keys(sz.del).concat(keys(sz.ldSplit), keys(sz.ldGap)), exact);

    // Pairs without a length go in a last category, past the lengths: terminal
    // insertions, and any indel whose length could not be read.
    var insX = insBins.map(function (b) { return b.label; });
    var delX = delBins.map(function (b) { return b.label; });
    if (termIns) insX.push('TermIns');
    if (sz.unknownIns) insX.push('unknown');
    if (sz.unknownDel) delX.push('unknown');

    var pad = function (series, n) {
      while (series.y.length < n) { series.y.push(0); series.counts.push(0); }
      return series;
    };
    // customdata: [pairs, the category as the hover names it]
    var bar = function (name, x, series, colour, axis) {
      return {
        type: 'bar', name: name, x: x, y: series.y,
        customdata: x.map(function (c, i) {
          return [series.counts[i], /^\d+(\u2013\d+)?$/.test(c) ? c + ' bp' : c];
        }),
        xaxis: axis.x, yaxis: axis.y,
        marker: { color: colour, line: { width: 0 } },
        hovertemplate: '%{customdata[1]}: %{y:.2f}% (%{customdata[0]:,} pairs)<extra>' + name + '</extra>'
      };
    };
    // one value at a single category (TermIns, unknown), zero elsewhere
    var lone = function (x, at, n) {
      var s = { y: x.map(function () { return 0; }), counts: x.map(function () { return 0; }) };
      var i = x.indexOf(at);
      s.counts[i] = n; s.y[i] = n / used * 100;
      return s;
    };

    var A = { x: 'x', y: 'y' }, B = { x: 'x2', y: 'y2' };
    var traces = [bar('Insertion', insX, pad(binSeries(sz.ins, insBins, used), insX.length),
                      SIZE_COLOUR.ins, A)];
    if (termIns) {
      traces.push(bar('Terminal insertion (length unknown)', insX, lone(insX, 'TermIns', termIns),
                      SIZE_COLOUR.termIns, A));
    }
    if (sz.unknownIns) {
      traces.push(bar('Insertion, length not read', insX, lone(insX, 'unknown', sz.unknownIns),
                      '#9aa5b1', A));
    }
    traces.push(bar('Deletion', delX, pad(binSeries(sz.del, delBins, used), delX.length),
                    SIZE_COLOUR.del, B));
    traces.push(bar('Large deletion (split read)', delX, pad(binSeries(sz.ldSplit, delBins, used), delX.length),
                    SIZE_COLOUR.ldSplit, B));
    traces.push(bar('Large deletion (mate gap, estimated)', delX, pad(binSeries(sz.ldGap, delBins, used), delX.length),
                    SIZE_COLOUR.ldGap, B));
    if (sz.unknownDel) {
      traces.push(bar('Deletion, length not read', delX, lone(delX, 'unknown', sz.unknownDel),
                      '#9aa5b1', B));
    }
    // empty series stay out of the legend
    traces = traces.filter(function (t) { return t.customdata.some(function (c) { return c[0] > 0; }); });

    var ink   = cssVar('--text-primary',   '#111827');
    var muted = cssVar('--text-secondary', '#6b7280');
    var grid  = cssVar('--border',         '#e5e7eb');
    var axis  = { type: 'category', showgrid: false, zeroline: false, linecolor: grid,
                  tickfont: { color: muted, size: 10 } };
    var yaxis = { rangemode: 'tozero', ticksuffix: '%', gridcolor: grid, zeroline: false,
                  tickfont: { color: muted, size: 10 } };

    window.Plotly.react(mount, traces, {
      barmode: 'stack',
      bargap: 0.15,
      height: 360,
      margin: { l: 58, r: 20, t: 46, b: 96 },
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      font: { family: 'Inter, system-ui, sans-serif', size: 11, color: ink },
      xaxis:  Object.assign({}, axis, { domain: [0, 0.46], anchor: 'y',
                title: { text: 'Insertion length (bp)', standoff: 8 } }),
      yaxis:  Object.assign({}, yaxis, { anchor: 'x',
                title: { text: 'Frequency (% of reads used)' } }),
      xaxis2: Object.assign({}, axis, { domain: [0.56, 1], anchor: 'y2',
                title: { text: 'Deletion length (bp)', standoff: 8 } }),
      yaxis2: Object.assign({}, yaxis, { anchor: 'x2' }),
      legend: { orientation: 'h', y: -0.3, x: 0, font: { size: 11 }, traceorder: 'normal' },
      // panel titles pinned to each panel's own domain, as in Figure 6
      annotations: [
        { text: 'Insertion size', xref: 'x domain', x: 0.5, xanchor: 'center',
          yref: 'y domain', y: 1, yanchor: 'bottom', yshift: 10, showarrow: false, font: { size: 12 } },
        { text: 'Deletion size', xref: 'x2 domain', x: 0.5, xanchor: 'center',
          yref: 'y2 domain', y: 1, yanchor: 'bottom', yshift: 10, showarrow: false, font: { size: 12 } }
      ]
    }, { responsive: true, displaylogo: false,
         modeBarButtonsToRemove: ['select2d', 'lasso2d'] });

    if (note) {
      var gap = count(sz.ldGap);
      note.textContent =
        'Figure 5. How often each insertion and deletion length occurs, as a share of the ' +
        used.toLocaleString() + ' Reads used in analysis; one length per read pair. Lengths ' +
        'below ' + exact + ' bp each have a bar; longer ones are binned. ' +
        (termIns ? 'Terminal insertions are soft-clipped, so their length is unknown. ' : '') +
        (gap ? gap.toLocaleString() + ' large deletions seen only as a gap between the mates ' +
               'are estimated from the pair\'s span less the median insert size (' +
               sz.insert.toLocaleString() + ' bp). ' : '') +
        'Large deletions also found in the control are left out, as in Table 1.';
    }
  }

  // ---- Figure 6: indel size by position ----

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
        'Figure 6. Mean length of the indels at each reference position \u2014 height is ' +
        'length, not how often. Deletions use a log axis: indigo at the cut, grey for ' +
        'split reads whose deletion spans the base.';
    }
  }

  // ---- Figure 4: mutation position distribution ----

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
        'Figure 4. How often each change occurs at each position, as a share of the reads ' +
        'covering it. Shaded: the \u00b113 bp window the core treats as on-target. Dotted: ' +
        'spanning split-read deletions.';
    }
  }

  // ---- tabs for Figures 4-6 ----
  // Mutation position (Figure 4) first; the size tab holds Figures 5 and 6.
  var indelTab = 'pos';

  function renderIndelTab() {
    // A hidden pane has zero width, so draw only the visible tab, and redraw on switching.
    if (indelTab === 'size') { renderIndelSizes(); renderIndelLengths(); }
    else renderMutationPositions();
  }

  (function wireIndelTabs() {
    var tabs = [
      { btn: 'indel-tab-pos',  pane: 'indel-pane-pos',  key: 'pos'  },
      { btn: 'indel-tab-size', pane: 'indel-pane-size', key: 'size' }
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

  // pat: the class counts, already adjusted for TermIns.
  function updateNucleotide(outputs, prefix, params, refSeq, pat) {
    ntState.ref = refSeq || '';
    ntState.cut = params.targetStart + params.cleavage;  // 1-based first base after the cut
    ntState.largeDelLen = params.largeDelLen || 50;
    ntState.patterns = pat;
    ntState.pileups = {};
    ntState.sizes = {};
    Object.keys(NT_SOURCES).forEach(function (which) {
      var sources = NT_SOURCES[which].map(function (src) {
        var o = outputs[prefix + src.suffix];
        var skip = src.termIns && !includeTermIns;
        return { text: o && !skip ? o.text : '', kind: src.kind };
      });
      ntState.pileups[which] = buildPileup(sources, ntState.ref.length || 1);
      ntState.sizes[which] = buildIndelSizes(outputs, prefix, which);
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
  // runs: one per treated sample, { params, result } or { params, error } for one that
  // failed. The first finished one is shown; with more than one sample, the batch summary
  // above picks which.
  function finishBatch(runs) {
    batchRuns = runs;
    showPage('results');
    renderBatchSummary(runs);
    for (var i = 0; i < runs.length; i++) if (runs[i].result) { showRun(i); return; }
  }

  function showRun(i) {
    var run = batchRuns[i];
    if (!run || !run.result) return;
    lastRun = run.result;
    shownRun = i;
    renderRun(run.result, run.params);
    var pick = document.getElementById('batch-pick');
    if (pick) pick.value = String(i);
    var body = document.getElementById('batch-body');
    if (body) {
      Array.prototype.forEach.call(body.children, function (tr, j) {
        tr.classList.toggle('table-active', j === i);
      });
    }
  }

  // The run's class counts, adjusted for TermIns.
  function runPattern(run) {
    var prefix = run.params.gene + '_' + run.params.sample;
    return applyTermIns(parseMutationSummary((run.result.outputs[prefix + '_mutation_summary.tsv'] || {}).text));
  }

  function renderBatchSummary(runs) {
    var box  = document.getElementById('batch-box');
    var body = document.getElementById('batch-body');
    var pick = document.getElementById('batch-pick');
    var dl   = document.getElementById('batch-dl');
    if (!box || !body) return;
    box.classList.toggle('d-none', runs.length < 2);
    body.innerHTML = '';
    if (pick) pick.innerHTML = '';
    if (runs.length < 2) return;

    runs.forEach(function (run, i) {
      if (run.error) {
        // a failed sample: its name and why, across the row
        var tr = document.createElement('tr');
        var name = document.createElement('td');
        name.className = 'text-start';
        name.textContent = run.params.sample;
        var why = document.createElement('td');
        why.colSpan = 9;
        why.className = 'text-danger';
        why.textContent = 'Failed: ' + run.error;
        tr.appendChild(name); tr.appendChild(why);
        body.appendChild(tr);
        return;
      }
      var m  = run.result.metrics || {};
      var row = summaryRow(run.params.sample, m.mutTotal, m.mutAligned, runPattern(run).treated || {});
      row.addEventListener('click', function () { showRun(i); });
      body.appendChild(row);
      if (pick) {
        var o = document.createElement('option');
        o.value = String(i);
        o.textContent = run.params.sample;
        pick.appendChild(o);
      }
    });
    if (pick) pick.onchange = function () { showRun(parseInt(pick.value, 10)); };
    if (dl) dl.onclick = function () { downloadBatch(runs); };
  }

  // batch_summary.tsv: a control and a treated row per finished sample, counts and
  // percentages of reads used, as in the summary table; a failed sample gets one row
  // with its error.
  function batchSummaryTsv(runs) {
    var head = ['sample', 'status', 'group', 'total_read_pairs', 'unmapped', 'reads_used'];
    CLASSES.forEach(function (c) { head.push(c.key, c.key + '_percent'); });
    head.push('error');
    var lines = [head.join('\t')];
    runs.forEach(function (run) {
      if (run.error) {
        var blank = new Array(head.length - 3).join('\t');
        lines.push([run.params.sample, 'failed', blank, run.error.replace(/\s+/g, ' ')].join('\t'));
        return;
      }
      var pat = runPattern(run), m = run.result.metrics || {};
      [['control', m.ctrTotal, m.ctrAligned], ['treated', m.mutTotal, m.mutAligned]].forEach(function (g) {
        var v = pat[g[0]] || {}, used = v.total_analyzed ? v.total_analyzed.n : 0;
        var row = [run.params.sample, 'ok', g[0], g[1], g[1] - g[2], used];
        CLASSES.forEach(function (c) {
          var x = v[c.key];
          if (!x || x.excluded != null) { row.push('', ''); return; }   // left blank without TermIns
          row.push(x.n, used ? (x.n / used * 100).toFixed(2) : '');
        });
        row.push('');
        lines.push(row.join('\t'));
      });
    });
    return lines.join('\n') + '\n';
  }

  // One zip: batch_summary.tsv, and each finished sample's files in a folder named after it.
  // Without TermIns the summary is batch_summary_no_termins.tsv, and each folder also holds
  // the sample's summary without them.
  function downloadBatch(runs) {
    if (typeof fflate === 'undefined' || !fflate.zipSync) {
      showError('Zip support is unavailable; download each sample\'s files from its results.');
      return;
    }
    var files = {};
    files[includeTermIns ? 'batch_summary.tsv' : 'batch_summary_no_termins.tsv'] =
      fflate.strToU8(batchSummaryTsv(runs));
    runs.forEach(function (run) {
      if (!run.result) return;
      var prefix = run.params.gene + '_' + run.params.sample;
      var outs = downloadFiles(run.result.outputs || {}, prefix, runPattern(run));
      Object.keys(outs).forEach(function (n) {
        if (outs[n].size > 0) files[run.params.sample + '/' + n] = fflate.strToU8(outs[n].text);
      });
    });
    try {
      var zipped = fflate.zipSync(files, { level: 6 });
      saveBlob(new Blob([zipped], { type: 'application/zip' }), runs[0].params.gene + '_batch_results.zip');
    } catch (e) {
      showError('Could not build the zip: ' + (e.message || e));
    }
  }

  // Draws one run's results: the summary table and figures below the batch summary.
  function renderRun(result, params) {
    var outputs = result.outputs || {};
    var prefix  = params.gene + '_' + params.sample;
    var pat     = applyTermIns(parseMutationSummary((outputs[prefix + '_mutation_summary.tsv'] || {}).text));

    // in page order, labelled as the page captions them
    fillSummaryTable(pat, result.metrics);                          // Table 1
    updateSummaryChart(result.metrics);                             // Figure 1
    renderPies(pat);                                                // Figure 2
    renderRescueNote(result.metrics, params);                       // under Figure 2
    updateNucleotide(outputs, prefix, params, refSequence, pat);    // Figures 3–6
    renderDownloads(batchRuns);                                     // result files
    renderViewer(outputs, prefix, params, result.refLen);           // Figure 7
  }

  // How many terminal-clip pairs clip rescue re-called per sample, and which
  // common-with-control test ran. The core prints a rescue line only for a sample that
  // had terminal-clip pairs.
  function renderRescueNote(metrics, params) {
    var el = document.getElementById('rescue-note');
    if (!el) return;
    var test = params.commonMode === 'kmeans'
      ? 'Common-with-control test: k-means.'
      : 'Common-with-control test: pair-based, within max(20 bp, 2% of the deletion length).';
    if (!params.clipRescue) {
      el.textContent = 'Clip rescue off: small indels at a read end count as terminal insertions. ' + test;
      return;
    }
    var one = function (label, r) {
      return !r ? label + ': no terminal-clip pairs'
        : label + ': ' + r.rescued.toLocaleString() + ' of ' + r.clipped.toLocaleString() +
          ' terminal-clip pairs re-called (' + r.del.toLocaleString() + ' deletions, ' +
          r.ins.toLocaleString() + ' insertions)';
    };
    el.textContent = 'Clip rescue — ' + one('control', metrics && metrics.ctrRescue) + '; ' +
                     one('Cas9-treated', metrics && metrics.mutRescue) + '. ' + test;
  }

  // ---- result file downloads ----
  // One zip per finished sample, <gene>_<sample>.zip, holding that sample's result files
  // (and its summary without TermIns when they are left out). Download all saves every
  // sample's zip; Individual files lists them. A zip is built when it is saved.

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  // Saves a blob as a file through a temporary link. Used for the result zips and the
  // example download. The URL is revoked a minute later, once the download has started.
  function saveBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  // A finished run's zip: { name, prefix, files: { name: output }, count, bytes }, bytes
  // being the files' size before compression.
  function sampleZip(run) {
    var prefix = run.params.gene + '_' + run.params.sample;
    var outs = downloadFiles(run.result.outputs || {}, prefix, runPattern(run));
    var z = { name: prefix + '.zip', prefix: prefix, files: {}, count: 0, bytes: 0 };
    Object.keys(outs).sort().forEach(function (n) {
      if (!(outs[n].size > 0)) return;
      z.files[n] = outs[n]; z.count++; z.bytes += outs[n].size;
    });
    return z;
  }

  // zipSync comes from the vendored fflate bundle, the same one used for gunzip.
  function saveSampleZip(z) {
    if (typeof fflate === 'undefined' || !fflate.zipSync) {
      showError('Zip support is unavailable, so the result files cannot be downloaded.');
      return;
    }
    var data = {};
    Object.keys(z.files).forEach(function (n) { data[n] = fflate.strToU8(z.files[n].text); });
    try {
      saveBlob(new Blob([fflate.zipSync(data, { level: 6 })], { type: 'application/zip' }), z.name);
    } catch (e) {
      showError('Could not build ' + z.name + ': ' + (e.message || e));
    }
  }

  function renderDownloads(runs) {
    var box    = document.getElementById('download-box');
    var list   = document.getElementById('dl-list');
    var note   = document.getElementById('dl-note');
    var allBtn = document.getElementById('dl-all');
    var toggle = document.getElementById('dl-toggle');
    if (!list || !box) return;

    list.innerHTML = '';
    list.classList.add('d-none');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');

    var zips = runs.filter(function (r) { return r.result; }).map(sampleZip)
                   .filter(function (z) { return z.count > 0; });
    if (!zips.length) { box.classList.add('d-none'); return; }
    box.classList.remove('d-none');

    zips.forEach(function (z) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-outline-secondary btn-sm';
      b.textContent = z.name;
      var span = document.createElement('span');
      span.className = 'text-secondary ms-1';
      span.textContent = '(' + z.count + ' files, ' + fmtBytes(z.bytes) + ')';
      b.appendChild(span);
      b.addEventListener('click', function () { saveSampleZip(z); });
      list.appendChild(b);
    });

    if (note) {
      note.textContent = (zips.length > 1 ? zips.length + ' zips, one per sample. ' : '') +
        'Sizes are before compression. SAM files open in IGV as they are; ' +
        (zips.length > 1 ? 'each sample\'s _report.html' : zips[0].prefix + '_report.html') +
        ' is a standalone report.';
    }

    if (toggle) {
      toggle.onclick = function () {
        var hidden = list.classList.toggle('d-none');
        toggle.setAttribute('aria-expanded', String(!hidden));
      };
    }

    // one zip after another: browsers can drop downloads started in the same instant
    if (allBtn) {
      allBtn.onclick = function () {
        zips.forEach(function (z, i) { setTimeout(function () { saveSampleZip(z); }, i * 400); });
      };
    }
  }

  // ---- Figure 7: alignment viewer ----
  var viewer = null;

  var TRACKS = [
    { suffix: '_mut_only.sam',    label: 'Treated-only large deletions', hint: 'Judged CRISPR-induced' },
    { suffix: '_mut_common.sam',  label: 'Common (removed)',             hint: 'Also in the control, so treated as a PCR artefact' },
    { suffix: '_ctr_only.sam',    label: 'Control-only',                 hint: 'Deletions seen only in the control' },
    { suffix: '_site_mut.sam',    label: 'Treated reads at the cut',     hint: 'Normal reads spanning the cleavage site' },
    { suffix: '_site_mut_sm.sam', label: 'Treated small indels',         hint: 'Indels / substitutions within ±13 bp of the cut' },
    { suffix: '_site_mut_clip.sam', label: 'Treated terminal insertions (clip)', hint: 'Reads soft-clipped at the cut that clip rescue did not re-call', termIns: true }
  ];

  function renderViewer(outputs, prefix, params, refLen) {
    var mount = document.getElementById('viewer-mount');
    var bar   = document.getElementById('viewer-tracks');
    var tools = document.getElementById('viewer-tools');
    if (!mount || !window.ExCasViewer) return;

    var available = [];
    TRACKS.forEach(function (t) {
      if (t.termIns && !includeTermIns) return;
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
    runs: function () { return batchRuns; },
    showRun: showRun,
    addSample: addMutRow,
    parseMutationSummary: parseMutationSummary
  };

  console.log('[app.js] initialisation complete');
})();
