// Puts the core's HTML report into English. kmer_align.wasm writes
// <gene>_<sample>_report.html from a template whose labels and notes are Korean; the
// report draws itself in the browser from that template's script, so each Korean phrase
// is swapped for its English one in the file's text. Phrases not listed stay as they are.
//   Browser / worker: ExCasReportEn.translate(html)
//   Node:             require('docs/report-en.js').translate(html)
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ExCasReportEn = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // [Korean, English], quoted as they appear in the template, so each one matches only
  // where it is meant to. translate() applies the longest first, so a phrase inside a
  // longer one is left to the longer one.
  var PHRASES = [
    ['<html lang="ko">', '<html lang="en">'],

    // class names
    ['"야생형"', '"Wild type"'],
    ['"작은 삽입"', '"Small insertion"'],
    ['"작은 결실"', '"Small deletion"'],
    ['"말단 삽입"', '"Terminal insertion"'],
    ['"치환"', '"Substitution"'],
    ['"대형 결실"', '"Large deletion"'],

    // script comments
    ['/* ---------- 인델 크기 스펙트럼 ---------- */', '/* ---------- indel size spectrum ---------- */'],
    ['/* ---------- 분류 누적 막대 ---------- */', '/* ---------- stacked class bars ---------- */'],
    ['/* ---------- 구간 막대 (대형 결실 / 삽입 길이) ---------- */',
     '/* ---------- binned bars (large deletion / insertion length) ---------- */'],
    ['/* ---------- 페이지 ---------- */', '/* ---------- page ---------- */'],
    ['/* 8 bp 이상 삽입 서열 — 원본 read 스캔 결과를 샘플에 걸쳐 합산 */',
     '/* insertion sequences of 8 bp and up: the raw-read scan, summed over the samples */'],
    ['/* 원본에서 5번도 안 나오면 어느 쪽으로도 단정하지 않습니다 */',
     '/* fewer than 5 raw reads: no verdict either way */'],

    // header and summary tiles
    ['· 샘플 ${S.length}개 · 생성 ${esc(R.date)}',
     '· ${S.length} sample${S.length>1?"s":""} · generated ${esc(R.date)}'],
    ['["절단",p0.cut]', '["cut",p0.cut]'],
    ['<h2>요약</h2>', '<h2>Summary</h2>'],
    ['tile("정렬된 pair",F(totA),"전체 위치")', 'tile("Aligned pairs",F(totA),"all positions")'],
    ['tile("분류 대상",F(totN),"절단 부위를 지나는 pair")',
     'tile("Classified",F(totN),"pairs spanning the cut site")'],
    ['tile("편집된 비율",', 'tile("Edited",'],
    ['"야생형이 아닌 것"', '"not wild type"'],
    ['tile("최대 삽입 길이",', 'tile("Longest insertion",'],
    ['"CIGAR 의 I"', '"I in the CIGAR"'],
    ['tile("8 bp 이상 삽입",', 'tile("Insertions of 8 bp+",'],
    ['"read 수"', '"reads"'],

    // indel size spectrum
    ['<h2>인델 크기 스펙트럼</h2>', '<h2>Indel size spectrum</h2>'],
    ['"인델 크기 스펙트럼"', '"Indel size spectrum"'],
    ['절단 부위 ±13 bp 안의 인델을 길이별로 센 것입니다. 왼쪽이 결실, 오른쪽이 삽입.',
     'Indels within ±13 bp of the cut site, counted by length: deletions on the left, insertions on the right.'],
    ['"결실"', '"Deletion"'],
    ['"삽입"', '"Insertion"'],
    ['>← 결실 (bp)<', '>← Deletion (bp)<'],
    ['>삽입 (bp) →<', '>Insertion (bp) →<'],
    ["${k<0?'결실':'삽입'}", "${k<0?'deletion':'insertion'}"],
    ['data-hi="100">전체</button>', 'data-hi="100">All</button>'],
    ['>y축 로그</button>', '>Log y-axis</button>'],

    // classes per sample
    ['"샘플별 분류 구성"', '"Classes per sample"'],
    ['"분류 구성"', '"Classes"'],
    ['<summary>표로 보기</summary>', '<summary>Show as a table</summary>'],
    ['<th>샘플</th>', '<th>Sample</th>'],
    ['<th class="n">합계</th>', '<th class="n">Total</th>'],

    // large deletion sizes
    ['<h2>대형 결실 크기 분포</h2>', '<h2>Large deletion sizes</h2>'],
    ['split read 의 CIGAR 에 적힌 결실 길이입니다. 대조군을 나란히 두어 아티팩트 수준을 함께 봅니다.',
     'Deletion lengths from the split reads\' CIGARs, with the control alongside to show the artefact level.'],
    ['"처리군"', '"Treated"'],
    ['"대조군"', '"Control"'],
    ['<b>2 kb 이상 구간 주의.</b> only/common 분할은 입력에 민감해 단일 실행으로 재현되지 않습니다.',
     '<b>Take care above 2 kb.</b> The only/common split there is sensitive to the input and does not reproduce from a single run.'],
    ['입력의 1%만 달라져도 최대 30 pp 움직입니다. 이 구간을 보고할 때는 반복 표본으로 변동폭을 함께 제시하십시오.',
     'It moves by up to 30 pp when 1% of the input changes. When you report this range, give its spread across replicates.'],
    ['"2 kb 이상: 재현성 주의"', '"2 kb and up: check reproducibility"'],
    ['"결실 길이 (bp)"', '"Deletion length (bp)"'],

    // insertion sequences of 8 bp and up
    ['<h2>8 bp 이상 삽입 서열</h2>', '<h2>Insertion sequences of 8 bp and up</h2>'],
    ['대조군에서 같은 서열이 비슷하게 나오면 CRISPR 산물이 아니라 공동 증폭된 배경 서열입니다.',
     'A sequence seen about as often in the control is co-amplified background, not a CRISPR product.'],
    ['파이프라인의 only/common 대조군 필터는 <b>대형 결실에만</b> 적용되고 삽입에는 적용되지 않으므로 여기서 확인합니다.',
     'The pipeline\'s only/common control filter applies <b>to large deletions only</b>, not to insertions, so they are checked here.'],
    ['`처리군 원본 ${F(mr)} read, 대조군 원본 ${F(cr)} read 를 직접 세어 백만 read 당 빈도로 비교했습니다.`',
     '`Counted directly in ${F(mr)} treated and ${F(cr)} control raw reads, and compared per million reads.`'],
    ['`원본 FASTQ 를 읽지 못해 판정하지 않았습니다.`',
     '`The raw FASTQ files could not be read, so there is no verdict.`'],
    ['<th class="n">길이</th><th class="n">삽입 호출</th><th class="n">처리군 원본 /M</th>' +
     '<th class="n">대조군 원본 /M</th><th>판정</th><th>서열</th>',
     '<th class="n">Length</th><th class="n">Insertion calls</th><th class="n">Treated raw /M</th>' +
     '<th class="n">Control raw /M</th><th>Verdict</th><th>Sequence</th>'],
    ["'대조군에도 있음 · 아티팩트'", "'Also in the control · artefact'"],
    ['`근거 부족 · 원본 ${mh}회`', '`Weak evidence · ${mh} raw read${mh===1?"":"s"}`'],
    ["'처리군 특이'", "'Treated only'"],
    ['<span class="flag">미확인</span>', '<span class="flag">Not checked</span>'],
    ['8 bp 이상 삽입 없음', 'No insertions of 8 bp or more'],

    // insertion alignment fix, before and after (reports that compare two runs)
    ['<h2>삽입 정렬 수정 전후</h2>', '<h2>Insertion alignment fix, before and after</h2>'],
    ['같은 데이터를 <code>ins_fix=0</code> 과 <code>ins_fix=1</code> 로 돌린 결과입니다.',
     'The same data run with <code>ins_fix=0</code> and with <code>ins_fix=1</code>.'],
    ['"수정 전"', '"Before the fix"'],
    ['"수정 후"', '"After the fix"'],
    ['<summary>분류 비율 전 → 후 (%)</summary>', '<summary>Class shares, before → after (%)</summary>'],
    ['"← 수정 전에는 크기를 붙이지 못하던 구간"', '"← lengths the unfixed alignment could not give"'],
    ['"삽입 길이 (bp) · y축 로그"', '"Insertion length (bp) · log y-axis"']
  ];

  var ORDERED = PHRASES.slice().sort(function (a, b) { return b[0].length - a[0].length; });

  function translate(html) {
    var out = String(html);
    ORDERED.forEach(function (p) { out = out.split(p[0]).join(p[1]); });
    return out;
  }

  return { translate: translate, PHRASES: PHRASES };
});
