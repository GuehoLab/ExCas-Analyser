// Per-position counts from the core's SAM files (buildPileup), and the window of them
// around the cut that mutation_profile returns (profile).

import { promises as fsp } from 'node:fs';
import path from 'node:path';

// Each sample's SAM files: the reads the summary table counts as used, plus the
// *_common deletions the table leaves out. 'large' marks split-read files, whose
// deletions are tallied apart from the local ones.
export const SAM_SOURCES = {
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

// Walk each read's CIGAR and count, per 1-based reference position: coverage, the
// read's base there, deletions, and insertions just after it. Deleted bases count
// toward coverage.
export function buildPileup(sources, refLen) {
  const cov = new Int32Array(refLen + 2);
  const delLarge = new Int32Array(refLen + 2);
  const delLocal = new Int32Array(refLen + 2);
  const ins = new Int32Array(refLen + 2);
  const base = {
    A: new Int32Array(refLen + 2), C: new Int32Array(refLen + 2),
    G: new Int32Array(refLen + 2), T: new Int32Array(refLen + 2)
  };
  // Length sums, for the mean indel length per position. Float64 because long
  // deletions summed over many reads overflow an Int32.
  const insSum = new Float64Array(refLen + 2), insN = new Int32Array(refLen + 2);
  const delSumLo = new Float64Array(refLen + 2), delNLo = new Int32Array(refLen + 2);
  const delSumHi = new Float64Array(refLen + 2), delNHi = new Int32Array(refLen + 2);
  let reads = 0;

  for (const src of sources) {
    const text = src.text;
    if (!text) continue;
    const large = (src.kind === 'large');
    const del = large ? delLarge : delLocal;
    const delSum = large ? delSumHi : delSumLo;
    const delN = large ? delNHi : delNLo;

    for (const line of text.split('\n')) {
      if (!line || line.charAt(0) === '@') continue;
      const f = line.split('\t');
      if (f.length < 11) continue;

      const pos = parseInt(f[3], 10);          // SAM POS: 1-based leftmost base
      const cigar = f[5], seq = f[9];
      if (!pos || !cigar || cigar === '*') continue;
      reads++;

      let ref = pos, q = 0, m;
      const re = /(\d+)([MIDNSHP=X])/g;
      while ((m = re.exec(cigar)) !== null) {
        const len = parseInt(m[1], 10), op = m[2];
        if (op === 'M' || op === '=' || op === 'X') {
          for (let i = 0; i < len; i++, ref++, q++) {
            if (ref < 1 || ref > refLen) continue;
            cov[ref]++;
            const c = seq.charAt(q);
            if (base[c]) base[c][ref]++;
          }
        } else if (op === 'D' || op === 'N') {
          for (let j = 0; j < len; j++, ref++) {
            if (ref < 1 || ref > refLen) continue;
            cov[ref]++;
            del[ref]++;
            // every base the deletion covers adds the full deletion length
            delSum[ref] += len;
            delN[ref]++;
          }
        } else if (op === 'I') {
          // an insertion sits between bases; it is credited to the base before it
          if (ref - 1 >= 1 && ref - 1 <= refLen) {
            ins[ref - 1]++;
            insSum[ref - 1] += len;
            insN[ref - 1]++;
          }
          q += len;
        } else if (op === 'S') {
          q += len;
        }
        // H and P consume neither the read nor the reference
      }
    }
  }

  return { cov, delLarge, delLocal, ins, base, reads, insSum, insN, delSumLo, delNLo, delSumHi, delNHi };
}

// Read one sample's SAM files from a run folder and tally them. Files that are not
// there are listed in `missing`.
export async function pileupFromRun(runDir, prefix, sample, refLen) {
  const specs = SAM_SOURCES[sample];
  if (!specs) throw new Error(`sample must be "control" or "treated", got "${sample}".`);

  const sources = [];
  const missing = [];
  for (const s of specs) {
    const file = path.join(runDir, prefix + s.suffix);
    try {
      sources.push({ kind: s.kind, text: await fsp.readFile(file, 'utf8') });
    } catch {
      missing.push(prefix + s.suffix);
    }
  }
  if (!sources.length) {
    throw new Error(`No SAM output found for the ${sample} sample in ${runDir}.`);
  }
  return { pileup: buildPileup(sources, refLen), missing };
}

const r1 = (x) => +x.toFixed(4);

// Per-position counts, and their share of coverage, from cut − halfWidth to
// cut + halfWidth (clipped to the reference).
//   pile       from buildPileup()
//   refSeq     the reference, to find substitutions
//   cut        1-based: the first base after the cut
//   halfWidth  how far the window reaches on each side of cut
export function profile(pile, refSeq, cut, halfWidth) {
  const refLen = refSeq.length;
  const lo = Math.max(1, cut - halfWidth);
  const hi = Math.min(refLen, cut + halfWidth);

  const positions = [];
  for (let p = lo; p <= hi; p++) {
    const c = pile.cov[p];
    const refBase = refSeq.charAt(p - 1);

    // Substitutions: aligned bases here that differ from the reference.
    const matched = pile.base.A[p] + pile.base.C[p] + pile.base.G[p] + pile.base.T[p];
    const same = pile.base[refBase] ? pile.base[refBase][p] : 0;
    const subs = Math.max(0, matched - same);

    const share = (n) => (c ? r1((n / c) * 100) : 0);

    positions.push({
      position: p,
      offset_from_cut: p - cut,
      ref_base: refBase,
      coverage: c,
      base_counts: { A: pile.base.A[p], C: pile.base.C[p], G: pile.base.G[p], T: pile.base.T[p] },
      base_percent: {
        A: share(pile.base.A[p]), C: share(pile.base.C[p]),
        G: share(pile.base.G[p]), T: share(pile.base.T[p])
      },
      insertions: pile.ins[p],
      insertion_percent: share(pile.ins[p]),
      mean_insertion_length: pile.insN[p] ? r1(pile.insSum[p] / pile.insN[p]) : 0,
      deletions_local: pile.delLocal[p],
      deletion_local_percent: share(pile.delLocal[p]),
      mean_deletion_length_local: pile.delNLo[p] ? r1(pile.delSumLo[p] / pile.delNLo[p]) : 0,
      deletions_spanning: pile.delLarge[p],
      deletion_spanning_percent: share(pile.delLarge[p]),
      mean_deletion_length_spanning: pile.delNHi[p] ? r1(pile.delSumHi[p] / pile.delNHi[p]) : 0,
      substitutions: subs,
      substitution_percent: share(subs)
    });
  }

  const covs = positions.map((p) => p.coverage);
  const peak = (field) => positions.reduce((best, p) => (p[field] > best[field] ? p : best), positions[0]);

  return {
    window: { from: lo, to: hi, cut, half_width: halfWidth },
    reads_in_pileup: pile.reads,
    coverage: { min: Math.min(...covs), max: Math.max(...covs) },
    low_coverage_warning: Math.min(...covs) < 100
      ? 'Fewer than 100 reads cover part of this window, so the percentages are not stable.'
      : null,
    peaks: {
      insertion: pickPeak(peak('insertion_percent'), 'insertion_percent'),
      deletion_local: pickPeak(peak('deletion_local_percent'), 'deletion_local_percent'),
      substitution: pickPeak(peak('substitution_percent'), 'substitution_percent')
    },
    positions
  };
}

function pickPeak(p, field) {
  return { position: p.position, offset_from_cut: p.offset_from_cut, percent: p[field] };
}
