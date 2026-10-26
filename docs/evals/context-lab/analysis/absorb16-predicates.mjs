#!/usr/bin/env node
// Test of M7's absorptions from pull request 16 (rulings 0109-0111) and of the triage's verdicts of
// "already covered", pre-registered in 0110 before the run it judges. It applies M2 rule 4 to its own
// probes first: a probe that does not separate readers holding the corpus from readers holding none
// counts for nothing in a change's favour, and still counts against it.
//
// usage: node absorb16-predicates.mjs <run-dir> [--json]

import fs from "node:fs";
import path from "node:path";

const [runDir, ...flags] = process.argv.slice(2);
if (!runDir) { console.error("usage: node absorb16-predicates.mjs <run-dir> [--json]"); process.exit(2); }
const result = JSON.parse(fs.readFileSync(path.join(runDir, "RESULT.json"), "utf8"));
const record = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8"));

// The two corpora must be the pinned ones, or the run compared nothing.
const BASE_REV = "5671948ca354e3126f7b052a5c2964195f77c59e";
const HEAD_REV = "f137df5043c0d139a0862c28e7ad4a21771e4846";
const rev = (id) => record.variants?.[id]?.revision;
if (rev("corpus-m7-base") !== BASE_REV || rev("corpus-m7-head") !== HEAD_REV) {
	console.log(`INVALID: variants held base ${rev("corpus-m7-base")} and head ${rev("corpus-m7-head")}, not the pinned ${BASE_REV} and ${HEAD_REV}`);
	process.exit(1);
}

// A cell meets a probe when its two judges' mean is at least 1.5 of 2. Absent answers are scored 0 by
// the tally and count as not met; incomplete values are left out of every count and listed.
const MET = 1.5;
const EPS = 1e-9;
const TARGET = ["Q1", "Q2", "Q3"];
const COVERED = ["Q4", "Q5", "Q6", "Q7"];
const GUARD = ["Q8"];
const ALL = [...TARGET, ...COVERED, ...GUARD];
const ARMS = ["control", "m7-base", "m7-head"];

// Two-sided Fisher exact test on a/n1 against b/n2, summing tables no more likely than the observed.
const lf = (n) => { let s = 0; for (let i = 2; i <= n; i++) s += Math.log(i); return s; };
const fisher = (a, n1, b, n2) => {
	const k = a + b, n = n1 + n2;
	const p = (x) => Math.exp(lf(n1) - lf(x) - lf(n1 - x) + lf(n2) - lf(k - x) - lf(n2 - k + x) - (lf(n) - lf(k) - lf(n - k)));
	const p0 = p(a);
	let sum = 0;
	for (let x = Math.max(0, k - n2); x <= Math.min(k, n1); x++) { const px = p(x); if (px <= p0 * (1 + 1e-9)) sum += px; }
	return Math.min(1, sum);
};
const values = (arm, probe) => Object.entries(result.cellValues).filter(([c]) => c.split(".")[1] === arm).map(([, v]) => v[probe]).filter((x) => typeof x === "number");
const incomplete = Object.entries(result.cellValues).flatMap(([c, v]) => Object.entries(v).filter(([, x]) => x === "incomplete").map(([q]) => `${c}:${q}`));
const met = (arm, probes) => {
	const v = probes.flatMap((q) => values(arm, q));
	return { met: v.filter((x) => x >= MET).length, of: v.length };
};
const share = (m) => (m.of ? m.met / m.of : NaN);
const frac = (m) => `${m.met}/${m.of}`;

// S - separation, per probe (M2 rule 4). A probe separates when either corpus meets it at least 0.3 more
// often, or 0.3 less often, than readers holding nothing. A screen, not a test.
const separation = {};
for (const q of ALL) {
	const c = met("control", [q]), b = met("m7-base", [q]), h = met("m7-head", [q]);
	const gb = share(b) - share(c), gh = share(h) - share(c);
	separation[q] = { control: frac(c), base: frac(b), head: frac(h), baseGap: gb, headGap: gh, headLessBase: share(h) - share(b), separates: c.of > 0 && (Math.abs(gb) >= 0.3 - EPS || Math.abs(gh) >= 0.3 - EPS) };
}
const passing = (probes) => probes.filter((q) => separation[q].separates);

