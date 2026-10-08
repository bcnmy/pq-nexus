"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  encodeFunctionData,
  formatEther,
  formatUnits,
  getAddress,
  isAddress,
  parseEther,
  parseEventLogs,
  parseUnits,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { EXPLORER, NEXUS_SOURCE, SOURCE_REPO, SUITE, VERIFIER_SOURCE } from "@/lib/config";
import { entryPointAbi, tokenAbi } from "@/lib/abi";
import { accountInitData, buildUserOp, executeCallData, userOpHash, type Call } from "@/lib/userop";
import { accountState, client, computeAddress, relay, signer } from "@/lib/client";

const STORAGE_KEY = "pq-nexus:secret";
const HISTORY_PREFIX = "pq-nexus:history:";
const HISTORY_MAX = 50;
const ATTACKER: Address = "0x000000000000000000000000000000000000dEaD";

type Key = { secret: Hex; pkSeed: Hex; pkRoot: Hex; ms: number };
type Account = { address: Address; initData: Hex; deployed: boolean; eth: bigint; token: bigint; nonce: bigint };
type State = "run" | "ok" | "fail";
type Step = { label: string; detail?: string; href?: string; state: State };
type Activity = { id: number; kind: "op" | "attack"; title: string; steps: Step[] };

export default function Demo() {
  const [key, setKey] = useState<Key | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [busy, setBusy] = useState(false);

  // ------------------------------------------------------------------ key

  const activateKey = useCallback(async (secret: Hex) => {
    const k = await signer.load(secret);
    setKey({ secret, ...k });
    const history = loadHistory(k.pkRoot);
    setActivity(history);
    reconcileHistory(history, setActivity);
    try {
      localStorage.setItem(STORAGE_KEY, secret);
    } catch {}
  }, []);

  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(STORAGE_KEY);
    } catch {}
    if (!saved || !/^0x[0-9a-f]{64}$/i.test(saved)) return;
    const secret = saved as Hex;
    signer.load(secret).then((k) => {
      setKey({ secret, ...k });
      const history = loadHistory(k.pkRoot);
      setActivity(history);
      reconcileHistory(history, setActivity);
    });
  }, []);

  useEffect(() => {
    if (key) saveHistory(key.pkRoot, activity);
  }, [key, activity]);

  const refresh = useCallback(() => {
    if (key) fetchAccount(key).then(setAccount).catch(() => {});
  }, [key]);

  useEffect(() => {
    if (!key) return;
    let live = true;
    const tick = () => fetchAccount(key).then((a) => live && setAccount(a)).catch(() => {});
    tick();
    const t = setInterval(tick, 12_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [key]);

  const forget = () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
      if (key) localStorage.removeItem(HISTORY_PREFIX + key.pkRoot);
    } catch {}
    setKey(null);
    setAccount(null);
    setActivity([]);
  };

  // ------------------------------------------------------------------ ops

  const log = (id: number, step: Step, replaceLast = false) =>
    setActivity((all) =>
      all.map((a) => (a.id === id ? { ...a, steps: replaceLast ? [...a.steps.slice(0, -1), step] : [...a.steps, step] } : a)),
    );

  async function runOp(title: string, calls: Call[]) {
    if (!key || !account) return;
    setBusy(true);
    const id = Date.now();
    setActivity((all) => [{ id, kind: "op" as const, title, steps: [] }, ...all].slice(0, HISTORY_MAX));
    try {
      const op = buildUserOp(account.address, account.nonce, account.deployed, account.initData, executeCallData(calls));
      const hash = userOpHash(op);
      log(id, { label: "Built UserOp", detail: `${account.deployed ? "" : "deploys the account, "}userOpHash ${short(hash)}`, state: "ok" });

      log(id, { label: "Signing with SPHINCS", state: "run" });
      const { signature, ms } = await signer.sign(hash);
      op.signature = signature;
      log(id, { label: "Signed with SPHINCS", detail: `${((signature.length - 2) / 2).toLocaleString()} bytes in ${ms.toFixed(0)} ms`, state: "ok" }, true);

      log(id, { label: "Relaying", state: "run" });
      const res = await relay(op);
      if (!res.txHash) throw new Error(res.reason ?? res.error ?? "relay failed");
      log(id, { label: "Submitted", detail: short(res.txHash), href: `${EXPLORER}/tx/${res.txHash}`, state: "run" }, true);

      const receipt = await client().waitForTransactionReceipt({ hash: res.txHash, timeout: 120_000 });
      const ev = parseEventLogs({ abi: entryPointAbi, logs: receipt.logs, eventName: "UserOperationEvent" })[0];
      const success = ev?.args.success ?? false;
      log(
        id,
        {
          label: success ? "Confirmed" : "Included, but the call reverted",
          detail: `block ${receipt.blockNumber}, ${ev?.args.actualGasUsed?.toLocaleString() ?? receipt.gasUsed.toLocaleString()} gas`,
          href: `${EXPLORER}/tx/${res.txHash}`,
          state: success ? "ok" : "fail",
        },
        true,
      );
    } catch (e) {
      log(id, { label: "Failed", detail: shortError(e), state: "fail" }, true);
    } finally {
      setBusy(false);
      refresh();
    }
  }

  async function attack(kind: "ecdsa" | "tamper") {
    if (!key || !account) return;
    setBusy(true);
    const id = Date.now();
    const title = kind === "ecdsa" ? "Attack: sign with an ECDSA key" : "Attack: flip one bit of a valid SPHINCS signature";
    setActivity((all) => [{ id, kind: "attack" as const, title, steps: [] }, ...all].slice(0, HISTORY_MAX));
    try {
      const calls: Call[] = [
        { to: ATTACKER, value: account.eth, data: "0x" },
        { to: SUITE.token, value: 0n, data: encodeFunctionData({ abi: tokenAbi, functionName: "transfer", args: [ATTACKER, account.token] }) },
      ];
      const op = buildUserOp(account.address, account.nonce, account.deployed, account.initData, executeCallData(calls));
      const hash = userOpHash(op);
      log(id, { label: "Built UserOp", detail: `drain ${formatEther(account.eth)} ETH and ${formatUnits(account.token, 18)} pqUSD to ${short(ATTACKER)}`, state: "ok" });

      if (kind === "ecdsa") {
        const attackerKey = privateKeyToAccount(generatePrivateKey());
        op.signature = await attackerKey.sign({ hash });
        log(id, { label: "Signed with secp256k1", detail: `65 bytes from ${short(attackerKey.address)}`, state: "ok" });
      } else {
        const { signature } = await signer.sign(hash);
        const flipped = BigInt(`0x${signature.slice(2 + 6000, 2 + 6002)}`) ^ 1n;
        op.signature = `${signature.slice(0, 2 + 6000)}${flipped.toString(16).padStart(2, "0")}${signature.slice(2 + 6002)}` as Hex;
        log(id, { label: "Signed, then flipped one bit", detail: "byte 3,000 of 6,176", state: "ok" });
      }

      log(id, { label: "Simulating on Sepolia", state: "run" });
      const res = await relay(op, true);
      if (res.rejected) log(id, { label: "Rejected by the EntryPoint", detail: res.reason, state: "ok" }, true);
      else log(id, { label: "Unexpected", detail: res.error ?? "simulation passed", state: "fail" }, true);
    } catch (e) {
      log(id, { label: "Failed", detail: shortError(e), state: "fail" }, true);
    } finally {
      setBusy(false);
    }
  }

  // ------------------------------------------------------------------ render

  const latestOp = activity.find((a) => a.kind === "op") ?? null;
  const latestAttack = activity.find((a) => a.kind === "attack") ?? null;

  return (
    <div className="space-y-6">
      {!key ? (
        <Onboarding onKey={activateKey} />
      ) : (
        <div className="grid gap-4 sm:gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-4 sm:space-y-6">
            <AccountCard account={account} keyData={key} onForget={forget} />
            {account && <ActionsCard account={account} busy={busy} runOp={runOp} current={latestOp} />}
          </div>
          <div className="min-w-0 space-y-4 sm:space-y-6">
            <HistoryCard activity={activity} busy={busy} onClear={() => setActivity([])} />
            {account && <AttackCard busy={busy} attack={attack} current={latestAttack} />}
          </div>
        </div>
      )}
      <UnderTheHood />
    </div>
  );
}

