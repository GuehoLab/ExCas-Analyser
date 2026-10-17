// Reads the reference FASTA and finds the protospacer, its PAM and the cut site.

import { promises as fsp } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';

// side: the protospacer end (3' or 5') the PAM sits on; 0 = no PAM.
// cut: how many bases in from that end the cut falls.
export const PAMS = [
  { id: 'NGG',     enzyme: 'SpCas9',           pam: 'NGG',     side: 3, cut: 3 },
  { id: 'NGT',     enzyme: 'xCas9',            pam: 'NGT',     side: 3, cut: 3 },
  { id: 'NGAG',    enzyme: 'SpCas9-EQR',       pam: 'NGAG',    side: 3, cut: 3 },
  { id: 'NNGRRT',  enzyme: 'SaCas9',           pam: 'NNGRRT',  side: 3, cut: 3 },
  { id: 'NNAGAAW', enzyme: 'StCas9',           pam: 'NNAGAAW', side: 3, cut: 3 },
  { id: 'TTTV',    enzyme: 'AsCpf1/LbCpf1',    pam: 'TTTV',    side: 5, cut: 18 },
  { id: 'none',    enzyme: 'No PAM',           pam: '',        side: 0, cut: null }
];

export function pamSpec(id) {
  const hit = PAMS.find((p) => p.id.toLowerCase() === String(id || 'NGG').toLowerCase());
  if (!hit) {
    throw new Error(`Unknown PAM "${id}". Choose one of: ` + PAMS.map((p) => p.id).join(', '));
  }
  return hit;
}

// ---- FASTA ----

// Unzips gzip; refuses bzip2, xz and zstd instead of reading them as text.
export function decodeReference(bytes, name) {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try { return gunzipSync(bytes).toString('utf8'); }
    catch (e) { throw new Error(`${name}: could not decompress (${e.message || e}).`); }
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x5a && bytes[2] === 0x68)
    throw new Error(`${name}: bzip2 is not supported. Use gzip (.gz) or an uncompressed FASTA.`);
  if (bytes[0] === 0xfd && bytes[1] === 0x37 && bytes[2] === 0x7a)
    throw new Error(`${name}: xz is not supported. Use gzip (.gz) or an uncompressed FASTA.`);
  if (bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd)
    throw new Error(`${name}: zstd is not supported. Use gzip (.gz) or an uncompressed FASTA.`);
  return bytes.toString('utf8');
}

// The first record's sequence, uppercased, with whitespace removed. Stops at the
// second '>', because the core uses only the first record.
export function parseFasta(text) {
  const out = [];
  let started = false;
  for (const l of String(text).split(/\r?\n/)) {
    if (l.charAt(0) === ';') continue;
    if (l.charAt(0) === '>') {
      if (started) break;
      started = true;
      continue;
    }
    if (!l.trim()) continue;
    out.push(l);
    started = true;
  }
  return out.join('').replace(/\s+/g, '').toUpperCase();
}

export function countFastaRecords(text) {
  let n = 0;
  for (const l of String(text).split(/\r?\n/)) if (l.charAt(0) === '>') n++;
  return n || 1;
}

export function firstRecordName(text) {
  for (const l of String(text).split(/\r?\n/)) {
    if (l.charAt(0) === '>') return l.slice(1).trim().split(/\s+/)[0] || null;
  }
  return null;
}

export async function readReference(file) {
  const bytes = await fsp.readFile(file);
  const text = decodeReference(bytes, path.basename(file));
  const seq = parseFasta(text);
  if (!seq) throw new Error(`${path.basename(file)} contains no sequence.`);
  const bad = seq.replace(/[ACGTN]/g, '');
  if (bad) {
    throw new Error(`${path.basename(file)}: the sequence contains characters other than ` +
                    `A, C, G, T and N (first offender "${bad[0]}").`);
  }
  return {
    file,
    name: firstRecordName(text) || path.basename(file).replace(/\.(fa|fasta)(\.gz)?$/i, ''),
    sequence: seq,
    length: seq.length,
    records: countFastaRecords(text),
    gcPercent: +(100 * (seq.match(/[GC]/g) || []).length / seq.length).toFixed(2)
  };
}

// The record with its sequence on one line, so a core that reads only the first
// sequence line still gets the whole reference.
export function singleLineFasta(gene, sequence) {
  return `>${gene}\n${sequence}\n`;
}

// ---- target location ----

// - st, ed and cut are 1-based; cut is the first base after the cut.
// - cle = cut − st, an offset from st. For NGG it is 3 on the minus strand and
//   length − 3 on the plus strand (17 for a 20-nt guide).
// - The core takes 0-based coordinates; engine.mjs passes st − 1 and ed − 1.
// - The PAM must match, and a target found at more than one site is an error.

