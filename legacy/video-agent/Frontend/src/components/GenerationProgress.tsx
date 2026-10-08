import { useEffect, useRef, useState } from "react";
import { gsap } from "gsap";
import {
  FileText,
  Image,
  Palette,
  Film,
  FolderOpen,
  Mic2,
  Scissors,
  Sparkles,
  Check,
  Loader2,
} from "lucide-react";

interface Agent {
  id: string;
  name: string;
  action: string;
  icon: React.ReactNode;
  duration: number; // seconds
  color: string;
}

const agents: Agent[] = [
  {
    id: "extractor",
    name: "Article Extractor",
    action: "Extracting content...",
    icon: <FileText size={24} />,
    duration: 3,
    color: "#60A5FA",
  },
  {
    id: "scriptwriter",
    name: "Script Writer",
    action: "Cooking the script...",
    icon: <Sparkles size={24} />,
    duration: 4,
    color: "#A78BFA",
  },
  {
    id: "storyboard",
    name: "Storyboard Artist",
    action: "Generating images...",
    icon: <Image size={24} />,
    duration: 5,
    color: "#34D399",
  },
  {
    id: "styler",
    name: "Styler",
    action: "Applying visual style...",
    icon: <Palette size={24} />,
    duration: 4,
    color: "#F472B6",
  },
  {
    id: "motion",
    name: "Motion Designer",
    action: "Adding animations...",
    icon: <Film size={24} />,
    duration: 4,
    color: "#FBBF24",
  },
  {
    id: "asset",
    name: "Asset Manager",
    action: "Organizing assets...",
    icon: <FolderOpen size={24} />,
    duration: 2,
    color: "#38BDF8",
  },
  {
    id: "voice",
    name: "Voice Actor",
    action: "Recording narration...",
    icon: <Mic2 size={24} />,
    duration: 4,
    color: "#FB923C",
  },
  {
    id: "editor",
    name: "Editor",
    action: "Compiling final video...",
    icon: <Scissors size={24} />,
    duration: 5,
    color: "#E879F9",
  },
];

interface GenerationProgressProps {
  isVisible: boolean;
  selectedStyle: string | null;
  onComplete: () => void;
}