async function fetchAccount(key: Key): Promise<Account> {
  const initData = accountInitData(key.pkSeed, key.pkRoot);
  const address = await computeAddress(initData);
  return { address, initData, ...(await accountState(address)) };
}

function status(a: Activity): State {
  const last = a.steps[a.steps.length - 1];
  return !last ? "run" : last.state;
}

// =================================================================== history storage (per browser, per key)

function loadHistory(pkRoot: Hex): Activity[] {
  try {
    const raw = localStorage.getItem(HISTORY_PREFIX + pkRoot);
    const items = raw ? (JSON.parse(raw) as Activity[]) : [];
    // An operation still running when the page closed: if it was submitted, its receipt is looked up again
    // (see reconcileHistory); if not, it never reached the chain.
    return items.map((a) => {
      const last = a.steps[a.steps.length - 1];
      // Entries saved by an earlier version as "Interrupted by a page reload" get the same re-check.
      const legacy = last?.label === "Interrupted by a page reload" && !!last.href;
      if (status(a) !== "run" && !legacy) return a;
      const tx = [...a.steps].reverse().find((s) => s.href)?.href;
      const steps = a.steps.filter((s) => s.state !== "run" && s.label !== "Interrupted by a page reload");
      const next: Step = tx
        ? { label: "Checking the transaction…", href: tx, detail: "submitted before the page reloaded", state: "run" }
        : { label: "Stopped before it was sent", detail: "the page reloaded", state: "fail" };
      return { ...a, steps: [...steps, next] };
    });
  } catch {
    return [];
  }
}

