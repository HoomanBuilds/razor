import type { Metadata } from "next";
import { PublicDemo } from "@/components/demo/public-demo";
import { getPublicDemoScenario } from "@/server/demo/scenario";
import { publicDemoIdentity } from "@/server/demo/identity";
import { demoBuildIdentity } from "@/server/demo/build";
export const metadata: Metadata = {
  title: "Read-only product preview | Razor",
  description:
    "Explore fictional payroll, supplier payments and company clearing with current Razor calculations. No wallet, account or funds required.",
};
export default function PublicDemoPage() {
  return (
    <main className="mx-auto grid max-w-6xl min-w-0 grid-cols-1 gap-8 px-5 py-10">
      <a href="/" className="w-fit text-xl font-bold">
        Razor
      </a>
      <header className="min-w-0">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Public product preview
        </p>
        <h1 className="mt-3 text-3xl font-semibold">
          Explore the payment workflow
        </h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
          Walk through payroll, a held contractor transfer and company invoice
          clearing using purpose-made fictional examples. The current product
          calculations run read-only; real execution and evidence stay separate.
        </p>
      </header>
      <PublicDemo
        initial={{
          scenario: getPublicDemoScenario(),
          identity: publicDemoIdentity(demoBuildIdentity()),
        }}
      />
    </main>
  );
}
