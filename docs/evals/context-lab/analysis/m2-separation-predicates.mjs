#!/usr/bin/env node
// Test of 0107's change to M2 (superseding 0106; B94, M6.2), pre-registered before the run it judges. The change says a
// probe judges a change only if it separates readers holding the document from readers holding none, so
// this script applies that rule to its own probes before letting any of them decide.
//
// usage: node m2-separation-predicates.mjs <run-dir> [--json]

import fs from "node:fs";
import path from "node:path";

const [runDir, ...flags] = process.argv.slice(2);
if (!runDir) { console.error("usage: node m2-separation-predicates.mjs <run-dir> [--json]"); process.exit(2); }
const result = JSON.parse(fs.readFileSync(path.join(runDir, "RESULT.json"), "utf8"));
const record = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8"));

// The two versions must be the pinned ones and must differ, or the run compared nothing.
const BASE_REV = "1de4b10aabd9d26819512e5e94a4dd7261b5e978";
const HEAD_REV = "c35db76b45e616318357bcd6375a2acce0e8780d";
const rev = (id) => record.variants?.[id]?.revision;
if (rev("corpus-m2-base") !== BASE_REV || rev("corpus-m2-head") !== HEAD_REV) {
	console.log(`INVALID: variants held base ${rev("corpus-m2-base")} and head ${rev("corpus-m2-head")}, not the pinned ${BASE_REV} and ${HEAD_REV}`);
	process.exit(1);
}
const EPS = 1e-9;

// A cell meets a probe when its two judges' mean is at least 1.5 of 2: one judge at 2 and the other at
// 1 or 2. Absent answers are scored 0 by the tally and count as not met.
const MET = 1.5;
const TARGET = ["Q1", "Q2"];
const CONTROL = ["Q3", "Q4", "Q5", "Q6"];
const ARMS = ["control", "m2-base", "m2-head"];

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

// S - separation, per probe (the changed rule applied to this test). A probe separates when either
// version meets it at least 0.3 more often, or 0.3 less often, than readers holding nothing. A screen,
// not a test: at 12 cells per arm it needs a gap of four cells.
const separation = {};
for (const q of [...TARGET, ...CONTROL]) {
	const c = met("control", [q]), b = met("m2-base", [q]), h = met("m2-head", [q]);
	const gb = share(b) - share(c), gh = share(h) - share(c);
	separation[q] = { control: `${c.met}/${c.of}`, base: `${b.met}/${b.of}`, head: `${h.met}/${h.of}`, baseGap: gb, headGap: gh, headLessBase: share(h) - share(b), separates: c.of > 0 && (Math.abs(gb) >= 0.3 - EPS || Math.abs(gh) >= 0.3 - EPS) };
}
const passing = (probes) => probes.filter((q) => separation[q].separates);

// T - target: on the target probes that separate, pooled, head against base.
const T = (() => {
	const qs = passing(TARGET);
	if (!qs.length) return { id: "T", verdict: "UNRUNNABLE", probes: qs, why: "no target probe separates readers holding the document from readers holding none" };
	const h = met("m2-head", qs), b = met("m2-base", qs), gap = share(h) - share(b), p = fisher(h.met, h.of, b.met, b.of);
	return { id: "T", verdict: gap >= 0.25 - EPS && p < 0.05 ? "HOLDS" : gap <= EPS ? "REFUTED" : "INCONCLUSIVE", probes: qs, head: `${h.met}/${h.of}`, base: `${b.met}/${b.of}`, gap, p };
})();
// G - guard: on the control probes that separate, pooled, head must not fall more than 0.10 below base;
// and on no probe of the six, target or control, separating or not, may head meet it at least 0.3 less
// often than base, since a probe that does not separate still counts against the change.
const G = (() => {
	const qs = passing(CONTROL);
	const fallen = [...TARGET, ...CONTROL].filter((q) => separation[q].headLessBase <= -0.3 + EPS);
	if (!qs.length && !fallen.length) return { id: "G", verdict: "UNRUNNABLE", probes: qs, fallen, why: "no control probe separates readers holding the document from readers holding none, and no probe fell" };
	const h = met("m2-head", qs), b = met("m2-base", qs), drop = qs.length ? share(b) - share(h) : 0;
	return { id: "G", verdict: drop <= 0.1 + EPS && !fallen.length ? "HOLDS" : "REFUTED", probes: qs, fallen, head: `${h.met}/${h.of}`, base: `${b.met}/${b.of}`, drop };
})();

// D - descriptive: mean score per probe and arm, and met per member, probe and arm.
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const means = Object.fromEntries([...TARGET, ...CONTROL].map((q) => [q, Object.fromEntries(ARMS.map((a) => [a, mean(values(a, q))]))]));
const byMember = {};
for (const [c, v] of Object.entries(result.cellValues)) {
	const [, arm, m] = c.split(".");
	for (const q of TARGET) (byMember[`${q}.${m}.${arm}`] ??= []).push(v[q]);
}
const decision = T.verdict === "HOLDS" && G.verdict === "HOLDS" ? "to the director for ratification"
	: T.verdict === "REFUTED" || G.verdict === "REFUTED" ? "revise the wording, and return it to the director"
	: "to the director with the numbers";
const out = { run: result.run, revisions: { base: BASE_REV, head: HEAD_REV }, separation, predicates: [T, G], decision, incomplete, means, byMember };
if (flags.includes("--json")) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
console.log(`revisions held: base ${BASE_REV}, head ${HEAD_REV}`);
console.log("S  separation per probe (either version against nothing, |gap| >= 0.3):");
for (const [q, s] of Object.entries(separation)) console.log(`   ${q}  ${s.separates ? "separates" : "does not separate"}  control ${s.control}  base ${s.base}  head ${s.head}  base-gap ${s.baseGap.toFixed(2)}  head-gap ${s.headGap.toFixed(2)}`);
if (incomplete.length) console.log(`incomplete values, left out of every count: ${incomplete.join(", ")}`);
for (const { id, verdict, ...rest } of [T, G]) console.log(`${id}  ${verdict}\n    ${JSON.stringify(rest)}`);
console.log(`decision: ${decision}`);
console.log(`means: ${JSON.stringify(means)}`);
console.log(`target met per member and arm: ${JSON.stringify(byMember)}`);
