// Builds a run's summary table and headline rates from the core's
// mutation_summary.tsv and its log; nothing is recounted from the reads.

// The classes the core reports. Classes it does not detect (large insertions,
// inversions, complex events, precise or partial editing) are left out, not zero.
export const CLASSES = [
  { key: 'wt',                         label: 'WT' },
  { key: 'small_insertion',            label: 'Ins' },
  { key: 'small_deletion',             label: 'Del' },
  { key: 'substitution',               label: 'Sub' },
  { key: 'large_deletion',             label: 'LargeDel' },
  { key: 'terminal_insertion_clipped', label: 'TermIns' }
];

export function parseMutationSummary(text) {
  const v = { control: {}, treated: {} };
  if (!text) return v;
  for (const line of text.trim().split('\n').slice(1)) {
    const f = line.split('\t');
    if (v[f[0]]) v[f[0]][f[1]] = { n: parseInt(f[2], 10) || 0, pct: f[3] };
  }
  return v;
}

const pct = (n, d) => (d ? +((n / d) * 100).toFixed(4) : null);

// The summary table, one object per sample. Unmapped and used are shares of the
// total reads; the six classes are shares of the used reads.
export function summaryTable(patterns, metrics) {
  const rows = [
    { which: 'control', label: 'Control',      total: metrics.ctrTotal, aligned: metrics.ctrAligned },
    { which: 'treated', label: 'Cas9-treated', total: metrics.mutTotal, aligned: metrics.mutAligned }
  ];

  return rows.map((r) => {
    const v = patterns[r.which] || {};
    const used = v.total_analyzed ? v.total_analyzed.n : 0;
    const unmapped = (r.total != null && r.aligned != null) ? r.total - r.aligned : null;

    const classes = {};
    for (const c of CLASSES) {
      const x = v[c.key];
      classes[c.key] = x
        ? { label: c.label, reads: x.n, percent_of_used: pct(x.n, used) }
        : null;                              // not in this run's TSV
    }

    return {
      sample: r.which,
      label: r.label,
      total_read_pairs: r.total,
      aligned: r.aligned,
      unmapped,
      unmapped_percent_of_total: unmapped == null ? null : pct(unmapped, r.total),
      reads_used: used,
      reads_used_percent_of_total: pct(used, r.total),
      classes
    };
  });
}

// The rates as the core's log prints them. The control's unfiltered spanning rate
// is not in mutation_summary.tsv, so it comes only from here.
export function headline(metrics) {
  return {
    control_alignment_rate: metrics.ctrAlignRate,
    treated_alignment_rate: metrics.mutAlignRate,
    control_spanning_percent: metrics.ctrSpanningPct,
    control_small_indel_percent: metrics.ctrSmallIndelPct,
    treated_large_deletion_percent: metrics.mutLargeDelPct,
    treated_small_indel_percent: metrics.mutSmallIndelPct,
    timing_seconds: {
      control_alignment: metrics.ctrAlignSec,
      treated_alignment: metrics.mutAlignSec,
      post_processing: metrics.postSec,
      total: metrics.wholeSec
    }
  };
}
