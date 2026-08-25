import { useState } from "react";
import { X } from "lucide-react";
import { fetchAccountIntelligence } from "@/services/ai";
import type { SfAccount, SfContact, SfOpportunity } from "@/types/salesforce";
import type { ActivityItem } from "@/services/ai";

interface Props {
  account: SfAccount;
  contacts: SfContact[];
  opps: SfOpportunity[];
  activities: ActivityItem[];
  onClose: () => void;
}

export function AccountHistoryOverlay({ account, contacts, opps, activities, onClose }: Props) {
  const [phase, setPhase] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [brief, setBrief] = useState<string>("");
  const [sourcesUsed, setSourcesUsed] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState<string>("");

  async function generate() {
    setPhase("loading");
    setBrief("");
    setErrorMsg("");
    try {
      const result = await fetchAccountIntelligence(account, contacts, opps, activities, "overview");
      setBrief(result.brief);
      setSourcesUsed(result.sources_used ?? []);
      setPhase("done");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to generate brief.");
      setPhase("error");
    }
  }

  function openInClaude() {
    const message = `Account Intelligence Brief — ${account.Name}\n\n${brief}\n\nI have follow-up questions about this account.`;
    window.open(`https://claude.ai/new?q=${encodeURIComponent(message)}`, "_blank");
  }

  const sourcesLabel = sourcesUsed
    .map((s) =>
      s === "salesforce_cache"
        ? "Salesforce"
        : s === "email_activity"
          ? "Email activity"
          : s === "fireflies"
            ? "Fireflies"
            : s === "salesforce_similar"
              ? "Similar accounts"
              : s,
    )
    .join(" · ");

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/90">
      {/* Close button — always visible */}
      <button
        type="button"
        onClick={onClose}
        className="absolute right-5 top-5 rounded-full p-2 text-white/50 transition-colors hover:bg-white/10 hover:text-white"
        aria-label="Close"
      >
        <X size={20} />
      </button>

      {/* Loading phase */}
      {phase === "loading" && (
        <div className="flex flex-col items-center gap-6">
          <img
            src="/pursuit-loading.gif"
            alt="Analyzing account…"
            className="h-40 w-40 object-contain rounded-2xl"
          />
          <p className="text-[13px] tracking-wide text-white/40 uppercase">Analyzing account history…</p>
        </div>
      )}

      {/* Idle — account name + single generate button */}
      {phase === "idle" && (
        <div className="flex w-full max-w-sm flex-col items-center gap-8 px-6 text-center">
          <img
            src="/pursuit-loading.gif"
            alt="Pursuit"
            className="h-28 w-28 object-contain rounded-2xl"
          />
          <div>
            <p className="text-[13px] tracking-widest text-white/40 uppercase mb-2">Account History</p>
            <h2 className="text-2xl font-semibold text-white">{account.Name}</h2>
          </div>
          <button
            type="button"
            onClick={generate}
            className="w-full rounded-xl bg-white py-3 text-[14px] font-semibold text-black transition-opacity hover:opacity-90"
          >
            Generate Account History Brief
          </button>
        </div>
      )}

      {/* Brief / done phase */}
      {(phase === "done" || phase === "error") && (
        <div className="flex h-full w-full max-w-3xl flex-col px-6 py-16">
          <div className="flex-1 overflow-y-auto">
            {phase === "error" ? (
              <div className="flex flex-col items-center gap-4 pt-16 text-center">
                <p className="text-red-400 text-sm">{errorMsg}</p>
                <button
                  type="button"
                  onClick={() => setPhase("idle")}
                  className="rounded-lg border border-white/20 px-5 py-2 text-[13px] text-white/70 hover:text-white"
                >
                  Try again
                </button>
              </div>
            ) : (
              <BriefContent text={brief} />
            )}
          </div>

          {phase === "done" && (
            <div className="mt-6 flex flex-col gap-3 border-t border-white/10 pt-5">
              {sourcesLabel && (
                <p className="text-[11px] text-white/25">Sources: {sourcesLabel}</p>
              )}
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setPhase("idle")}
                  className="rounded-lg border border-white/20 px-5 py-2 text-[13px] font-medium text-white/60 transition-colors hover:border-white/40 hover:text-white"
                >
                  Regenerate
                </button>
                <button
                  type="button"
                  onClick={openInClaude}
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-white px-5 py-2 text-[13px] font-semibold text-black transition-opacity hover:opacity-90"
                >
                  <StarburstIcon className="h-4 w-4 text-[#D97757]" />
                  Continue in Claude
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type LineBlock = { kind: "line"; content: string } | { kind: "table"; rows: string[] };

function parseBlocks(text: string): LineBlock[] {
  const lines = text.split("\n");
  const blocks: LineBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim().startsWith("|")) {
      const rows: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(lines[i]);
        i++;
      }
      blocks.push({ kind: "table", rows });
    } else {
      blocks.push({ kind: "line", content: lines[i] });
      i++;
    }
  }
  return blocks;
}

function MarkdownTable({ rows }: { rows: string[] }) {
  const isSeparator = (r: string) => /^\|[\s\-:|]+\|$/.test(r.trim());
  const parseRow = (r: string) =>
    r.split("|").slice(1, -1).map((c) => c.trim());

  const headerRow = rows[0] ? parseRow(rows[0]) : [];
  const dataRows = rows.slice(1).filter((r) => !isSeparator(r)).map(parseRow);

  return (
    <div className="overflow-x-auto my-3">
      <table className="w-full text-[12px] border-collapse">
        <thead>
          <tr>
            {headerRow.map((cell, i) => (
              <th
                key={i}
                className="text-left py-1.5 px-3 text-white/40 font-medium border-b border-white/10 whitespace-nowrap"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dataRows.map((row, ri) => (
            <tr key={ri} className="border-b border-white/5">
              {row.map((cell, ci) => (
                <td key={ci} className="py-1.5 px-3 text-white/80 align-top">
                  <span dangerouslySetInnerHTML={{ __html: formatInline(cell) }} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BriefContent({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className="space-y-1 text-[14px] leading-relaxed text-white/90">
      {blocks.map((block, i) => {
        if (block.kind === "table") {
          return <MarkdownTable key={i} rows={block.rows} />;
        }
        const line = block.content;
        if (/^\*\*[^*]+\*\*$/.test(line.trim()) || /^#{1,3}\s/.test(line)) {
          const clean = line.replace(/^\*\*|\*\*$|^#{1,3}\s/g, "").trim();
          return (
            <h3 key={i} className="mt-6 text-[15px] font-semibold text-white first:mt-0">
              {clean}
            </h3>
          );
        }
        if (/^[-•]\s/.test(line.trim()) || /^\*\s/.test(line.trim())) {
          return (
            <p key={i} className="flex gap-2">
              <span className="mt-0.5 shrink-0 text-white/30">•</span>
              <span dangerouslySetInnerHTML={{ __html: formatInline(line.replace(/^[-•*]\s+/, "")) }} />
            </p>
          );
        }
        if (!line.trim()) return <div key={i} className="h-2" />;
        return <p key={i} dangerouslySetInnerHTML={{ __html: formatInline(line) }} />;
      })}
    </div>
  );
}

function formatInline(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code class='text-white/60 bg-white/10 px-1 rounded text-[12px]'>$1</code>");
}

function StarburstIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      {Array.from({ length: 12 }, (_, i) => (
        <rect
          key={i}
          x="11.1"
          y="2.5"
          width="1.8"
          height="8.5"
          rx="0.9"
          transform={`rotate(${i * 30} 12 12)`}
        />
      ))}
    </svg>
  );
}
