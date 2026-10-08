import { Compass, FolderOpen, Mic, UserCircle, Newspaper, Clapperboard } from "lucide-react";

const navItems = [
  { icon: Compass, label: "Explore" },
  { icon: FolderOpen, label: "My Projects" },
];

const createItems = [
  { label: "Script to video", tag: "Story Mode", active: true },
  { label: "Explore style option", action: "scroll" },
];

export const Sidebar = () => {
  const handleExploreClick = () => {
    const videoGallery = document.getElementById("video-gallery");
    if (videoGallery) {
      videoGallery.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };
  return (
    <aside className="fixed left-0 top-0 bottom-0 w-[200px] bg-sidebar-bg border-r border-sidebar-border flex flex-col z-50">
      {/* Logo */}
      <div className="px-4 pt-5 pb-6">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-foreground flex items-center justify-center">
            <span className="text-background font-bold text-sm">ET</span>
          </div>
          <span className="text-sidebar-fg-active font-semibold text-sm tracking-tight">ET NewsStudio</span>
        </div>
      </div>

      {/* Main nav */}
      <nav className="px-2 space-y-0.5">
        {navItems.map((item) => (
          <button
            key={item.label}
            className="flex items-center gap-3 w-full px-3 py-2 rounded-lg text-sidebar-fg hover:text-sidebar-fg-active hover:bg-sidebar-hover transition-colors text-[13px]"
          >
            <item.icon size={16} strokeWidth={1.8} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      {/* Create section */}
      <div className="mt-6 px-2">
        <p className="px-3 text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wider mb-2">Create</p>
        <div className="space-y-0.5">
          {createItems.map((item) => (
            <button
              key={item.label}
              onClick={item.action === "scroll" ? handleExploreClick : undefined}
              className={`flex items-center gap-2 w-full px-3 py-2 rounded-lg text-[13px] transition-colors ${
                item.active
                  ? "bg-sidebar-hover text-sidebar-fg-active"
                  : "text-sidebar-fg hover:text-sidebar-fg-active hover:bg-sidebar-hover"
              }`}
            >
              <span>{item.label}</span>
              {item.tag && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                  {item.tag}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Spacer */}
      <div className="flex-1" />
    </aside>
  );
};
