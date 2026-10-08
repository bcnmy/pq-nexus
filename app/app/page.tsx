import Demo from "@/components/Demo";
import TopBar from "@/components/TopBar";

export default function Home() {
  return (
    <>
      <TopBar />
      <details role="note" className="group border-b border-warn/20 bg-warn-soft">
        <summary className="mx-auto flex max-w-6xl cursor-pointer list-none items-center gap-2 px-4 py-2 text-xs text-ink/80 sm:text-[13px]">
          <b className="text-warn">Demo only.</b>
          <span className="min-w-0 flex-1 truncate">
            <span className="sm:hidden">Unaudited, testnet only.</span>
            <span className="hidden sm:inline">Experimental, unaudited SPHINCS code on the Sepolia testnet.</span>
          </span>
          <span className="shrink-0 font-medium text-warn group-open:hidden">Details</span>
          <span className="hidden shrink-0 font-medium text-warn group-open:inline">Hide</span>
        </summary>
        <p className="mx-auto max-w-6xl px-4 pb-2.5 text-xs leading-relaxed text-ink/80 sm:text-[13px]">
          For demonstration purposes only. Sepolia testnet. Uses an experimental, unaudited SPHINCS verifier (sphincs-g, a variant that differs from the
          standardized SLH-DSA) and an unaudited validator module. Do not use on mainnet or with real funds. Keys are kept unprotected in your browser.
          Provided as is, without warranty of any kind.
        </p>
      </details>

      <main className="mx-auto max-w-6xl px-4 pb-16">
        <section className="py-5 sm:py-10">
          <p className="hidden text-sm text-muted sm:block">Sepolia demo · Nexus 1.3.3 · ERC-4337 · ERC-7579</p>
          <h1 className="text-xl font-semibold tracking-tight sm:mt-2 sm:text-3xl">
            Nexus account with a <span className="text-brand">SPHINCS</span> validator
          </h1>
          <p className="mt-1.5 max-w-2xl text-sm text-muted sm:mt-3 sm:text-base">
            A Nexus smart account whose only validator checks SPHINCS, a hash-based signature scheme.
          </p>
          <dl className="mt-5 hidden flex-wrap gap-x-6 gap-y-2 text-sm sm:flex">
            {[
              ["Signature", "6,176 bytes"],
              ["Hash", "keccak256"],
              ["Parameters", "sphincs-g, 128-bit"],
              ["Verification", "~350k gas"],
            ].map(([k, v]) => (
              <div key={k} className="flex items-baseline gap-2">
                <dt className="text-muted">{k}</dt>
                <dd className="font-mono">{v}</dd>
              </div>
            ))}
          </dl>
        </section>

        <Demo />

        <footer className="mt-16 border-t border-line pt-6 text-xs leading-relaxed text-muted">
          <p>
            <b className="text-ink">Disclaimer.</b> This is an experimental research demonstration. The SPHINCS verifier and
            the validator module are unaudited and may contain bugs that lead to loss of funds. Only the Nexus account code has been
            audited. No representation is made that this setup is secure against quantum or classical attacks. Testnet only; do not send
            real assets to any address shown here. Provided as is, without warranty of any kind.
          </p>
        </footer>
      </main>
    </>
  );
}
