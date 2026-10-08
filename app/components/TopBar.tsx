"use client";

import { useEffect, useState } from "react";
import { formatEther } from "viem";
import { SOURCE_REPO } from "@/lib/config";

export default function TopBar() {
  const [relayer, setRelayer] = useState<{ ok: boolean; balance?: string } | null>(null);

  useEffect(() => {
    const load = () =>
      fetch("/api/relay")
        .then((r) => r.json())
        .then((b) => setRelayer(b.balance ? { ok: true, balance: formatEther(BigInt(b.balance)) } : { ok: false }))
        .catch(() => setRelayer({ ok: false }));
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-bg/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-ink font-mono text-xs font-semibold text-white">pq</span>
          <span className="font-semibold tracking-tight">PQ Nexus</span>
          <span className="hidden rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-medium text-brand-ink sm:inline">demo</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="pill">
            <span className="h-1.5 w-1.5 rounded-full bg-ok" />
            Sepolia
          </span>
          <span className="pill hidden sm:inline-flex" title="The relayer pays gas for every demo transaction">
            <span className={`h-1.5 w-1.5 rounded-full ${relayer === null ? "bg-muted" : relayer.ok ? "bg-ok" : "bg-bad"}`} />
            Relayer {relayer?.ok ? `${Number(relayer.balance).toFixed(3)} ETH` : relayer === null ? "…" : "offline"}
          </span>
          <a className="pill hover:border-ink/30" href={SOURCE_REPO} target="_blank" rel="noreferrer">
            GitHub ↗
          </a>
        </div>
      </div>
    </header>
  );
}
