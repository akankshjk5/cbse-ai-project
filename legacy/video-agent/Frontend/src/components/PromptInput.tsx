import { useEffect, useRef, useState } from "react";
import { Clapperboard, Smartphone, Mic, ArrowUp, Clock } from "lucide-react";

const DURATION_OPTIONS = [
  { value: 30, label: "30s" },
  { value: 60, label: "60s" },
  { value: 120, label: "2min" },
  { value: 140, label: "2:20" },
];

interface PromptInputProps {
  selectedStyle?: string | null;
  onGenerate?: (text: string, duration: number) => void;
  isSubmitting?: boolean;
}

export const PromptInput = ({ selectedStyle, onGenerate, isSubmitting = false }: PromptInputProps) => {
  const [text, setText] = useState("");
  const [selectedDuration, setSelectedDuration] = useState(60);
  const [showDurationPicker, setShowDurationPicker] = useState(false);
  const durationPickerRef = useRef<HTMLDivElement>(null);
  const maxChars = 450;
  const isSubmitDisabled = !text.trim() || isSubmitting;

  useEffect(() => {
    const onDocClick = (event: MouseEvent) => {
      if (!durationPickerRef.current) {
        return;
      }
      if (!durationPickerRef.current.contains(event.target as Node)) {
        setShowDurationPicker(false);
      }
    };

    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const handleSubmit = () => {
    if (!isSubmitDisabled && onGenerate) {
      onGenerate(text, selectedDuration);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !isSubmitDisabled) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="relative bg-surface-elevated rounded-xl border border-border overflow-visible">
      {selectedStyle && (
        <div className="px-5 pt-4 pb-3 border-b border-border/50 flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Selected style:</span>
            <div className="h-8 w-8 rounded-sm overflow-hidden border border-border">
              <video
                className="size-full object-cover"
                loop
                playsInline
                poster={selectedStyle}
                preload="auto"
                src={selectedStyle.replace(/\.(webp|png)$/, '.webm')}
              />
            </div>
          </div>
        </div>
      )}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value.slice(0, maxChars))}
        onKeyDown={handleKeyDown}
        placeholder="Paste any article link, or news links — between articles and news"
        className="w-full bg-transparent px-5 pt-4 pb-2 text-sm text-foreground placeholder:text-muted-foreground resize-none outline-none min-h-[80px]"
        rows={3}
      />
      <div className="flex items-center justify-between px-4 pb-3">
        <div className="flex items-center gap-4">
          <button className="text-muted-foreground hover:text-foreground transition-colors">
            <Clapperboard size={18} strokeWidth={1.8} />
          </button>
          <button className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors text-sm">
            <Smartphone size={16} strokeWidth={1.8} />
            <span>9:16</span>
          </button>
          <button className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors text-sm">
            <Mic size={16} strokeWidth={1.8} />
            <span>Voice</span>
          </button>
          {/* Duration picker */}
          <div className="relative" ref={durationPickerRef}>
            <button
              onClick={() => setShowDurationPicker(!showDurationPicker)}
              className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors text-sm focus:outline-none focus-visible:outline-none focus-visible:ring-0"
              type="button"
            >
              <Clock size={16} strokeWidth={1.8} />
              <span>{DURATION_OPTIONS.find(d => d.value === selectedDuration)?.label}</span>
            </button>
            {showDurationPicker && (
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-3 w-20 rounded-xl border border-white/15 bg-[#1c1d21] p-1.5 shadow-[0_10px_30px_rgba(0,0,0,0.45)] z-50">
                {DURATION_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    onClick={() => {
                      setSelectedDuration(option.value);
                      setShowDurationPicker(false);
                    }}
                    className={`w-full px-2 py-1.5 text-sm rounded-md text-center transition-colors ${
                      selectedDuration === option.value
                        ? "bg-white/20 text-white"
                        : "text-white/70 hover:bg-white/10 hover:text-white"
                    }`}
                    type="button"
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            {text.length} / {maxChars}
          </span>
          <button
            disabled={isSubmitDisabled}
            onClick={handleSubmit}
            className={`w-8 h-8 rounded-full flex items-center justify-center transition-all ${
              isSubmitDisabled
                ? "bg-muted text-muted-foreground cursor-not-allowed"
                : "bg-foreground text-background hover:bg-foreground/90"
            }`}
          >
            {isSubmitting ? (
              <Clock size={14} strokeWidth={2} className="animate-spin" />
            ) : (
              <ArrowUp size={16} strokeWidth={2} />
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
