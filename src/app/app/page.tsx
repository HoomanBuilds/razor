import type { Metadata } from "next";
import { WorkspaceApp } from "@/components/workspace/workspace";

export const metadata: Metadata = { title: "Razor | Company workspace" };

export default function CompanyWorkspacePage() {
  return <WorkspaceApp />;
}
