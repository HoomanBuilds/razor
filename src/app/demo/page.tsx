import type { Metadata } from "next";
import { PublicDemo } from "@/components/demo/public-demo";

export const metadata: Metadata = {
  title: "Interactive demo | Razor",
  description: "Explore Razor's company payments, payroll and receiving workspaces with sample funds. No wallet required.",
};

export default function PublicDemoPage() {
  return <PublicDemo/>;
}