// T - the absorptions: on the target probes that separate, pooled, head against base. Each target probe's
// head-against-base figures are also given, since each absorption is ratified on its own.
const T = (() => {
	const qs = passing(TARGET);
	const perProbe = Object.fromEntries(TARGET.map((q) => { const h = met("m7-head", [q]), b = met("m7-base", [q]); return [q, { head: frac(h), base: frac(b), gap: share(h) - share(b), p: fisher(h.met, h.of, b.met, b.of), separates: separation[q].separates }]; }));
	if (!qs.length) return { id: "T", verdict: "UNRUNNABLE", probes: qs, perProbe, why: "no target probe separates readers holding a corpus from readers holding none" };
	const h = met("m7-head", qs), b = met("m7-base", qs), gap = share(h) - share(b), p = fisher(h.met, h.of, b.met, b.of);
	return { id: "T", verdict: gap >= 0.25 - EPS && p < 0.05 ? "HOLDS" : gap <= EPS ? "REFUTED" : "INCONCLUSIVE", probes: qs, head: frac(h), base: frac(b), gap, p, perProbe };
})();

// V - the verdicts of "already covered", per probe, read on the corpus before the absorptions:
//   covered, measured            base meets it in at least 9 of 12 cells, and separates from control by 0.3;
//   covered by general practice  base meets it in at least 9 of 12, and does not separate from control -
//                                readers need no corpus, so the verdict stands, and is not the corpus's;
//   not covered                  base meets it in fewer than 9 of 12 - the verdict is reopened.
const V = Object.fromEntries(COVERED.map((q) => {
	const b = met("m7-base", [q]), c = met("control", [q]);
	const verdict = b.of === 0 ? "UNRUNNABLE" : share(b) < 0.75 - EPS ? "NOT COVERED" : share(b) - share(c) >= 0.3 - EPS ? "COVERED, MEASURED" : "COVERED BY GENERAL PRACTICE";
	return [q, { verdict, base: frac(b), control: frac(c) }];
}));

// G - guard: on no probe of the eight, separating or not, may head meet it at least 0.3 less often than
// base; and on the guard probe, if it separates, head must not fall more than 0.10 below base.
const G = (() => {
	const fallen = ALL.filter((q) => separation[q].headLessBase <= -0.3 + EPS);
	const guard = passing(GUARD);
	const h = met("m7-head", guard), b = met("m7-base", guard), drop = guard.length ? share(b) - share(h) : 0;
	return { id: "G", verdict: drop <= 0.1 + EPS && !fallen.length ? "HOLDS" : "REFUTED", fallen, guard, head: frac(h), base: frac(b), drop };
})();

const decision = G.verdict === "REFUTED" ? "revise the wording of the absorption a fallen probe tests, and return it to the director"
	: T.verdict === "HOLDS" ? "the absorptions go to the director for ratification"
	: "the absorptions go to the director with the numbers";
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const means = Object.fromEntries(ALL.map((q) => [q, Object.fromEntries(ARMS.map((a) => [a, mean(values(a, q))]))]));
const byMember = {};
for (const [c, v] of Object.entries(result.cellValues)) {
	const [, arm, m] = c.split(".");
	for (const q of TARGET) (byMember[`${q}.${m}.${arm}`] ??= []).push(v[q]);
}
const out = { run: result.run, revisions: { base: BASE_REV, head: HEAD_REV }, separation, predicates: [T, G], coveredVerdicts: V, decision, incomplete, means, byMember };
if (flags.includes("--json")) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
console.log(`revisions held: base ${BASE_REV}, head ${HEAD_REV}`);
console.log("S  separation per probe (either corpus against nothing, |gap| >= 0.3):");
for (const [q, s] of Object.entries(separation)) console.log(`   ${q}  ${s.separates ? "separates" : "does not separate"}  control ${s.control}  base ${s.base}  head ${s.head}  base-gap ${s.baseGap.toFixed(2)}  head-gap ${s.headGap.toFixed(2)}`);
if (incomplete.length) console.log(`incomplete values, left out of every count: ${incomplete.join(", ")}`);
for (const { id, verdict, ...rest } of [T, G]) console.log(`${id}  ${verdict}\n    ${JSON.stringify(rest)}`);
console.log("V  verdicts of already covered:");
for (const [q, v] of Object.entries(V)) console.log(`   ${q}  ${v.verdict}  base ${v.base}  control ${v.control}`);
console.log(`decision: ${decision}`);
console.log(`means: ${JSON.stringify(means)}`);
console.log(`target met per member and arm: ${JSON.stringify(byMember)}`);