/** Resolves operations that were submitted before a reload by fetching their receipts. */
async function reconcileHistory(items: Activity[], update: (fn: (all: Activity[]) => Activity[]) => void) {
  for (const a of items) {
    const href = status(a) === "run" ? a.steps[a.steps.length - 1]?.href : undefined;
    const hash = href?.match(/0x[0-9a-fA-F]{64}/)?.[0] as Hex | undefined;
    if (!hash) continue;
    let last: Step;
    try {
      const receipt = await client().waitForTransactionReceipt({ hash, timeout: 60_000 });
      const ev = parseEventLogs({ abi: entryPointAbi, logs: receipt.logs, eventName: "UserOperationEvent" })[0];
      const success = ev?.args.success ?? false;
      last = {
        label: success ? "Confirmed" : "Included, but the call reverted",
        detail: `block ${receipt.blockNumber}, ${ev?.args.actualGasUsed?.toLocaleString() ?? receipt.gasUsed.toLocaleString()} gas`,
        href,
        state: success ? "ok" : "fail",
      };
    } catch {
      last = { label: "Status unknown", detail: "check the transaction", href, state: "fail" };
    }
    update((all) => all.map((x) => (x.id === a.id ? { ...x, steps: [...x.steps.slice(0, -1), last] } : x)));
  }
}

function saveHistory(pkRoot: Hex, activity: Activity[]) {
  try {
    localStorage.setItem(HISTORY_PREFIX + pkRoot, JSON.stringify(activity.slice(0, HISTORY_MAX)));
  } catch {}
}

// =================================================================== onboarding

