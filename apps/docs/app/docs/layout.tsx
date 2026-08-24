import type { ReactNode } from "react";
import SidebarNav from "@/components/SidebarNav";
import { NAV } from "@/lib/nav";

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="shell-docs">
      <aside className="docs-sidebar">
        <SidebarNav sections={NAV} />
      </aside>
      <div className="doc-main">{children}</div>
    </div>
  );
}
