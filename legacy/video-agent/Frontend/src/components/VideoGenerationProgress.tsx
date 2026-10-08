import { useEffect } from "react";
import { Check, Loader2, X, XCircle } from "lucide-react";
import { VideoPlayer } from "./VideoPlayer";
import type { JobStatus } from "@/lib/api";

const PHASES = [
  "Job queued",
  "Agent started",
  "Writing script",
  "Creating storyboard",
  "Generating narration",
  "Animating scenes",
  "Composing final video",
  "Archiving outputs",
  "Video ready",
];

export interface UiNotification {
  seq: number;
  text: string;
  receivedAt: number;
}

interface VideoGenerationProgressProps {
  selectedStyle: string | null;
  notifications: UiNotification[];
  status: JobStatus | null;
  resultUrl: string | null;
  error: string | null;
  onComplete?: () => void;
}

const formatStamp = (timestamp: number) =>
  new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

export const VideoGenerationProgress = ({
  selectedStyle,
  notifications,
  status,
  resultUrl,
  error,
  onComplete,
}: VideoGenerationProgressProps) => {
  useEffect(() => {
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, []);

  const latest = notifications[notifications.length - 1];
  const latestMessage = latest?.text ?? (status === "queued" ? "Job queued" : "Waiting to start");

  const phaseIndex = notifications.reduce((max, item) => {
    const idx = PHASES.findIndex((phase) => phase.toLowerCase() === item.text.toLowerCase());
    return Math.max(max, idx);
  }, -1);

  const phaseProgress = phaseIndex >= 0 ? ((phaseIndex + 1) / PHASES.length) * 100 : 0;
  const fallbackProgress = Math.min((notifications.length / PHASES.length) * 100, 95);
  const runningProgress = Math.max(phaseProgress, fallbackProgress);
  const overallProgress = status === "completed" ? 100 : Math.round(runningProgress);

  const isComplete = status === "completed" && !!resultUrl;
  const isFailed = status === "failed";

  return (
    <div className="fixed inset-0 z-50 flex bg-black overflow-hidden">
      <div className="flex-1 flex items-center justify-center relative px-4 sm:px-6">
        <div className="absolute w-80 h-80 rounded-full bg-white opacity-[0.03] blur-[100px] animate-pulse-slow" />

        {isComplete ? (
          <div className="z-10 w-full max-w-md">
            <VideoPlayer videoUrl={resultUrl} inline={true} aspectRatio="9:16" onClose={onComplete} />
          </div>
        ) : isFailed ? (
          <div className="z-10 w-full max-w-md rounded-2xl border border-red-400/30 bg-red-400/10 p-8 text-center">
            <XCircle className="mx-auto mb-4 h-10 w-10 text-red-300" />
            <h2 className="mb-2 text-xl font-semibold text-white">Generation failed</h2>
            <p className="text-sm text-red-100/90">{error ?? "The backend returned an error."}</p>
            {onComplete ? (
              <button
                onClick={onComplete}
                className="mt-6 rounded-full border border-white/20 px-5 py-2 text-sm text-white hover:bg-white/10 transition-colors"
              >
                Close
              </button>
            ) : null}
          </div>
        ) : (
          <div className="text-center z-10 max-w-md">
            <div className="glass-portrait-shell mx-auto">
              <div className="glass-orb glass-orb-a" />
              <div className="glass-orb glass-orb-b" />
              <div className="glass-noise" />
              <div className="glass-sheen" />

              <div className="relative z-10 h-full flex flex-col items-center justify-center px-6 py-10">
                {selectedStyle && (
                  <div className="mb-8 flex justify-center">
                    <div className="relative">
                      <div className="w-32 h-48 rounded-2xl overflow-hidden border border-white/30 shadow-2xl">
                        <img src={selectedStyle} alt="Selected style" className="w-full h-full object-cover" />
                      </div>
                      <div className="absolute -inset-5 bg-white/10 rounded-2xl blur-2xl -z-10" />
                    </div>
                  </div>
                )}

                <h2 className="text-[18px] font-semibold text-white mb-1.5 leading-tight tracking-tight">
                  {latestMessage}
                </h2>
                <p className="text-white/70 text-sm font-medium mb-5">{overallProgress}%</p>

                <div className="w-full max-w-[180px] mx-auto">
                  <div className="h-1.5 bg-white/12 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-white/90 rounded-full transition-all duration-300 relative"
                      style={{ width: `${overallProgress}%` }}
                    >
                      <div className="absolute inset-0 shimmer" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <aside className="relative z-20 h-full w-[320px] xl:w-[340px] border-l border-white/10 bg-[#0d0f12]/88 backdrop-blur-xl flex flex-col">
        {onComplete ? (
          <button
            onClick={onComplete}
            className="absolute right-3 top-3 z-30 h-8 w-8 rounded-full border border-white/20 bg-white/5 text-white/70 hover:bg-white/10 hover:text-white transition-colors flex items-center justify-center"
            aria-label="Close progress"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}

        <div className="px-4 py-4 border-b border-white/10">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-white flex items-center justify-center">
              <span className="text-black font-semibold text-[10px]">ET</span>
            </div>
            <div>
              <h3 className="text-white text-base font-semibold leading-tight">ET News Agent</h3>
              <p className="text-white/45 text-[11px] tracking-wide uppercase">Live backend updates</p>
            </div>
            <div className="ml-auto flex items-center gap-2">
              {isComplete ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="text-emerald-400 text-xs">Complete</span>
                </>
              ) : isFailed ? (
                <>
                  <XCircle className="w-3.5 h-3.5 text-red-400" />
                  <span className="text-red-300 text-xs">Failed</span>
                </>
              ) : (
                <>
                  <Loader2 className="w-3.5 h-3.5 text-cyan-200 animate-spin" />
                  <span className="text-cyan-200 text-xs">Processing</span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="px-4 py-3 border-b border-white/10">
          <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
            <div className="flex items-center justify-between mb-2">
              <span className="text-white/60 text-[11px] tracking-wide uppercase">Pipeline Progress</span>
              <span className="text-white/80 text-xs font-mono">{overallProgress}%</span>
            </div>
            <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-cyan-200 via-white to-emerald-200 rounded-full transition-all duration-500"
                style={{ width: `${overallProgress}%` }}
              />
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3 scrollbar-hide">
          {notifications.map((notification) => (
            <div key={notification.seq} className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-3">
              <div className="flex items-start gap-3">
                <div className="w-5 h-5 rounded-full border border-cyan-200/30 bg-cyan-200/5 flex items-center justify-center mt-0.5 shrink-0">
                  <div className="w-1.5 h-1.5 rounded-full bg-cyan-200" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-white/90 text-sm font-medium">{notification.text}</span>
                    <span className="text-white/35 text-xs ml-auto">{formatStamp(notification.receivedAt)}</span>
                  </div>
                </div>
              </div>
            </div>
          ))}

          {!notifications.length ? (
            <p className="text-sm text-white/45">Waiting for first backend update...</p>
          ) : null}
        </div>
      </aside>

      <style>{`
        .glass-portrait-shell {
          position: relative;
          width: min(84vw, 340px);
          min-width: 260px;
          aspect-ratio: 9 / 16;
          border-radius: 30px;
          border: 1px solid rgba(255, 255, 255, 0.18);
          background: linear-gradient(155deg, rgba(255, 255, 255, 0.14) 0%, rgba(255, 255, 255, 0.04) 55%, rgba(255, 255, 255, 0.08) 100%);
          box-shadow: 0 18px 50px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.25);
          backdrop-filter: blur(18px) saturate(130%);
          -webkit-backdrop-filter: blur(18px) saturate(130%);
          overflow: hidden;
          animation: glassFloat 4.5s ease-in-out infinite;
        }

        .glass-orb {
          position: absolute;
          border-radius: 999px;
          filter: blur(26px);
          pointer-events: none;
          opacity: 0.6;
        }

        .glass-orb-a {
          width: 140px;
          height: 140px;
          top: -45px;
          left: -35px;
          background: rgba(122, 173, 255, 0.34);
          animation: orbShiftA 8s ease-in-out infinite;
        }

        .glass-orb-b {
          width: 150px;
          height: 150px;
          right: -52px;
          bottom: -40px;
          background: rgba(255, 255, 255, 0.26);
          animation: orbShiftB 9s ease-in-out infinite;
        }

        .glass-noise {
          position: absolute;
          inset: 0;
          opacity: 0.14;
          background-image: radial-gradient(circle at 1px 1px, rgba(255,255,255,0.5) 1px, transparent 0);
          background-size: 3px 3px;
          pointer-events: none;
        }

        .glass-sheen {
          position: absolute;
          inset: -45%;
          background: linear-gradient(110deg, transparent 35%, rgba(255,255,255,0.22) 50%, transparent 65%);
          transform: translateX(-58%) rotate(8deg);
          animation: glassSheen 3.8s ease-in-out infinite;
          pointer-events: none;
        }

        @keyframes glassFloat {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-6px); }
        }

        @keyframes orbShiftA {
          0%, 100% { transform: translate(0, 0); opacity: 0.5; }
          50% { transform: translate(16px, 14px); opacity: 0.8; }
        }

        @keyframes orbShiftB {
          0%, 100% { transform: translate(0, 0); opacity: 0.45; }
          50% { transform: translate(-18px, -12px); opacity: 0.75; }
        }

        @keyframes glassSheen {
          0% { transform: translateX(-62%) rotate(8deg); }
          50% { transform: translateX(2%) rotate(8deg); }
          100% { transform: translateX(62%) rotate(8deg); }
        }

        .animate-pulse-slow { animation: pulseSlow 4s ease-in-out infinite; }
        @keyframes pulseSlow {
          0%, 100% { opacity: 0.03; transform: scale(1); }
          50% { opacity: 0.06; transform: scale(1.1); }
        }

        .shimmer {
          background: linear-gradient(90deg, transparent, rgba(255,255,255,0.4), transparent);
          animation: shimmer 1.5s infinite;
        }
        @keyframes shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
      `}</style>
    </div>
  );
};