export const GenerationProgress = ({
  isVisible,
  selectedStyle,
  onComplete,
}: GenerationProgressProps) => {
  const [currentAgentIndex, setCurrentAgentIndex] = useState(0);
  const [completedAgents, setCompletedAgents] = useState<string[]>([]);
  const [agentProgress, setAgentProgress] = useState(0);
  const [isCompleted, setIsCompleted] = useState(false);
  const [agentStartTimes, setAgentStartTimes] = useState<Record<string, number>>({});
  const [agentEndTimes, setAgentEndTimes] = useState<Record<string, number>>({});

  const containerRef = useRef<HTMLDivElement>(null);
  const particlesRef = useRef<HTMLDivElement>(null);
  const agentCardRef = useRef<HTMLDivElement>(null);
  const orbRef = useRef<HTMLDivElement>(null);
  const progressIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Initialize particles
  useEffect(() => {
    if (!isVisible || !particlesRef.current) return;

    const container = particlesRef.current;
    container.innerHTML = "";

    // Create floating particles
    for (let i = 0; i < 50; i++) {
      const particle = document.createElement("div");
      particle.className = "absolute rounded-full";
      const size = Math.random() * 4 + 2;
      particle.style.width = `${size}px`;
      particle.style.height = `${size}px`;
      particle.style.background = `rgba(255, 255, 255, ${Math.random() * 0.3 + 0.1})`;
      particle.style.left = `${Math.random() * 100}%`;
      particle.style.top = `${Math.random() * 100}%`;
      container.appendChild(particle);

      gsap.to(particle, {
        x: `random(-100, 100)`,
        y: `random(-100, 100)`,
        opacity: `random(0.1, 0.5)`,
        duration: `random(3, 6)`,
        repeat: -1,
        yoyo: true,
        ease: "sine.inOut",
      });
    }

    return () => {
      container.innerHTML = "";
    };
  }, [isVisible]);

  // Animate orb glow based on current agent
  useEffect(() => {
    if (!isVisible || !orbRef.current) return;

    const currentAgent = agents[currentAgentIndex];
    gsap.to(orbRef.current, {
      boxShadow: `0 0 60px 20px ${currentAgent.color}40, 0 0 120px 40px ${currentAgent.color}20`,
      duration: 0.8,
      ease: "power2.out",
    });
  }, [currentAgentIndex, isVisible]);

  // Agent card entrance animation
  useEffect(() => {
    if (!isVisible || !agentCardRef.current) return;

    gsap.fromTo(
      agentCardRef.current,
      { scale: 0.8, opacity: 0, y: 20 },
      { scale: 1, opacity: 1, y: 0, duration: 0.5, ease: "back.out(1.7)" }
    );
  }, [currentAgentIndex, isVisible]);

  // Main progress simulation
  useEffect(() => {
    if (!isVisible) {
      setCurrentAgentIndex(0);
      setCompletedAgents([]);
      setAgentProgress(0);
      setIsCompleted(false);
      setAgentStartTimes({});
      setAgentEndTimes({});
      return;
    }

    const runAgent = (index: number) => {
      if (index >= agents.length) {
        setIsCompleted(true);
        setTimeout(() => {
          onComplete();
        }, 2000);
        return;
      }

      const agent = agents[index];
      setCurrentAgentIndex(index);
      setAgentProgress(0);
      setAgentStartTimes((prev) => ({ ...prev, [agent.id]: Date.now() }));

      const progressDuration = agent.duration * 1000;
      const progressStep = 100 / (progressDuration / 50);

      let currentProgress = 0;
      progressIntervalRef.current = setInterval(() => {
        currentProgress += progressStep;
        if (currentProgress >= 100) {
          currentProgress = 100;
          clearInterval(progressIntervalRef.current!);
          setAgentEndTimes((prev) => ({ ...prev, [agent.id]: Date.now() }));
          setCompletedAgents((prev) => [...prev, agent.id]);

          // Move to next agent
          setTimeout(() => {
            runAgent(index + 1);
          }, 500);
        }
        setAgentProgress(currentProgress);
      }, 50);
    };

    // Start with entrance animation
    gsap.fromTo(
      containerRef.current,
      { opacity: 0 },
      {
        opacity: 1,
        duration: 0.5,
        ease: "power2.out",
        onComplete: () => runAgent(0),
      }
    );

    return () => {
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
      }
    };
  }, [isVisible, onComplete]);

  const formatDuration = (startTime: number, endTime?: number) => {
    const end = endTime || Date.now();
    const duration = Math.round((end - startTime) / 1000);
    return `${duration}s`;
  };

  if (!isVisible) return null;

  const currentAgent = agents[currentAgentIndex];

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-50 bg-black/95 backdrop-blur-xl flex"
    >
      {/* Particles background */}
      <div ref={particlesRef} className="absolute inset-0 overflow-hidden pointer-events-none" />

      {/* Gradient overlays */}
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-black/50" />
      <div className="absolute inset-0 bg-gradient-to-r from-transparent via-transparent to-black/30" />

      {/* Main content - Center area */}
      <div className="flex-1 flex flex-col items-center justify-center relative">
        {/* Animated orb background */}
        <div
          ref={orbRef}
          className="absolute w-64 h-64 rounded-full opacity-50 blur-3xl transition-all duration-700"
          style={{ background: `radial-gradient(circle, ${currentAgent.color}30 0%, transparent 70%)` }}
        />

        {/* Style preview floating in background */}
        {selectedStyle && (
          <div className="absolute top-8 left-8 opacity-30">
            <div className="relative">
              <video
                className="w-32 h-44 object-cover rounded-lg"
                loop
                autoPlay
                muted
                playsInline
                poster={selectedStyle}
                src={selectedStyle.replace(/\.(webp|png)$/, ".webm")}
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent rounded-lg" />
              <span className="absolute bottom-2 left-2 text-xs text-white/60">Style Preview</span>
            </div>
          </div>
        )}

        {/* Current agent card */}
        <div ref={agentCardRef} className="relative z-10 text-center">
          {/* Agent icon with animated ring */}
          <div className="relative inline-flex items-center justify-center mb-6">
            {/* Animated rings */}
            <div
              className="absolute w-32 h-32 rounded-full border-2 animate-ping opacity-20"
              style={{ borderColor: currentAgent.color }}
            />
            <div
              className="absolute w-28 h-28 rounded-full border animate-pulse opacity-30"
              style={{ borderColor: currentAgent.color }}
            />

            {/* Icon container */}
            <div
              className="relative w-24 h-24 rounded-full flex items-center justify-center"
              style={{
                background: `linear-gradient(135deg, ${currentAgent.color}30 0%, ${currentAgent.color}10 100%)`,
                border: `2px solid ${currentAgent.color}50`,
              }}
            >
              <div style={{ color: currentAgent.color }}>{currentAgent.icon}</div>
            </div>
          </div>

          {/* Agent name */}
          <h2 className="text-2xl font-semibold text-white mb-2">
            {currentAgent.name}
          </h2>

          {/* Action text */}
          <p className="text-muted-foreground mb-6 flex items-center justify-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            {currentAgent.action}
          </p>

          {/* Progress bar */}
          <div className="w-64 h-1.5 bg-white/10 rounded-full overflow-hidden mx-auto mb-4">
            <div
              className="h-full rounded-full transition-all duration-100"
              style={{
                width: `${agentProgress}%`,
                background: `linear-gradient(90deg, ${currentAgent.color} 0%, ${currentAgent.color}80 100%)`,
              }}
            />
          </div>

          {/* Progress percentage */}
          <span className="text-sm text-muted-foreground">
            {Math.round(agentProgress)}%
          </span>
        </div>

        {/* Overall progress indicator */}
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2">
          <div className="flex items-center gap-2">
            {agents.map((agent, index) => (
              <div
                key={agent.id}
                className="w-2 h-2 rounded-full transition-all duration-300"
                style={{
                  background:
                    completedAgents.includes(agent.id)
                      ? agent.color
                      : index === currentAgentIndex
                      ? `${agent.color}80`
                      : "rgba(255,255,255,0.2)",
                  transform: index === currentAgentIndex ? "scale(1.5)" : "scale(1)",
                }}
              />
            ))}
          </div>
        </div>

        {/* Completion overlay */}
        {isCompleted && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80 backdrop-blur-sm">
            <div className="text-center animate-fade-in-up">
              <div className="w-20 h-20 rounded-full bg-green-500/20 border-2 border-green-500 flex items-center justify-center mx-auto mb-4">
                <Check className="w-10 h-10 text-green-500" />
              </div>
              <h2 className="text-2xl font-semibold text-white mb-2">Video Ready!</h2>
              <p className="text-muted-foreground">Your video has been generated</p>
            </div>
          </div>
        )}
      </div>

      {/* Right sidebar - ET News Agent style progress */}
      <div className="w-80 bg-black/50 border-l border-white/10 p-6 flex flex-col">
        <div className="mb-6">
          <h3 className="text-lg font-semibold text-white mb-1">Generation Progress</h3>
          <p className="text-sm text-muted-foreground">AI agents are creating your video</p>
        </div>

        {/* Agent list */}
        <div className="flex-1 overflow-y-auto space-y-3">
          {agents.map((agent, index) => {
            const isComplete = completedAgents.includes(agent.id);
            const isCurrent = index === currentAgentIndex && !isCompleted;
            const isPending = !isComplete && !isCurrent;
            const startTime = agentStartTimes[agent.id];
            const endTime = agentEndTimes[agent.id];

            return (
              <div
                key={agent.id}
                className={`relative p-3 rounded-lg transition-all duration-300 ${
                  isCurrent
                    ? "bg-white/10 border border-white/20"
                    : isComplete
                    ? "bg-white/5"
                    : "opacity-40"
                }`}
              >
                <div className="flex items-start gap-3">
                  {/* Status indicator */}
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                      isComplete
                        ? "bg-green-500/20"
                        : isCurrent
                        ? "bg-white/10"
                        : "bg-white/5"
                    }`}
                    style={{
                      borderColor: isComplete ? "#22C55E" : isCurrent ? agent.color : "transparent",
                      borderWidth: "1px",
                    }}
                  >
                    {isComplete ? (
                      <Check className="w-4 h-4 text-green-500" />
                    ) : isCurrent ? (
                      <Loader2
                        className="w-4 h-4 animate-spin"
                        style={{ color: agent.color }}
                      />
                    ) : (
                      <span
                        className="text-xs font-medium"
                        style={{ color: "rgba(255,255,255,0.4)" }}
                      >
                        {index + 1}
                      </span>
                    )}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span
                        className={`text-sm font-medium ${
                          isComplete || isCurrent ? "text-white" : "text-white/50"
                        }`}
                      >
                        {agent.name}
                      </span>
                      {startTime && (
                        <span className="text-xs text-muted-foreground">
                          {formatDuration(startTime, endTime)}
                        </span>
                      )}
                    </div>
                    <p
                      className={`text-xs mt-0.5 ${
                        isCurrent
                          ? "text-muted-foreground"
                          : isComplete
                          ? "text-green-500/70"
                          : "text-white/30"
                      }`}
                    >
                      {isComplete ? "Completed" : isCurrent ? agent.action : "Waiting..."}
                    </p>

                    {/* Progress bar for current agent */}
                    {isCurrent && (
                      <div className="mt-2 w-full h-1 bg-white/10 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-100"
                          style={{
                            width: `${agentProgress}%`,
                            background: agent.color,
                          }}
                        />
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Bottom info */}
        <div className="mt-4 pt-4 border-t border-white/10">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Total Progress</span>
            <span className="text-white font-medium">
              {Math.round((completedAgents.length / agents.length) * 100)}%
            </span>
          </div>
          <div className="mt-2 w-full h-2 bg-white/10 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-300 bg-gradient-to-r from-blue-500 via-purple-500 to-pink-500"
              style={{
                width: `${(completedAgents.length / agents.length) * 100}%`,
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
