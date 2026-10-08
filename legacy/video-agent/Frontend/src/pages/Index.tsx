import { useEffect, useRef, useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import { StylePicker, type SelectedStyle } from "@/components/StylePicker";
import { PromptInput } from "@/components/PromptInput";
import { VideoGenerationProgress, type UiNotification } from "@/components/VideoGenerationProgress";
import { buildResultUrl, getJob, getNotifications, startJob, type JobStatus } from "@/lib/api";
import { toast } from "@/components/ui/sonner";
import { Menu, X } from "lucide-react";

const Index = () => {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [selectedStyle, setSelectedStyle] = useState<SelectedStyle | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);
  const [notifications, setNotifications] = useState<UiNotification[]>([]);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const lastNotificationSeqRef = useRef(0);

  const handleGenerate = async (text: string, duration?: number) => {
    if (isSubmitting) {
      return;
    }

    const stylePrompt = selectedStyle
      ? selectedStyle.file
        ? `Preferred style: ${selectedStyle.name}\nUse the uploaded reference image for this style.`
        : `Preferred style: ${selectedStyle.name}\nStyle reference: ${selectedStyle.src}`
      : "";
    const durationPrompt = duration ? `Target duration: ${duration} seconds.` : "";
    const finalMessage = [text.trim(), stylePrompt, durationPrompt].filter(Boolean).join("\n\n");

    setIsSubmitting(true);
    setJobError(null);
    setNotifications([]);
    setResultUrl(null);
    setJobStatus(null);
    lastNotificationSeqRef.current = 0;

    try {
      const started = await startJob({
        message: finalMessage,
        styleName: selectedStyle?.name ?? null,
        imageFile: selectedStyle?.file ?? null,
        imageUrl: selectedStyle && !selectedStyle.file ? selectedStyle.src : null,
      });
      setJobId(started.job_id);
      setJobStatus(started.status);
      setIsGenerating(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start job";
      toast.error(message);
      setJobError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleGenerationComplete = () => {
    setIsGenerating(false);
    setJobId(null);
    setJobStatus(null);
    setNotifications([]);
    setResultUrl(null);
    setJobError(null);
    lastNotificationSeqRef.current = 0;
  };

  useEffect(() => {
    if (!isGenerating || !jobId) {
      return;
    }

    let cancelled = false;
    let timeoutId: number | null = null;

    const poll = async () => {
      if (cancelled) {
        return;
      }

      try {
        const updates = await getNotifications(jobId, lastNotificationSeqRef.current);
        if (updates.notifications.length > 0) {
          const next = updates.notifications.map((item) => ({
            ...item,
            receivedAt: Date.now(),
          }));
          setNotifications((prev) => [...prev, ...next]);
          lastNotificationSeqRef.current = updates.notifications[updates.notifications.length - 1].seq;
        }

        const job = await getJob(jobId);
        setJobStatus(job.status);

        if (job.status === "completed") {
          setResultUrl(`${buildResultUrl(jobId)}?t=${Date.now()}`);
          return;
        }
        if (job.status === "failed") {
          setJobError(job.error ?? "Job failed");
          return;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Polling failed";
        setJobStatus("failed");
        setJobError(message);
        toast.error(message);
        return;
      }

      timeoutId = window.setTimeout(poll, 2000);
    };

    void poll();

    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [isGenerating, jobId]);

  return (
    <div className="min-h-screen bg-black lg:pl-[200px]">
      {/* Mobile header */}
      <div className="lg:hidden fixed top-0 left-0 right-0 z-50 bg-sidebar-bg border-b border-sidebar-border px-4 py-3 flex items-center gap-3">
        <button onClick={() => setSidebarOpen(!sidebarOpen)} className="text-foreground">
          {sidebarOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-foreground flex items-center justify-center">
            <span className="text-background font-bold text-[10px]">ET</span>
          </div>
          <span className="text-foreground font-semibold text-sm">ET NewsStudio</span>
        </div>
      </div>

      {/* Overlay */}
      {sidebarOpen && (
        <div className="lg:hidden fixed inset-0 bg-black/50 z-40" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Sidebar */}
      <div className={`fixed top-0 bottom-0 left-0 z-50 transition-transform duration-300 lg:translate-x-0 ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}`}>
        <Sidebar />
      </div>

      <main className="w-full px-4 sm:px-6 lg:px-8 py-6 lg:py-8 pt-16 lg:pt-8">
        <section className="min-h-[calc(100vh-110px)] flex flex-col items-center justify-center">
          {/* Hero heading */}
          <div className="flex w-full max-w-[792px] min-h-[116px] flex-col items-center justify-center gap-2 py-6 text-center transition-all duration-300 mx-auto" style={{ opacity: 0, animation: "fade-in-up 0.6s cubic-bezier(0.16, 1, 0.3, 1) 100ms forwards" }}>
            <div className="flex w-full flex-wrap items-center justify-center gap-2">
              <h1 className="text-primary text-center text-[32px] font-semibold leading-[36px] tracking-tight sm:text-[40px] sm:leading-[44px]">
                News to video
              </h1>
            </div>
            <p className="text-white text-base font-normal leading-6 text-center w-full opacity-80">
              Add an url of news or article and choose your preferred style.
            </p>
          </div>

          {/* Style picker */}
          <div className="flex justify-center mb-5 lg:mb-6" style={{ opacity: 0, animation: "fade-in-up 0.6s cubic-bezier(0.16, 1, 0.3, 1) 200ms forwards" }}>
            <StylePicker onStyleSelect={setSelectedStyle} />
          </div>

          {/* Prompt input */}
          <div className="w-full max-w-[980px] mx-auto" style={{ opacity: 0, animation: "fade-in-up 0.6s cubic-bezier(0.16, 1, 0.3, 1) 300ms forwards" }}>
            <PromptInput selectedStyle={selectedStyle?.src ?? null} onGenerate={handleGenerate} isSubmitting={isSubmitting || isGenerating} />
          </div>
        </section>
      </main>

      {/* Video Generation Progress Overlay */}
      {isGenerating && (
        <VideoGenerationProgress
          selectedStyle={selectedStyle?.src ?? null}
          notifications={notifications}
          status={jobStatus}
          resultUrl={resultUrl}
          error={jobError}
          onComplete={handleGenerationComplete}
        />
      )}
    </div>
  );
};

export default Index;
