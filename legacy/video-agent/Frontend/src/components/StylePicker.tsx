"use client";

import { useState, useRef } from "react";
import { Plus } from "lucide-react";

interface CustomStyle {
  name: string;
  src: string;
  isCustom: true;
  file: File;
}

type StyleItem = { name: string; src: string } | CustomStyle;
export type SelectedStyle = { name: string; src: string; file?: File | null };

const styles = [
  { name: "2D Line", src: "https://prod-ao-ext.cdn.opus.pro/story-mode/styles/2d%20line.webp" },
  { name: "Collage", src: "https://prod-ao-ext.cdn.opus.pro/story-mode/styles/Blue%20collage.webp" },
  { name: "Animation", src: "https://prod-ao-ext.cdn.opus.pro/story-mode/styles/3d%20animatoin.webp" },
  { name: "Blue Vox", src: "https://prod-ao-ext.cdn.opus.pro/story-mode/styles/Blue%20vox.webp" },
  { name: "Claymation", src: "https://prod-ao-ext.cdn.opus.pro/story-mode/styles/Claymation.webp" },
  { name: "Claire", src: "https://prod-ao-ext.cdn.opus.pro/story-mode/styles/Claire.webp" },
  { name: "Marcinelle", src: "https://prod-ao-ext.cdn.opus.pro/story-mode/styles/Marcinelle.webp" },
  { name: "Pen&Ink", src: "https://prod-ao-ext.cdn.opus.pro/story-mode/styles/Pen%20%26%20ink.webp" },
  { name: "Schematic", src: "https://prod-ao-ext.cdn.opus.pro/story-mode/styles/Schematic.webp" },
  { name: "Vox", src: "https://prod-ao-ext.cdn.opus.pro/story-mode/styles/Yellow%20vox.webp" },
  { name: "Watercolor", src: "https://prod-ao-ext.cdn.opus.pro/story-mode/styles/Watercolor.webp" },
  { name: "Papercraft", src: "https://prod-ao-ext.cdn.opus.pro/story-mode/styles/Papercraft.png" },
  { name: "Papercraft Mono", src: "https://prod-ao-ext.cdn.opus.pro/story-mode/styles/Papercraft%20Peach.png" },
  { name: "Halftone", src: "https://prod-ao-ext.cdn.opus.pro/story-mode/styles/Halftone.webp" },
  { name: "Economic", src: "https://prod-ao-ext.cdn.opus.pro/story-mode/styles/Economic.webp" },
];

