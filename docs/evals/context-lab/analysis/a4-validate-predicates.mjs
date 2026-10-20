#!/usr/bin/env node
// Validation of adherence-a4-record (M6.1, B93), pre-registered before the run it judges. The trap
// is valid only if agents given A4 meet its first property measurably more often than agents
// without guidance.
//
// usage: node a4-validate-predicates.mjs <run-dir> [--json]

import fs from "node:fs";
import path from "node:path";

const [runDir, ...flags] = process.argv.slice(2);
if (!runDir) { console.error("usage: node a4-validate-predicates.mjs <run-dir> [--json]"); process.exit(2); }
const result = JSON.parse(fs.readFileSync(path.join(runDir, "RESULT.json"), "utf8"));
// Met only when both of a cell's judges score it 1: a split vote does not count as a pass, so an ambiguity
// left in a key cannot push both arms toward passing and hide the gap (key audit, finding 7).
const MET = 1;

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
const met = (arm, prop) => {
	const v = Object.entries(result.cellValues).filter(([c]) => c.split(".")[1] === arm).map(([, x]) => x[prop]).filter((x) => typeof x === "number");
	return { met: v.filter((x) => x >= MET).length, of: v.length };
};
const compare = (id, arm, prop) => {
	const g = met(arm, prop), c = met("control", prop);
	if (!g.of || !c.of) return { id, verdict: "UNRUNNABLE" };
	const gap = g.met / g.of - c.met / c.of, p = fisher(g.met, g.of, c.met, c.of);
	return { id, verdict: gap >= 0.3 && p < 0.05 ? "SEPARATES" : gap <= 0 ? "DOES NOT SEPARATE" : "INCONCLUSIVE", guided: `${g.met}/${g.of}`, control: `${c.met}/${c.of}`, gap, p };
};
const out = { run: result.run, predicates: [
	// V1 (decides validity): all guidance loaded, A4 included, against none.
	{ ...compare("V1", "always-on", "a4r-1"), rule: "SEPARATES if always-on meets a4r-1 at least 0.3 more often than control, two-sided Fisher exact p < 0.05; the trap is valid only if V1 SEPARATES" },
	// V2, descriptive: guidance on request against none - whether agents find A4 themselves.
	{ ...compare("V2", "on-trigger", "a4r-1"), rule: "descriptive, by V1's rule" },
	// V3, descriptive: the reply property, all loaded against none.
	{ ...compare("V3", "always-on", "a4r-2"), rule: "descriptive, by V1's rule" },
] };
const byMember = {};
for (const [c, v] of Object.entries(result.cellValues)) { const [, arm, m] = c.split("."); (byMember[`${m}.${arm}`] ??= []).push(v["a4r-1"]); }
out.byMember = byMember;
if (flags.includes("--json")) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
for (const { id, verdict, ...rest } of out.predicates) console.log(`${id}  ${verdict}\n    ${JSON.stringify(rest)}`);
console.log(`a4r-1 per member and arm: ${JSON.stringify(byMember)}`);
