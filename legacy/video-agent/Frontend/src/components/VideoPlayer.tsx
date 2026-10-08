import { useState, useRef, useEffect } from "react";
import {
  Download,
  Share2,
  Maximize2,
  Minimize2,
  Volume2,
  VolumeX,
  Play,
  Pause,
  X,
} from "lucide-react";

interface VideoPlayerProps {
  videoUrl: string;
  onClose?: () => void;
  inline?: boolean;
  aspectRatio?: "16:9" | "9:16";
}

export const VideoPlayer = ({
  videoUrl,
  onClose,
  inline = false,
  aspectRatio = "16:9",
}: VideoPlayerProps) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [isMuted, setIsMuted] = useState(false);
  const [progress, setProgress] = useState(0);
  const [showControls, setShowControls] = useState(true);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const isDockedFooterTimeline = inline && aspectRatio === "9:16";

  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleTimeUpdate = () => {
      setCurrentTime(video.currentTime);
      setProgress((video.currentTime / video.duration) * 100);
    };

    const handleLoadedMetadata = () => {
      setDuration(video.duration);
    };

    const handleEnded = () => {
      setIsPlaying(false);
    };

    video.addEventListener("timeupdate", handleTimeUpdate);
    video.addEventListener("loadedmetadata", handleLoadedMetadata);
    video.addEventListener("ended", handleEnded);

    return () => {
      video.removeEventListener("timeupdate", handleTimeUpdate);
      video.removeEventListener("loadedmetadata", handleLoadedMetadata);
      video.removeEventListener("ended", handleEnded);
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = isMuted ? 0 : volume;
  }, [volume, isMuted]);

  useEffect(() => {
    if (isDockedFooterTimeline) {
      setShowControls(true);
    }
  }, [isDockedFooterTimeline]);

  const handleMouseMove = () => {
    if (isDockedFooterTimeline) {
      setShowControls(true);
      return;
    }

    setShowControls(true);
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    controlsTimeoutRef.current = setTimeout(() => {
      if (isPlaying) {
        setShowControls(false);
      }
    }, 3000);
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;

    if (isPlaying) {
      video.pause();
    } else {
      video.play();
    }
    setIsPlaying(!isPlaying);
  };

  const toggleFullscreen = () => {
    const container = containerRef.current;
    if (!container) return;

    if (!isFullscreen) {
      if (container.requestFullscreen) {
        container.requestFullscreen();
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      }
    }
    setIsFullscreen(!isFullscreen);
  };

  const toggleMute = () => {
    setIsMuted(!isMuted);
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVolume = parseFloat(e.target.value);
    setVolume(newVolume);
    if (newVolume === 0) {
      setIsMuted(true);
    } else if (isMuted) {
      setIsMuted(false);
    }
  };

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    if (!video) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const percentage = clickX / rect.width;
    video.currentTime = percentage * video.duration;
  };

  const handleDownload = async () => {
    try {
      const response = await fetch(videoUrl);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "generated-video.mp4";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error("Download failed:", error);
    }
  };

  const handleShare = async () => {
    try {
      if (navigator.share) {
        await navigator.share({
          title: "Generated Video",
          text: "Check out this video I created with ET NewsStudio!",
          url: videoUrl,
        });
      } else {
        await navigator.clipboard.writeText(videoUrl);
        alert("Video link copied to clipboard");
      }
    } catch (error) {
      console.error("Share failed:", error);
    }
  };

  const formatTime = (time: number) => {
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  const videoContent = (
    <>
      {/* Video container */}
      <div
        ref={containerRef}
        className={`relative bg-black rounded-2xl overflow-hidden ${
          inline
            ? aspectRatio === "9:16"
              ? "w-full max-w-[360px] aspect-[9/16]"
              : "w-full max-w-2xl aspect-video"
            : "w-full max-w-4xl mx-4 aspect-video"
        }`}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => !isDockedFooterTimeline && isPlaying && setShowControls(false)}
      >
        <video
          ref={videoRef}
          src={videoUrl}
          className="w-full h-full object-contain"
          onClick={togglePlay}
        />

        {/* Play/Pause overlay */}
        {!isPlaying && (
          <div
            className="absolute inset-0 flex items-center justify-center cursor-pointer"
            onClick={togglePlay}
          >
            <div className="relative group">
              <div className="absolute inset-0 rounded-full bg-white/20 blur-md transition-all duration-300 group-hover:scale-110" />
              <div className={`relative rounded-full border border-white/35 bg-white/15 backdrop-blur-xl flex items-center justify-center shadow-[0_10px_28px_rgba(0,0,0,0.35)] transition-all duration-300 group-hover:bg-white/25 group-hover:scale-105 ${
                inline ? "w-16 h-16" : "w-20 h-20"
              }`}>
                <Play className={`text-white ml-1 ${inline ? "w-8 h-8" : "w-10 h-10"}`} />
              </div>
            </div>
          </div>
        )}

        {/* Controls overlay */}
        <div
          className={`${
            isDockedFooterTimeline
              ? "fixed bottom-0 left-0 right-0 z-40 bg-gradient-to-t from-black/95 via-black/80 to-transparent px-5 pb-5 pt-8 backdrop-blur-sm"
              : "absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-4"
          } transition-opacity duration-300 ${
            isDockedFooterTimeline || showControls ? "opacity-100" : "opacity-0"
          }`}
          onMouseMove={handleMouseMove}
        >
          <div className={isDockedFooterTimeline ? "mx-auto w-full" : "w-full"}>
          {/* Progress bar */}
          <div
            className="w-full h-1 bg-white/20 rounded-full mb-4 cursor-pointer group"
            onClick={handleProgressClick}
          >
            <div
              className="h-full bg-white rounded-full relative transition-all"
              style={{ width: `${progress}%` }}
            >
              <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
          </div>

          <div className="flex items-center justify-between">
            {/* Left controls */}
            <div className="flex items-center gap-3">
              <button
                onClick={togglePlay}
                className={`rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors ${
                  inline ? "w-8 h-8" : "w-10 h-10"
                }`}
              >
                {isPlaying ? (
                  <Pause className={`text-white ${inline ? "w-4 h-4" : "w-5 h-5"}`} />
                ) : (
                  <Play className={`text-white ml-0.5 ${inline ? "w-4 h-4" : "w-5 h-5"}`} />
                )}
              </button>

              {/* Volume control */}
              <div className="flex items-center gap-2 group">
                <button
                  onClick={toggleMute}
                  className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center transition-colors"
                >
                  {isMuted || volume === 0 ? (
                    <VolumeX className="w-4 h-4 text-white" />
                  ) : (
                    <Volume2 className="w-4 h-4 text-white" />
                  )}
                </button>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.1"
                  value={isMuted ? 0 : volume}
                  onChange={handleVolumeChange}
                  className="w-0 group-hover:w-20 transition-all duration-300 accent-white h-1 bg-white/20 rounded-full cursor-pointer"
                />
              </div>

              {/* Time display */}
              <span className="text-white/60 text-xs font-mono">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>
            </div>

            {/* Right controls */}
            <div className="flex items-center gap-2">
              <button
                onClick={handleDownload}
                className={`rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors ${
                  inline ? "w-8 h-8" : "w-10 h-10"
                }`}
                title="Download"
              >
                <Download className="w-4 h-4 text-white" />
              </button>

              <button
                onClick={handleShare}
                className={`rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors ${
                  inline ? "w-8 h-8" : "w-10 h-10"
                }`}
                title="Share"
              >
                <Share2 className="w-4 h-4 text-white" />
              </button>

              <button
                onClick={toggleFullscreen}
                className={`rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors ${
                  inline ? "w-8 h-8" : "w-10 h-10"
                }`}
                title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
              >
                {isFullscreen ? (
                  <Minimize2 className="w-4 h-4 text-white" />
                ) : (
                  <Maximize2 className="w-4 h-4 text-white" />
                )}
              </button>
            </div>
          </div>
          </div>
        </div>
      </div>

      {/* Action buttons below video */}
      {!isDockedFooterTimeline && (
      <div className={`flex items-center gap-4 ${inline ? "mt-6" : "absolute bottom-8"}`}>
        <button
          onClick={handleDownload}
          className="flex items-center gap-2 px-6 py-3 bg-white text-black font-medium rounded-full hover:bg-white/90 transition-colors"
        >
          <Download className="w-4 h-4" />
          Download
        </button>
        <button
          onClick={handleShare}
          className="flex items-center gap-2 px-6 py-3 bg-white/10 text-white font-medium rounded-full hover:bg-white/20 transition-colors border border-white/20"
        >
          <Share2 className="w-4 h-4" />
          Share
        </button>
        {inline && onClose && (
          <button
            onClick={onClose}
            className="flex items-center gap-2 px-6 py-3 bg-white/5 text-white/60 font-medium rounded-full hover:bg-white/10 transition-colors border border-white/10"
          >
            <X className="w-4 h-4" />
            Close
          </button>
        )}
      </div>
      )}
    </>
  );

  if (inline) {
    return (
      <div className="flex flex-col items-center justify-center w-full h-full">
        {videoContent}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black">
      {/* Close button */}
      <button
        onClick={onClose}
        className="absolute top-4 right-4 z-50 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors"
      >
        <X className="w-5 h-5 text-white" />
      </button>

      {videoContent}
    </div>
  );
};