export const StylePicker = ({
  onHoverChange,
  onStyleSelect,
}: {
  onHoverChange?: (isHovering: boolean) => void;
  onStyleSelect?: (style: SelectedStyle | null) => void;
}) => {
  const [hoveredStyle, setHoveredStyle] = useState<string | null>(null);
  const [hoverPreviewLeft, setHoverPreviewLeft] = useState<number | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [customStyles, setCustomStyles] = useState<CustomStyle[]>([]);
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const hasDraggedRef = useRef(false);
  const dragStartXRef = useRef(0);
  const dragStartScrollLeftRef = useRef(0);

  const allStyles: StyleItem[] = [...styles, ...customStyles];

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
      const newStyle: CustomStyle = {
        name: `Custom ${customStyles.length + 1}`,
        src: url,
        isCustom: true,
        file,
      };
      const nextCustomStyles = [...customStyles, newStyle];
      const nextIndex = styles.length + nextCustomStyles.length - 1;
      setCustomStyles(nextCustomStyles);
      setSelectedIndex(nextIndex);
      onStyleSelect?.({ name: newStyle.name, src: newStyle.src, file: newStyle.file });
    }
    // Reset input so same file can be selected again
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) {
      return;
    }
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }
    e.preventDefault();
    isDraggingRef.current = true;
    hasDraggedRef.current = false;
    dragStartXRef.current = e.clientX;
    dragStartScrollLeftRef.current = container.scrollLeft;
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const container = scrollContainerRef.current;
    if (!container || !isDraggingRef.current) {
      return;
    }
    e.preventDefault();
    const deltaX = e.clientX - dragStartXRef.current;
    if (Math.abs(deltaX) > 4) {
      hasDraggedRef.current = true;
    }
    container.scrollLeft = dragStartScrollLeftRef.current - deltaX;
  };

  const stopDragging = () => {
    isDraggingRef.current = false;
  };

  const updateHoverPreviewPosition = (target: HTMLButtonElement) => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const rootRect = root.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    setHoverPreviewLeft(targetRect.left - rootRect.left + (targetRect.width / 2));
  };

  return (
    <div className="w-full max-w-[980px] mx-auto">
      <div ref={rootRef} className="relative w-full overflow-x-visible overflow-y-visible cursor-grab select-none">
        <div className="pointer-events-none absolute left-0 top-0 z-20 h-full w-10 bg-gradient-to-r from-black to-transparent" />
        <div className="pointer-events-none absolute right-0 top-0 z-20 h-full w-10 bg-gradient-to-l from-black to-transparent" />
        {hoveredStyle && hoverPreviewLeft !== null && (
          <div
            className="absolute z-50 pointer-events-none"
            style={{
              left: `${hoverPreviewLeft}px`,
              transform: 'translateX(-50%)',
              top: '-166px',
            }}
          >
            <div className="rounded-lg overflow-hidden border border-muted-foreground/40 shadow-2xl bg-black/30 backdrop-blur-md">
              <img
                className="h-[130px] w-[96px] rounded-lg object-cover"
                src={hoveredStyle}
                alt="Style preview"
                draggable={false}
              />
            </div>
          </div>
        )}
        <div
          ref={scrollContainerRef}
          className="style-picker-track w-full overflow-x-auto overflow-y-hidden cursor-grab active:cursor-grabbing px-2"
          style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={stopDragging}
          onMouseLeave={stopDragging}
        >
          <div className="flex items-start gap-6 min-w-max py-1">
            {/* Add style button */}
            <button
              className="flex w-[84px] shrink-0 flex-col items-center gap-2 group"
              type="button"
              onClick={() => fileInputRef.current?.click()}
            >
              <div className="flex h-[82px] w-[62px] items-center justify-center rounded-xl border-2 border-white/25 bg-white/[0.06] hover:bg-white/[0.1] transition-colors">
                <Plus className="w-4.5 h-4.5 text-white/80" />
              </div>
              <span className="text-white/80 line-clamp-2 max-w-[84px] text-center text-sm font-medium leading-[16px]">
                Add style
              </span>
            </button>

            {/* Divider */}
            <div className="flex h-[82px] shrink-0 items-center justify-center px-0">
              <div className="h-10 w-px shrink-0 bg-white/20"></div>
            </div>

            {/* Hidden file input */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileUpload}
              className="hidden"
            />

            {allStyles.map((style, index) => (
              <button
                key={style.name}
                ref={(el) => (buttonRefs.current[index] = el)}
                className={`flex w-[84px] shrink-0 flex-col items-center gap-2 group transition-all ${
                  selectedIndex === index ? "opacity-100" : ""
                }`}
                type="button"
                draggable={false}
                onClick={() => {
                  if (hasDraggedRef.current) {
                    hasDraggedRef.current = false;
                    return;
                  }
                  const isDeselect = selectedIndex === index;
                  setSelectedIndex(isDeselect ? null : index);
                  if (isDeselect) {
                    onStyleSelect?.(null);
                    return;
                  }
                  onStyleSelect?.({
                    name: style.name,
                    src: style.src,
                    file: "file" in style ? style.file : null,
                  });
                }}
                onMouseEnter={(e) => {
                  updateHoverPreviewPosition(e.currentTarget);
                  setHoveredStyle(style.src);
                  onHoverChange?.(true);
                }}
                onMouseLeave={() => {
                  setHoveredStyle(null);
                  setHoverPreviewLeft(null);
                  onHoverChange?.(false);
                }}
              >
                <div
                  className={`h-[82px] w-[62px] overflow-hidden rounded-xl transition-all duration-200 hover:opacity-35 border-2 ${
                    selectedIndex === index
                      ? "border-foreground"
                      : "border-transparent"
                  }`}
                >
                  <img
                    alt={style.name}
                    className="size-full rounded-sm object-cover"
                    src={style.src}
                    draggable={false}
                  />
                </div>
                <span className="text-white/75 group-hover:text-white line-clamp-2 max-w-[84px] overflow-hidden text-center text-sm font-medium leading-[16px]">
                  {style.name}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <style>{`
        .style-picker-track::-webkit-scrollbar {
          display: none;
          width: 0;
          height: 0;
        }
      `}</style>
    </div>
  );
};
