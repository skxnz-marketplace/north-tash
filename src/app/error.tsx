"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="app-shell grid min-h-screen place-items-center px-5 text-[#f7f3e8]">
      <section className="surface-panel w-full max-w-sm p-5 text-center">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#e2b653]">North Tash</p>
        <h1 className="mt-2 text-2xl font-black text-white">Table recovered</h1>
        <p className="mt-2 text-sm text-white/65">
          The game screen hit a bad live update. Reload the table once; your room should still be there.
        </p>
        <div className="mt-5 grid gap-2">
          <button className="primary-action h-11 px-4 text-sm font-black" type="button" onClick={reset}>
            Reload Table
          </button>
          <button
            className="secondary-action h-11 px-4 text-sm font-semibold"
            type="button"
            onClick={() => router.push("/")}
          >
            Back To Lobby
          </button>
        </div>
      </section>
    </main>
  );
}