function Onboarding({ onKey }: { onKey: (s: Hex) => Promise<void> }) {
  const [importing, setImporting] = useState(false);
  const [value, setValue] = useState("");
  const [working, setWorking] = useState(false);
  const [ack, setAck] = useState(false);

  const generate = async () => {
    setWorking(true);
    const s = new Uint8Array(32);
    crypto.getRandomValues(s);
    await onKey(toHex(s));
    setWorking(false);
  };

  return (
    <div className="card grid gap-6 overflow-hidden !p-0 md:grid-cols-2">
      <div className="space-y-4 bg-soft/60 p-5 sm:p-8">
        <h2 className="text-lg font-semibold">Generate a key</h2>
        <ol className="space-y-3 text-sm">
          {[
            ["Generate a SPHINCS key", "Random bytes in your browser. The public key is two 16-byte hash values."],
            ["Get your address", "Derived from the public key, before anything is deployed."],
            ["Sign your first action", "It deploys a Nexus 1.3.3 account whose only validator is SPHINCS."],
          ].map(([t, d], i) => (
            <li key={t} className="flex gap-3">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-ink font-mono text-xs text-white">{i + 1}</span>
              <span>
                <span className="font-medium">{t}</span>
                <span className="block text-muted">{d}</span>
              </span>
            </li>
          ))}
        </ol>
      </div>
      <div className="flex flex-col justify-center gap-4 p-5 pt-0 sm:p-8 md:pt-8">
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-warn/30 bg-warn-soft p-4 text-sm">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--brand)]" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          <span>
            I understand this is a testnet demonstration using experimental, unaudited SPHINCS code, and that I must not use it with real
            funds.
          </span>
        </label>
        <div className="flex flex-wrap gap-3">
          <button className="btn-brand" onClick={generate} disabled={working || !ack}>
            {working ? "Generating…" : "Generate key"}
          </button>
          <button className="btn-ghost" disabled={!ack} onClick={() => setImporting((v) => !v)}>
            Import a saved key
          </button>
        </div>
        {importing && ack && (
          <div className="flex flex-col gap-2 sm:flex-row">
            <input className="input font-mono" placeholder="0x… 32-byte secret" value={value} onChange={(e) => setValue(e.target.value.trim())} />
            <button className="btn" disabled={!/^0x[0-9a-fA-F]{64}$/.test(value)} onClick={() => onKey(value as Hex)}>
              Load
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// =================================================================== dashboard

function AccountCard({ account, keyData, onForget }: { account: Account | null; keyData: Key; onForget: () => void }) {
  const [reveal, setReveal] = useState(false);
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="card relative overflow-hidden">
      <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-brand via-brand/60 to-transparent" />
      <div className="flex items-center justify-between gap-3">
        <p className="label">Your account</p>
        {account && (
          <span className={`pill ${account.deployed ? "border-ok/30 bg-ok-soft text-ok" : "border-warn/30 bg-warn-soft text-warn"}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${account.deployed ? "bg-ok" : "bg-warn"}`} />
            {account.deployed ? "Deployed" : "Deploys on first action"}
          </span>
        )}
      </div>

      {account ? (
        <>
          <div className="mt-3 flex items-center gap-2 rounded-xl bg-soft px-3 py-2">
            <a className="min-w-0 flex-1 truncate font-mono text-sm hover:text-brand-ink" href={`${EXPLORER}/address/${account.address}`} target="_blank" rel="noreferrer">
              {account.address}
            </a>
            <CopyButton value={account.address} />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Balance symbol="ETH" icon="Ξ" value={formatEther(account.eth)} />
            <Balance symbol="pqUSD" icon="$" value={formatUnits(account.token, 18)} />
          </div>
        </>
      ) : (
        <div className="mt-3 space-y-3">
          <div className="h-9 animate-pulse rounded-xl bg-soft" />
          <div className="grid grid-cols-2 gap-3">
            <div className="h-16 animate-pulse rounded-xl bg-soft" />
            <div className="h-16 animate-pulse rounded-xl bg-soft" />
          </div>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-3 text-sm">
        <span className="text-muted">SPHINCS key</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={`pkSeed ${keyData.pkSeed}\npkRoot ${keyData.pkRoot}`}>
          {keyData.pkRoot.slice(0, 18)}…
        </span>
        <button className="text-xs font-medium text-brand-ink hover:underline" onClick={() => setReveal((v) => !v)}>
          {reveal ? "Hide secret" : "Show secret"}
        </button>
        <button className="text-xs font-medium text-muted hover:text-bad" onClick={() => setConfirming(true)}>
          Forget key
        </button>
      </div>
      {reveal && (
        <div className="mt-3 rounded-xl border border-warn/30 bg-warn-soft p-3">
          <p className="font-mono text-xs break-all">{keyData.secret}</p>
          <p className="mt-1.5 text-xs text-muted">Testnet only. Stored unprotected in this browser.</p>
        </div>
      )}

      {confirming && (
        <ConfirmDialog
          title="Forget this key?"
          body="The secret only exists in this browser. Once it's gone, nobody can sign for this account again, including you. Its history is cleared too."
          confirm="Forget key"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            onForget();
          }}
        />
      )}
    </div>
  );
}

function Balance({ symbol, icon, value }: { symbol: string; icon: string; value: string }) {
  const [int, frac = ""] = value.split(".");
  return (
    <div className="rounded-xl border border-line px-4 py-3">
      <div className="flex items-center gap-2 text-sm text-muted">
        <span className="grid h-5 w-5 place-items-center rounded-full bg-brand-soft text-[11px] font-semibold text-brand-ink">{icon}</span>
        {symbol}
      </div>
      <p className="mt-1 truncate font-mono text-xl font-semibold sm:text-2xl">
        {Number(int).toLocaleString()}
        {frac && <span className="text-muted">.{frac.slice(0, 4)}</span>}
      </p>
    </div>
  );
}

type Tab = "send" | "mint" | "receive";

function ActionsCard({
  account,
  busy,
  runOp,
  current,
}: {
  account: Account;
  busy: boolean;
  runOp: (t: string, c: Call[]) => Promise<void>;
  current: Activity | null;
}) {
  const [chosenTab, setTab] = useState<Tab | null>(null);
  const tab: Tab = chosenTab ?? (account.deployed ? "send" : "mint");
  const [asset, setAsset] = useState<"ETH" | "pqUSD">("pqUSD");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const balance = asset === "ETH" ? account.eth : account.token;

  const parsed = useMemo(() => {
    try {
      if (!isAddress(to) || !amount) return null;
      const v = asset === "ETH" ? parseEther(amount) : parseUnits(amount, 18);
      if (v <= 0n || v > balance) return null;
      return { to: getAddress(to), value: v };
    } catch {
      return null;
    }
  }, [to, amount, asset, balance]);

  const send = () => {
    if (!parsed) return;
    const call: Call =
      asset === "ETH"
        ? { to: parsed.to, value: parsed.value, data: "0x" }
        : { to: SUITE.token, value: 0n, data: encodeFunctionData({ abi: tokenAbi, functionName: "transfer", args: [parsed.to, parsed.value] }) };
    runOp(`Send ${amount} ${asset} to ${short(parsed.to)}`, [call]);
  };

  const mint = () =>
    runOp("Mint 100 pqUSD", [
      { to: SUITE.token, value: 0n, data: encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [parseUnits("100", 18)] }) },
    ]);

  return (
    <div className="card">
      <div className="flex items-center justify-between gap-3">
        <p className="label">Move funds</p>
        <div className="flex rounded-full bg-soft p-1 text-sm">
          {(["mint", "send", "receive"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-full px-3 py-1 capitalize transition sm:px-3.5 sm:py-1.5 ${tab === t ? "bg-card font-medium shadow-sm" : "text-muted hover:text-ink"}`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4">
        {tab === "mint" && (
          <div className="space-y-3">
            <p className="text-sm text-muted">
              pqUSD is a free test token, so you have something to move without a faucet.{" "}
              {account.deployed ? "" : "This first action also deploys your account."}
            </p>
            <button className="btn-brand w-full sm:w-auto" disabled={busy} onClick={mint}>
              Sign with SPHINCS and mint 100 pqUSD
            </button>
          </div>
        )}

        {tab === "send" && (
          <div className="space-y-3">
            <div className="flex gap-2">
              {(["pqUSD", "ETH"] as const).map((a) => (
                <button
                  key={a}
                  onClick={() => setAsset(a)}
                  className={`rounded-full border px-4 py-1 text-sm transition ${asset === a ? "border-brand bg-brand-soft font-medium text-brand-ink" : "border-line text-muted hover:text-ink"}`}
                >
                  {a}
                </button>
              ))}
            </div>
            <input className="input font-mono" placeholder="Recipient 0x…" value={to} onChange={(e) => setTo(e.target.value.trim())} />
            <div className="relative">
              <input className="input pr-16" placeholder="Amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.trim())} />
              <button
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full px-2.5 py-1 text-xs font-medium text-brand-ink hover:bg-brand-soft"
                onClick={() => setAmount(asset === "ETH" ? formatEther(balance) : formatUnits(balance, 18))}
              >
                Max
              </button>
            </div>
            <button className="btn-brand w-full" disabled={busy || !parsed} onClick={send}>
              Sign with SPHINCS and send
            </button>
          </div>
        )}

        {tab === "receive" && (
          <div className="space-y-3 text-sm">
            <p className="text-muted">Send Sepolia ETH to this address from any wallet. Gas is sponsored, so everything you send stays yours.</p>
            <div className="flex items-center gap-2 rounded-xl bg-soft px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-mono">{account.address}</span>
              <CopyButton value={account.address} />
            </div>
            <p className="text-muted">
              Faucets:{" "}
              <a className="link" href="https://cloud.google.com/application/web3/faucet/ethereum/sepolia" target="_blank" rel="noreferrer">Google Cloud</a>
              {" · "}
              <a className="link" href="https://www.alchemy.com/faucets/ethereum-sepolia" target="_blank" rel="noreferrer">Alchemy</a>
            </p>
          </div>
        )}
      </div>
      {current && <LiveSteps activity={current} />}
    </div>
  );
}

function AttackCard({ busy, attack, current }: { busy: boolean; attack: (k: "ecdsa" | "tamper") => Promise<void>; current: Activity | null }) {
  const options = [
    { kind: "ecdsa" as const, title: "Sign with ECDSA", desc: "As if elliptic-curve keys were broken." },
    { kind: "tamper" as const, title: "Tamper a signature", desc: "Valid SPHINCS signature, one bit flipped." },
  ];
  return (
    <div className="card">
      <p className="label">Try to break it</p>
      <p className="mt-1 text-sm text-muted">Each attack tries to drain the account in a simulation against Sepolia.</p>
      <div className="mt-3 grid grid-cols-2 gap-3">
        {options.map((o) => (
          <button
            key={o.kind}
            disabled={busy}
            onClick={() => attack(o.kind)}
            className="group rounded-xl border border-line p-3 text-left transition hover:border-bad/40 hover:bg-bad-soft disabled:opacity-40"
          >
            <span className="block text-sm font-medium group-hover:text-bad">{o.title}</span>
            <span className="mt-0.5 block text-xs text-muted">{o.desc}</span>
          </button>
        ))}
      </div>
      {current && <LiveSteps activity={current} />}
    </div>
  );
}

/** The latest operation's steps, shown under the button that started it. */
function LiveSteps({ activity }: { activity: Activity }) {
  const st = status(activity);
  return (
    <div
      className={`mt-4 rounded-xl border p-3 ${
        st === "run" ? "border-brand/30 bg-brand-soft/40" : st === "ok" ? "border-ok/25 bg-ok-soft/50" : "border-bad/25 bg-bad-soft/50"
      }`}
    >
      <p className="flex items-center gap-2 text-sm font-medium">
        <StatusDot state={st} />
        <span className="min-w-0 truncate">{activity.title}</span>
      </p>
      <StepList steps={activity.steps} />
    </div>
  );
}

function StepList({ steps }: { steps: Step[] }) {
  return (
    <ol className="mt-2 space-y-1.5">
      {steps.map((s, i) => (
        <li key={i} className="flex gap-2.5 text-sm">
          <span className="mt-[7px]">
            <StatusDot state={s.state} small />
          </span>
          <span className="min-w-0">
            <span className={s.state === "fail" ? "text-bad" : ""}>{s.label}</span>
            {s.detail && (
              <span className="block text-xs break-words text-muted">
                {s.href ? <a className="link" href={s.href} target="_blank" rel="noreferrer">{s.detail} ↗</a> : s.detail}
              </span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

function StatusDot({ state, small }: { state: State; small?: boolean }) {
  return (
    <span
      className={`block shrink-0 rounded-full ${small ? "h-2 w-2" : "h-2.5 w-2.5"} ${
        state === "ok" ? "bg-ok" : state === "fail" ? "bg-bad" : "animate-pulse bg-brand"
      }`}
    />
  );
}

/** Fixed-height, scrollable history: one line per operation, details on click. */
function HistoryCard({ activity, onClear, busy }: { activity: Activity[]; onClear: () => void; busy: boolean }) {
  return (
    <div className="card">
      <div className="flex items-center justify-between">
        <p className="label">
          History{activity.length > 0 && <span className="ml-1.5 text-muted/70">{activity.length}</span>}
        </p>
        {activity.length > 0 && !busy && (
          <button className="text-xs text-muted hover:text-ink" onClick={onClear}>
            Clear
          </button>
        )}
      </div>
      <div className="scroll-shadow mt-3 h-64 overflow-y-auto rounded-xl border border-line">
        {activity.length === 0 ? (
          <p className="grid h-full place-items-center px-6 text-center text-sm text-muted">Each action you sign shows up here.</p>
        ) : (
          <ul className="divide-y divide-line">
            {activity.map((a) => {
              const st = status(a);
              const tx = [...a.steps].reverse().find((x) => x.href)?.href;
              const outcome = a.steps[a.steps.length - 1];
              return (
                <li key={a.id}>
                  <details className="group">
                    <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-2.5 text-sm outline-none hover:bg-soft/60 focus-visible:bg-soft">
                      <StatusDot state={st} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{a.title}</span>
                        <span className={`block truncate text-xs ${st === "fail" ? "text-bad" : "text-muted"}`}>
                          {st === "run" ? "In progress…" : outcome?.label}
                        </span>
                      </span>
                      {tx && (
                        <a className="shrink-0 text-xs text-brand-ink hover:underline" href={tx} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                          tx ↗
                        </a>
                      )}
                      <span className="shrink-0 text-muted transition group-open:rotate-90">›</span>
                    </summary>
                    <div className="px-3 pb-3 pl-8">
                      <StepList steps={a.steps} />
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {activity.length > 4 && <p className="mt-2 text-center text-xs text-muted">Scroll for older entries</p>}
    </div>
  );
}

// =================================================================== under the hood

function UnderTheHood() {
  const items = [
    {
      name: "Nexus 1.3.3",
      badge: "audited",
      text: "Biconomy's smart account, deployed from the canonical audited bytecode. Only the default validator differs.",
      links: [
        ["Source", NEXUS_SOURCE],
        ["Contract", `${EXPLORER}/address/${SUITE.nexus}#code`],
      ],
    },
    {
      name: "SPHINCS verifier",
      badge: "unaudited",
      text: "RivaLabs SphincsVerifier_v2: sphincs-g parameters over keccak256. An experimental SPHINCS+ variant that differs from the standardized SLH-DSA.",
      links: [
        ["Source", VERIFIER_SOURCE],
        ["Contract", `${EXPLORER}/address/${SUITE.verifier}#code`],
      ],
    },
    {
      name: "SphincsValidator",
      badge: "unaudited",
      text: "ERC-7579 validator written for this demo, set as the account's only validator. Deployment scripts and app live in the repo.",
      links: [
        ["Repository", SOURCE_REPO],
        ["Contract", `${EXPLORER}/address/${SUITE.validator}#code`],
      ],
    },
  ];
  return (
    <section className="card">
      <p className="label">Under the hood</p>
      <ul className="mt-3 divide-y divide-line">
        {items.map((it) => (
          <li key={it.name} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-4">
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-sm font-medium">
                {it.name}
                <span className={`rounded-full px-2 py-0.5 text-[11px] ${it.badge === "audited" ? "bg-ok-soft text-ok" : "bg-warn-soft text-warn"}`}>{it.badge}</span>
              </p>
              <p className="mt-0.5 text-sm text-muted">{it.text}</p>
            </div>
            <div className="flex shrink-0 gap-3 text-sm">
              {it.links.map(([label, href]) => (
                <a key={label} className="link" href={href} target="_blank" rel="noreferrer">
                  {label} ↗
                </a>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

// =================================================================== primitives

function ConfirmDialog({
  title,
  body,
  confirm,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  confirm: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/30 p-4 backdrop-blur-sm" onClick={onCancel}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" className="card w-full max-w-sm shadow-xl" onClick={(e) => e.stopPropagation()}>
        <p id="confirm-title" className="text-base font-semibold">
          {title}
        </p>
        <p className="mt-2 text-sm text-muted">{body}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-ghost !px-4 !py-2" onClick={onCancel} autoFocus>
            Cancel
          </button>
          <button className="inline-flex items-center rounded-full bg-bad px-4 py-2 text-sm font-medium text-white transition hover:bg-bad/90" onClick={onConfirm}>
            {confirm}
          </button>
        </div>
      </div>
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="shrink-0 rounded-full px-2.5 py-1 text-xs font-medium text-brand-ink hover:bg-brand-soft"
      onClick={() => {
        navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** viem errors carry multi-line details and request dumps; keep the first line, capped. */
function shortError(e: unknown) {
  const err = e as { shortMessage?: string; message?: string };
  const msg = (err.shortMessage ?? err.message ?? String(e)).split("\n")[0];
  return msg.length > 160 ? `${msg.slice(0, 160)}…` : msg;
}

function short(v: string) {
  return `${v.slice(0, 6)}…${v.slice(-4)}`;
}
