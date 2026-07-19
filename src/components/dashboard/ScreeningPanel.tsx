"use client";

// Renders one employer-ATS screening run (round history + final verdict). Typed
// against a local view so it works for both a fresh POST result and a stored row.
interface RoundView {
  round: number;
  featured: string[];
  screen: {
    decision: string;
    score: number;
    matched: string[];
    coverableGaps: { skill: string }[];
    absentGaps: { skill: string }[];
    mentionedNotEvidenced: string[];
    breakdown: { requiredCoverage: number; evidenceRate: number; niceToHaveCoverage: number };
    comments: string[];
  };
}

export interface ScreeningView {
  accepted: boolean;
  finalScore: number;
  reason?: string | null;
  learnList: string[];
  rounds: RoundView[];
}

function Chips({ items, cls }: { items: string[]; cls: string }) {
  if (!items.length) return <span className="text-[11px] text-gray-600">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((i) => (
        <span key={i} className={`text-xs px-2 py-0.5 rounded ${cls}`}>{i}</span>
      ))}
    </div>
  );
}

function ScoreMeter({ score }: { score: number }) {
  const t = score >= 70 ? "text-green-400" : score >= 50 ? "text-yellow-400" : "text-red-400";
  const bar = score >= 70 ? "bg-green-500" : score >= 50 ? "bg-yellow-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-28 bg-gray-800 rounded-full overflow-hidden">
        <div className={`h-full ${bar}`} style={{ width: `${Math.max(0, Math.min(100, score))}%` }} />
      </div>
      <span className={`text-sm font-bold ${t}`}>{score}/100</span>
    </div>
  );
}

function Mini({ label, v }: { label: string; v: number }) {
  const pct = Math.round((v ?? 0) * 100);
  const bar = pct >= 70 ? "bg-green-500" : pct >= 50 ? "bg-yellow-500" : "bg-red-500";
  return (
    <div className="bg-gray-800/40 rounded p-1.5">
      <div className="flex justify-between mb-1">
        <span className="text-[10px] text-gray-400">{label}</span>
        <span className="text-[10px] text-gray-300">{pct}%</span>
      </div>
      <div className="h-1 bg-gray-700 rounded-full overflow-hidden">
        <div className={`h-full ${bar}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Group({ title, items, cls }: { title: string; items: string[]; cls: string }) {
  return (
    <div>
      <div className="text-[11px] text-gray-500 mb-1">{title} ({items.length})</div>
      <Chips items={items} cls={cls} />
    </div>
  );
}

function RoundCard({ r }: { r: RoundView }) {
  const s = r.screen;
  return (
    <div className="rounded-lg bg-gray-800/40 p-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-gray-400">Round {r.round}</span>
        <span className={`text-xs px-2 py-0.5 rounded-full ${s.decision === "accept" ? "bg-green-900/50 text-green-300" : "bg-red-900/40 text-red-300"}`}>
          {s.decision.toUpperCase()}
        </span>
        <span className="text-xs text-gray-500">{s.score}/100</span>
        {r.featured.length > 0 && <span className="text-xs text-violet-300">featuring: {r.featured.join(", ")}</span>}
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Mini label="Required" v={s.breakdown.requiredCoverage} />
        <Mini label="Evidence" v={s.breakdown.evidenceRate} />
        <Mini label="Nice-to-have" v={s.breakdown.niceToHaveCoverage} />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <Group title="Demonstrated" items={s.matched} cls="bg-green-900/40 text-green-300" />
        <Group title="Listed, not shown" items={s.mentionedNotEvidenced} cls="bg-amber-900/30 text-amber-300" />
        <Group title="Under-featured (fixable)" items={s.coverableGaps.map((g) => g.skill)} cls="bg-yellow-900/30 text-yellow-300" />
        <Group title="Missing (gap to learn)" items={s.absentGaps.map((g) => g.skill)} cls="bg-red-900/30 text-red-300" />
      </div>
      {s.comments.length > 0 && (
        <ul className="space-y-1">
          {s.comments.map((c, i) => (
            <li key={i} className="text-xs text-gray-300 flex gap-2">
              <span className="text-cyan-400">›</span>
              <span>{c}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ScreeningPanel({ screening }: { screening: ScreeningView }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-xs text-gray-400 uppercase tracking-wider">Employer ATS</span>
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${screening.accepted ? "bg-green-900/50 text-green-300" : "bg-red-900/40 text-red-300"}`}>
          {screening.accepted ? "ACCEPTED" : "REJECTED"}
        </span>
        <ScoreMeter score={screening.finalScore} />
        {screening.reason && <span className="text-xs text-gray-500">{screening.reason}</span>}
      </div>

      {!screening.accepted && screening.learnList.length > 0 && (
        <div>
          <div className="text-xs text-gray-500 mb-1.5">Skills to learn to pass this role</div>
          <Chips items={screening.learnList} cls="bg-red-900/30 text-red-300" />
        </div>
      )}

      {screening.rounds.length > 0 ? (
        <div className="space-y-3">
          {screening.rounds.map((r) => (
            <RoundCard key={r.round} r={r} />
          ))}
        </div>
      ) : (
        <div className="text-xs text-gray-600">Rejected before screening — not a fit for this role.</div>
      )}
    </div>
  );
}