const IUPAC = {
  A: 'A', C: 'C', G: 'G', T: 'T',
  R: 'AG', Y: 'CT', S: 'CG', W: 'AT', K: 'GT', M: 'AC',
  B: 'CGT', D: 'AGT', H: 'ACT', V: 'ACG', N: 'ACGT'
};

export function revcomp(s) {
  const m = { A: 'T', C: 'G', G: 'C', T: 'A', N: 'N' };
  let o = '';
  for (let i = s.length - 1; i >= 0; i--) o += (m[s[i]] || 'N');
  return o;
}

function matchIUPAC(seq, pattern) {
  if (seq.length !== pattern.length) return false;
  for (let i = 0; i < pattern.length; i++) {
    const allowed = IUPAC[pattern[i]];
    if (!allowed || allowed.indexOf(seq[i]) < 0) return false;
  }
  return true;
}

function findAll(hay, needle) {
  const out = [];
  let i = hay.indexOf(needle);
  while (i >= 0) { out.push(i); i = hay.indexOf(needle, i + 1); }
  return out;
}

// Returns {st, ed, strand, pam, cut, cle}: st/ed/cut 1-based, pam as it reads on the
// reference's plus strand.
export function locateTarget(ref, target, pam, side, cutOff) {
  const hits = [];
  findAll(ref, target).forEach((i) => hits.push({ i, strand: '+' }));
  const rc = revcomp(target);
  if (rc !== target) findAll(ref, rc).forEach((i) => hits.push({ i, strand: '-' }));
  if (!hits.length) throw new Error('Target sequence not found in the reference (searched both strands).');

  const L = target.length, P = pam ? pam.length : 0, ok = [];
  hits.forEach((h) => {
    const s = h.i + 1, e = h.i + L;
    let pamSeq = null, valid = !pam;
    if (pam) {
      // on the minus strand the PAM is on the other side, reverse-complemented
      const pamAtRight = (side === 3) === (h.strand === '+');
      if (pamAtRight) {
        pamSeq = ref.substr(e, P);
        if (pamSeq.length === P) valid = matchIUPAC(h.strand === '+' ? pamSeq : revcomp(pamSeq), pam);
      } else {
        pamSeq = ref.substr(s - 1 - P, P);
        if (pamSeq.length === P) valid = matchIUPAC(h.strand === '+' ? pamSeq : revcomp(pamSeq), pam);
      }
    }
    if (valid) ok.push({ s, e, strand: h.strand, pam: pamSeq });
  });

  if (pam && !ok.length) {
    throw new Error(`The target sequence was found, but no adjacent ${pam} PAM matches. ` +
                    'Check the PAM choice, or use pam:"none" and set the cleavage offset manually.');
  }
  if (ok.length > 1) {
    throw new Error(`The target sequence occurs at ${ok.length} positions in the reference. ` +
                    'Narrow the reference or use a longer target.');
  }

  const h2 = ok.length ? ok[0] : { s: hits[0].i + 1, e: hits[0].i + L, strand: hits[0].strand, pam: null };
  // The cut is cutOff bases in from the PAM end. The first base after it is
  // s + cutOff when that end is on the left, e − cutOff + 1 when it is on the right.
  let cut = null;
  if (cutOff !== null && cutOff !== undefined && side !== 0) {
    if (side === 3) cut = (h2.strand === '+') ? h2.e - cutOff + 1 : h2.s + cutOff;
    else            cut = (h2.strand === '+') ? h2.s + cutOff : h2.e - cutOff + 1;
  }
  return {
    st: h2.s, ed: h2.e, strand: h2.strand, pam: h2.pam,
    cut, cle: cut === null ? null : cut - h2.s
  };
}

// locateTarget() plus the manual cleavage-offset override.
export function resolveLocation(ref, target, pamId, manualCleavage) {
  const ps = pamSpec(pamId);
  const loc = locateTarget(ref, target, ps.pam, ps.side, ps.cut);
  loc.pamId = ps.id;
  loc.enzyme = ps.enzyme;

  if (manualCleavage !== null && manualCleavage !== undefined && manualCleavage !== '') {
    loc.cle = parseInt(manualCleavage, 10);
    loc.cut = loc.st + loc.cle;          // an offset from st, not a coordinate
  }
  if (loc.cle === null || Number.isNaN(loc.cle)) {
    throw new Error('The cleavage site could not be derived. Pass cleavage_offset explicitly.');
  }
  return loc;
}
