# ExCas-Analyzer

**ExCas-Analyzer** is a web tool designed to measure CRISPR-induced large deletions using paired-end amplicon sequencing data.
It compares a Cas9-treated sample with an untreated control, runs entirely in the browser, and includes an MCP server so AI agents can run the same analysis.

---

## Pipeline Overview

1. Locate the target sequence and PAM in the reference on either strand, and derive the cleavage site.
2. Index the reference with k-mers and align the control and Cas9-treated read pairs.
3. Classify read pairs spanning the cleavage site as WT, small insertion, small deletion, substitution or terminal insertion.
4. Re-call small indels that show only as a soft clip at a read end (clip rescue).
5. Detect large deletions from split reads and from read pairs with a large gap between the mates.
6. Remove large deletions that also appear in the control (common deletions), pair by pair or by k-means clusters.
7. Report read counts, charts and SAM files.

---

## ExCas-Analyzer functionality

- Analysis inside the browser (WebAssembly); data never leaves the computer
- Plain or gzipped FASTQ input (including bgzip and multi-member gzip)
- Target search on both strands, with PAM check and automatic cleavage site
- Detection of large deletions from split reads and paired-end gaps
- Removal of deletions that also appear in the control
- Quantification of WT, small insertions, small deletions, substitutions, terminal insertions and large deletions
- Batch mode: up to 4 Cas9-treated samples against one control, run in parallel; a failed sample is skipped
- Summary table per sample: total reads, unmapped, reads used, and each mutation class
- Visualization of:
  - Read pairs per sample, all and aligned (linear or log scale)
  - Mutation class proportions per sample
  - Base composition around the cleavage site
  - Indel size and position distributions
  - Read alignments, coloured by deletion cluster
- The same analysis for AI agents through the MCP server

---

## Installation

No installation is needed to use the web page. To run the page and the MCP server locally:

```bash
git clone https://github.com/{owner}/ExCas-Analyzer
cd ExCas-Analyzer
npm run serve        # web page at http://localhost:8080
npm run mcp          # MCP server
```

- Requires Node.js 18 or newer; nothing else to install
- The files for running locally are in `local/`
- Without Node: `python -m http.server 8080 --directory docs` (web page only)
- Opening `docs/index.html` directly from disk does not work (browsers block its Web Worker)

---

## Usage

ExCas-Analyzer has **2 usage modes**:

### 1. Web page

1. Upload the control Read 1 / Read 2 and the Cas9-treated Read 1 / Read 2, and name the treated sample.
2. Paste the full reference sequence (5' to 3'), or load a FASTA file.
3. Select the PAM and enter the target sequence (5' to 3', without PAM).
4. Enter the gene name, then click **Submit**.

**Batch mode**
- Click **Add treated sample** for each further Cas9-treated sample (up to 4), and give each a name
- Every sample is compared with the same control, reference and target
- **Run at once (-p)** sets how many samples run at the same time, each in its own worker; **Auto** picks from the file sizes and the computer's memory and processors
- A sample that fails is marked failed and skipped; the others still finish
- Sample names must be unique and cannot contain `\ / : * ? " < > |`
- The results start with a batch summary; click a row, or pick a sample, to show its results

### 2. MCP server

```bash
node local/mcp/server.mjs
```

- Claude Code: already set up in `.mcp.json`
- Claude Desktop: add the server to `claude_desktop_config.json` with the full path

```json
{
  "mcpServers": {
    "excas-analyzer": {
      "command": "node",
      "args": ["/absolute/path/to/ExCas-Analyzer/local/mcp/server.mjs"]
    }
  }
}
```

- On Windows, use forward slashes (`C:/Users/you/...`) or double backslashes
- Usual tool order: `inspect_reference` → `locate_target` → `run_analysis` → `mutation_profile`

---

## Example Runs

### Example 1: Web page

- Click **Load example · HPRT1**, then **Submit**
- Runs a simulated HPRT1 amplicon (40,115 read pairs per sample)
- Results appear on the page; **Download all** saves every result file as a zip

### Example 2: MCP server

```jsonc
// locate_target
{ "reference": "docs/testdata/HPRT1/HPRT1.fa", "target_sequence": "AGCCCCCCTTGAGCACACAG", "pam": "NGG" }

// run_analysis
{ "reference": "docs/testdata/HPRT1/HPRT1.fa", "target_sequence": "AGCCCCCCTTGAGCACACAG",
  "control_r1": "docs/testdata/HPRT1/HPRT1_con_1.fastq.gz",
  "control_r2": "docs/testdata/HPRT1/HPRT1_con_2.fastq.gz",
  "treated_r1": "docs/testdata/HPRT1/HPRT1_mut_1.fastq.gz",
  "treated_r2": "docs/testdata/HPRT1/HPRT1_mut_2.fastq.gz",
  "gene": "HPRT1", "sample": "EXP1" }
```

- Uses the same example data as the web page
- `locate_target` returns target 4653–4672, strand −, cleavage offset 3, cut site 4656
- `run_analysis` saves the run in `local/mcp/runs/{run_id}/`
- Returns the run ID, the summary table, headline rates and the files written

