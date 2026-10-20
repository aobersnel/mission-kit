#!/usr/bin/env node
// Test of 0106's change to M2 (B94, M6.2), pre-registered before the run it judges. The change says a
// probe judges a change only if it separates readers holding the document from readers holding none, so
// this script applies that rule to its own probes before letting any of them decide.
//
// usage: node m2-separation-predicates.mjs <run-dir> [--json]

import fs from "node:fs";
import path from "node:path";

const [runDir, ...flags] = process.argv.slice(2);
if (!runDir) { console.error("usage: node m2-separation-predicates.mjs <run-dir> [--json]"); process.exit(2); }
const result = JSON.parse(fs.readFileSync(path.join(runDir, "RESULT.json"), "utf8"));

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
const met = (arm, probes) => {
	const v = probes.flatMap((q) => values(arm, q));
	return { met: v.filter((x) => x >= MET).length, of: v.length };
};
const share = (m) => (m.of ? m.met / m.of : NaN);

// S - separation, per probe (the changed rule applied to this test). A probe separates when the better of
// the two versions meets it at least 0.3 more often than readers holding nothing. A screen, not a test:
// at 12 cells per arm it needs a gap of four cells.
const separation = {};
for (const q of [...TARGET, ...CONTROL]) {
	const c = met("control", [q]), b = met("m2-base", [q]), h = met("m2-head", [q]);
	const gap = Math.max(share(b), share(h)) - share(c);
	separation[q] = { control: `${c.met}/${c.of}`, base: `${b.met}/${b.of}`, head: `${h.met}/${h.of}`, gap, separates: c.of > 0 && gap >= 0.3 };
}
const passing = (probes) => probes.filter((q) => separation[q].separates);

// T - target: on the target probes that separate, pooled, head against base.
const T = (() => {
	const qs = passing(TARGET);
	if (!qs.length) return { id: "T", verdict: "UNRUNNABLE", probes: qs, why: "no target probe separates readers holding the document from readers holding none" };
	const h = met("m2-head", qs), b = met("m2-base", qs), gap = share(h) - share(b), p = fisher(h.met, h.of, b.met, b.of);
	return { id: "T", verdict: gap >= 0.25 && p < 0.05 ? "HOLDS" : gap <= 0 ? "REFUTED" : "INCONCLUSIVE", probes: qs, head: `${h.met}/${h.of}`, base: `${b.met}/${b.of}`, gap, p };
})();
// G - guard: on the control probes that separate, pooled, head must not fall more than 0.10 below base.
const G = (() => {
	const qs = passing(CONTROL);
	if (!qs.length) return { id: "G", verdict: "UNRUNNABLE", probes: qs, why: "no control probe separates readers holding the document from readers holding none" };
	const h = met("m2-head", qs), b = met("m2-base", qs), drop = share(b) - share(h);
	return { id: "G", verdict: drop <= 0.1 ? "HOLDS" : "REFUTED", probes: qs, head: `${h.met}/${h.of}`, base: `${b.met}/${b.of}`, drop };
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
const out = { run: result.run, separation, predicates: [T, G], decision, means, byMember };
if (flags.includes("--json")) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
console.log("S  separation per probe (better version against nothing, gap >= 0.3):");
for (const [q, s] of Object.entries(separation)) console.log(`   ${q}  ${s.separates ? "separates" : "does not separate"}  control ${s.control}  base ${s.base}  head ${s.head}  gap ${s.gap.toFixed(2)}`);
for (const { id, verdict, ...rest } of [T, G]) console.log(`${id}  ${verdict}\n    ${JSON.stringify(rest)}`);
console.log(`decision: ${decision}`);
console.log(`means: ${JSON.stringify(means)}`);
console.log(`target met per member and arm: ${JSON.stringify(byMember)}`);
