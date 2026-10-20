#!/usr/bin/env node
// B88's test, pre-registered in ruling 0102 before the run it judges. Reads one run record of
// experiment adherence-b88 and prints a verdict per predicate. The comparison is within the run:
// on-trigger (A4's and M10's triggers rewritten) against on-trigger-b88-base (the corpus before).
//
// usage: node b88-predicates.mjs <run-dir> [--json]

import fs from "node:fs";
import path from "node:path";

const NEW = "on-trigger";
const OLD = "on-trigger-b88-base";
const MET = 0.5;

const [runDir, ...flags] = process.argv.slice(2);
if (!runDir) { console.error("usage: node b88-predicates.mjs <run-dir> [--json]"); process.exit(2); }
const read = (f) => JSON.parse(fs.readFileSync(path.join(runDir, f), "utf8"));
const result = read("RESULT.json");
const run = read("run.json");
const cells = run.cells.map((c) => read(path.join("cells", `${c}.json`)));

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

// Whether a valid cell's scored attempt named an entry, as context-lab's hydration profile reads it:
// a tool path or input holding the id and a hyphen after a separator, quote or space.
const opened = (c, id) => {
	const a = c.attempts[c.attempts.length - 1];
	const tools = [...(a.outcome?.tools ?? []), ...((a.phases ?? []).flatMap((p) => p.outcome?.tools ?? []))];
	const text = tools.map((t) => `${(t.paths ?? []).join(" ")} ${JSON.stringify(t.input ?? {})}`).join(" ");
	return new RegExp(`(?:^|[\\\\/"'\\s])${id}-`, "i").test(text);
};
const of = (sc, arm) => cells.filter((c) => c.valid && c.scenario === sc && c.arm === arm);
const share = (xs, f) => ({ met: xs.filter(f).length, of: xs.length });
const RULE = "HOLDS if new - old >= 0.25 and two-sided Fisher exact p < 0.05; REFUTED if new <= old; INCONCLUSIVE otherwise";
const verdict = (n, o, gapNeeded = 0.25) => {
	if (n.of === 0 || o.of === 0) return { verdict: "UNRUNNABLE" };
	const rn = n.met / n.of, ro = o.met / o.of, p = fisher(n.met, n.of, o.met, o.of);
	return { verdict: rn <= ro ? "REFUTED" : rn - ro >= gapNeeded && p < 0.05 ? "HOLDS" : "INCONCLUSIVE", new: `${n.met}/${n.of}`, old: `${o.met}/${o.of}`, gap: rn - ro, p };
};
const out = { run: result.run, predicates: [] };

// R1 (primary): A4 opened on adherence-a4.
out.predicates.push({ id: "R1", ...verdict(share(of("adherence-a4", NEW), (c) => opened(c, "A4")), share(of("adherence-a4", OLD), (c) => opened(c, "A4"))), rule: RULE });
// R2 (primary): M10 opened on adherence-x.
out.predicates.push({ id: "R2", ...verdict(share(of("adherence-x", NEW), (c) => opened(c, "M10")), share(of("adherence-x", OLD), (c) => opened(c, "M10"))), rule: RULE });
// R3 (effect): adherence-a4's three properties met, over every valid cell.
{
	const vals = (arm) => Object.entries(result.cellValues).filter(([c]) => c.startsWith(`adherence-a4.${arm}.`)).flatMap(([, v]) => ["a4-1", "a4-2", "a4-3"].map((p) => v[p]).filter((x) => typeof x === "number"));
	const n = vals(NEW), o = vals(OLD);
	out.predicates.push({ id: "R3", ...verdict({ met: n.filter((x) => x >= MET).length, of: n.length }, { met: o.filter((x) => x >= MET).length, of: o.length }, 0.10), rule: "HOLDS if new - old >= 0.10 and two-sided Fisher exact p < 0.05; REFUTED if new <= old; INCONCLUSIVE otherwise" });
}
// R4 (guard): A4 or M10 opened where neither applies, adherence-a11 and adherence-a2.
{
	const guard = (arm) => share([...of("adherence-a11", arm), ...of("adherence-a2", arm)], (c) => opened(c, "A4") || opened(c, "M10"));
	const n = guard(NEW), o = guard(OLD);
	const gap = n.of && o.of ? n.met / n.of - o.met / o.of : null;
	out.predicates.push({ id: "R4", verdict: gap === null ? "UNRUNNABLE" : gap <= 0.2 ? "HOLDS" : "REFUTED", new: `${n.met}/${n.of}`, old: `${o.met}/${o.of}`, gap, rule: "HOLDS if the share of cells opening A4 or M10 where neither applies rises by at most 0.20" });
}
// R5, descriptive: M10 opened on adherence-a4; adherence-x's properties; per member R1 and R2; cost.
{
	const byMember = (sc, id, arm) => Object.fromEntries([...new Set(cells.map((c) => c.member))].sort().map((m) => { const s = share(of(sc, arm).filter((c) => c.member === m), (c) => opened(c, id)); return [m, `${s.met}/${s.of}`]; }));
	const xs = (arm) => Object.fromEntries(result.properties.filter((p) => p.scenario === "adherence-x").map((p) => [p.property, p.byArm[arm]?.mean]));
	const cost = (arm) => result.costs?.find((c) => c.arm === arm && c.member === null);
	out.predicates.push({
		id: "R5", verdict: "DESCRIPTIVE",
		m10OnA4: { new: share(of("adherence-a4", NEW), (c) => opened(c, "M10")), old: share(of("adherence-a4", OLD), (c) => opened(c, "M10")) },
		a4ByMember: { new: byMember("adherence-a4", "A4", NEW), old: byMember("adherence-a4", "A4", OLD) },
		m10ByMember: { new: byMember("adherence-x", "M10", NEW), old: byMember("adherence-x", "M10", OLD) },
		xProperties: { new: xs(NEW), old: xs(OLD) },
		medianInputTokens: { new: cost(NEW)?.inputTokensMedian ?? null, old: cost(OLD)?.inputTokensMedian ?? null },
		probes: `${run.probes.filter((p) => p.pass).length}/${run.probes.length}`,
	});
}

if (flags.includes("--json")) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
for (const { id, verdict: v, ...rest } of out.predicates) console.log(`${id}  ${v}\n    ${JSON.stringify(rest)}`);