---

## Parameters

- Target DNA sequence : Protospacer, 5' to 3', without PAM
- PAM : Used to locate the target and derive the cleavage site (NGG, NGT, NGAG, NNGRRT, NNAGAAW, TTTV, or none)
- Gene name : SAM reference name and first part of the output file names
- Sample name : Second part of the output file names
- K : k-mer length for indexing the reference (default: 11)
- Cleavage offset : Cut position counted from the target start (default: derived from the PAM and strand)
- dist_cut (#13) : Furthest a large deletion's read ends may be from the cut, in bp; caps the deletion size that can be called (default: 8000)
- full_sam (#14) : Also write the full alignment SAM; MCP only, always off on the page (default: off)
- min_gap (#16) : Smallest gap between the mates of a non-split pair to count as a large deletion, in bp (default: 400)
- anchor_min (#17) : Lowest split-read anchor score, length − 4 × mismatches; 0 turns it off (default: 13)
- cut_between (#18) : The cleavage site must lie between the two mates (default: on)
- ins_fix (#19) : Record read-side gaps as insertions (default: on)
- ins_max (#20) : Longest insertion kept; 0 means no limit (default: 0)
- report (#21) : Write the HTML report and TSV tables (default: on)
- large_del_len (#22) : Shortest deletion inside one read that counts as large, in bp; 100 is the paper's definition (default: 50)
- clip_rescue (#23) : Re-call a small indel within 13 bp of a read end, seen only as a soft clip, as the allele seen with full anchors in at least 3 pairs (default: on)
- common_mode (#24) : How a large deletion is judged common with the control: pair-based, with breakpoints within max(20 bp, 2% of its length), or k-means clusters (default: pair-based)
- Run at once (-p) : Web page batch only; how many samples run at the same time, 1–4 (default: Auto)

### Coordinates

- All coordinates shown or entered are 1-based
- The cut site is the first base after the cut
- The cleavage offset counts from the target start: 3 for an NGG guide on the minus strand, 17 on the plus strand

### MCP settings

- EXCAS_MCP_RUNS : Where runs are saved (default: `local/mcp/runs/`)
- EXCAS_MCP_DATA : Folder that relative input paths start from (default: where the server was started)
- EXCAS_MCP_ALLOW_DIR : Only read files inside these folders (`:` separated on Linux/macOS, `;` on Windows)

---

## Result Files

Each file is named `{gene}_{sample}_{suffix}`:

- mutation_summary.tsv – read pairs and percentage per mutation class, per sample
- report.html – standalone HTML report
- report.tsv – run parameters and counts per class, tab-separated
- mut_only.sam – large deletions found only in the treated sample (CRISPR-induced)
- mut_common.sam – large deletions also found in the control (removed)
- ctr_only.sam / ctr_common.sam – the same for the control
- site_mut.sam / site_ctr.sam – WT read pairs spanning the cleavage site
- site_mut_sm.sam / site_ctr_sm.sam – small indels and substitutions within ±13 bp of the cut
- site_mut_clip.sam / site_ctr_clip.sam – reads at the cut with a soft-clipped end (terminal insertions)
- mut.sam / ctr.sam – full alignment (only with full_sam)

**Download batch** saves one zip:

- batch_summary.tsv – per sample: a control and a treated row with counts and percentages per class, or one row marked failed with the reason
- {sample}/ – each finished sample's files, as above

MCP runs also save:

- run.json – inputs, coordinates, options and results
- stdout.log – the analysis log
- reference.fa – the reference used by the run

---

## MCP Server Tools

- inspect_reference : Name, length, GC content and record count of a FASTA
- locate_target : Finds the target on either strand, checks the PAM, gives the cut site
- run_analysis : Full control vs. treated run; returns the summary and a run ID
- list_runs : Stored runs, newest first
- get_run : One run's inputs, coordinates, options, results and files
- read_output : Part of an output file (SAM, TSV, HTML report or log)
- mutation_profile : Per-position coverage, bases and indels around the cut

---

## Limitations

- Not detected: large insertions, inversions, complex events, precise / partial editing
- RAM: about the uncompressed FASTQ size plus 1 GB per run, so a batch running 4 at once needs about 4 times that; use a desktop browser
- Each run uses one processor thread; a batch is faster only by running samples side by side
- Batch mode: the control is analysed again with each sample, because the core compares the two in one run
- Offline: the analysis works, but charts and styling load from CDNs
- MCP: tool calls run one at a time (one call is one run), and a run cannot be stopped once started

---

## Repository Layout

```
docs/                 web page served by GitHub Pages
  kmer_align.wasm     the analysis core (WebAssembly)
  testdata/HPRT1/     example data for Load example
  .nojekyll           GitHub Pages serves the files as they are
local/                files for running locally
  serve.mjs           local web server for docs/
  mcp/                MCP server
package.json          npm run serve / npm run mcp
.mcp.json             registers the MCP server for Claude Code
LICENSE               licence
```
