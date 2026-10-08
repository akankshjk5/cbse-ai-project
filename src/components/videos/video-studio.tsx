'use client';

import {
  CheckCircle2,
  Clapperboard,
  CircleX,
  Download,
  ImageIcon,
  LoaderCircle,
  Play,
  Square,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import type { MediaJob } from '@/lib/media/contracts';
import {
  VIDEO_DURATIONS,
  VIDEO_SUBJECTS,
  type VideoDuration,
  type VideoProject,
} from '@/lib/videos/contracts';

interface ProjectResponse {
  project: VideoProject;
  activeJob: MediaJob | null;
}

const fieldClasses =
  'w-full rounded-lg border border-black/10 bg-white px-3 py-2.5 text-sm outline-none transition-colors focus:border-indigo-500 dark:border-white/10 dark:bg-neutral-900';

export function VideoStudio({ initialProjects }: { initialProjects: VideoProject[] }) {
  const [projects, setProjects] = useState(initialProjects);
  const [selected, setSelected] = useState<VideoProject | null>(initialProjects[0] ?? null);
  const [activeJob, setActiveJob] = useState<MediaJob | null>(null);
  const [classLevel, setClassLevel] = useState(8);
  const [subject, setSubject] = useState('');
  const [topic, setTopic] = useState('');
  const [durationSeconds, setDurationSeconds] = useState<VideoDuration>(3);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const running = selected?.status === 'generating_image' ||
    selected?.status === 'generating_video';
  const selectedId = selected?.id ?? null;

  useEffect(() => {
    if (!selectedId || !running) return;
    let stopped = false;
    const poll = async () => {
      try {
        const response = await fetch(`/api/videos/${selectedId}`, { cache: 'no-store' });
        const body = await response.json() as ProjectResponse & { error?: string };
        if (!response.ok) throw new Error(body.error ?? 'Could not refresh video status.');
        if (stopped) return;
        setSelected(body.project);
        setActiveJob(body.activeJob);
        setProjects((current) => [
          body.project,
          ...current.filter((project) => project.id !== body.project.id),
        ]);
      } catch (caught) {
        if (!stopped) setError(caught instanceof Error ? caught.message : 'Could not refresh video status.');
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [running, selectedId]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch('/api/videos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          classLevel,
          subject,
          topic,
          durationSeconds,
        }),
      });
      const body = await response.json() as { project?: VideoProject; error?: string };
      if (!response.ok || !body.project) throw new Error(body.error ?? 'Could not start video.');
      setSelected(body.project);
      setActiveJob(null);
      setProjects((current) => [body.project!, ...current]);
      setTopic('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not start video.');
    } finally {
      setSubmitting(false);
    }
  }

  async function cancel() {
    if (!selected) return;
    try {
      const response = await fetch(`/api/videos/${selected.id}`, { method: 'DELETE' });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Could not cancel video.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not cancel video.');
    }
  }

  return (
    <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(320px,420px)_minmax(0,1fr)]">
      <div className="space-y-5">
        <form onSubmit={submit} className="rounded-2xl border border-black/10 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-neutral-900">
          <div className="flex items-center gap-2">
            <Clapperboard className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
            <h2 className="font-semibold">Create an educational video</h2>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
            Lumina creates the key visual first, then animates it into a short learning clip.
          </p>

          <div className="mt-5 grid grid-cols-2 gap-3">
            <label className="text-sm font-medium">
              Class
              <select value={classLevel} onChange={(event) => setClassLevel(Number(event.target.value))} className={`${fieldClasses} mt-1.5`}>
                {Array.from({ length: 12 }, (_, index) => index + 1).map((grade) => (
                  <option key={grade} value={grade}>Class {grade}</option>
                ))}
              </select>
            </label>
            <label className="text-sm font-medium">
              Subject
              <select required value={subject} onChange={(event) => setSubject(event.target.value)} className={`${fieldClasses} mt-1.5`}>
                <option value="" disabled>Select subject</option>
                {VIDEO_SUBJECTS.map((item) => <option key={item}>{item}</option>)}
              </select>
            </label>
          </div>
          <label className="mt-3 block text-sm font-medium">
            Topic
            <input
              required
              minLength={3}
              maxLength={300}
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              placeholder="e.g. How photosynthesis works"
              className={`${fieldClasses} mt-1.5`}
            />
          </label>
          <label className="mt-3 block text-sm font-medium">
            Video length
            <select
              value={durationSeconds}
              onChange={(event) => setDurationSeconds(Number(event.target.value) as VideoDuration)}
              className={`${fieldClasses} mt-1.5`}
            >
              {VIDEO_DURATIONS.map((duration) => (
                <option key={duration} value={duration}>
                  {duration} seconds ({duration === 3 ? 'faster' : 'more detail'})
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={submitting}
            className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {submitting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4 fill-current" />}
            {submitting ? 'Starting…' : 'Generate video'}
          </button>
          {!submitting && (!subject || topic.trim().length < 3) ? (
            <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
              Choose a subject and enter a topic of at least 3 characters.
            </p>
          ) : null}
          {error ? <p className="mt-3 text-xs text-red-600 dark:text-red-400">{error}</p> : null}
        </form>

        {projects.length > 0 ? (
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Recent videos</h2>
            <div className="space-y-2">
              {projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => { setSelected(project); setActiveJob(null); setError(null); }}
                  className={`w-full rounded-xl border p-3 text-left transition-colors ${
                    selected?.id === project.id
                      ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-500/10'
                      : 'border-black/10 hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5'
                  }`}
                >
                  <span className="block truncate text-sm font-medium">{project.topic}</span>
                  <span className="mt-0.5 block text-xs text-neutral-500">Class {project.class_level} · {project.subject} · {project.duration_seconds}s · {statusLabel(project.status)}</span>
                </button>
              ))}
            </div>
          </section>
        ) : null}
      </div>

      <ResultPanel project={selected} job={activeJob} onCancel={() => void cancel()} />
    </div>
  );
}

function ResultPanel({ project, job, onCancel }: { project: VideoProject | null; job: MediaJob | null; onCancel: () => void }) {
  if (!project) {
    return (
      <div className="flex min-h-[420px] items-center justify-center rounded-2xl border border-dashed border-black/15 bg-black/[0.02] p-8 text-center dark:border-white/15 dark:bg-white/[0.02]">
        <div><Clapperboard className="mx-auto h-9 w-9 text-neutral-300" /><p className="mt-3 text-sm text-neutral-500">Your generated video will appear here.</p></div>
      </div>
    );
  }

  const running = project.status === 'generating_image' ||
    project.status === 'generating_video';
  return (
    <section className="overflow-hidden rounded-2xl border border-black/10 bg-neutral-950 text-white shadow-sm dark:border-white/10">
      <div className="flex min-h-[360px] items-center justify-center bg-black">
        {project.video_url ? (
          <video src={project.video_url} poster={project.image_url ?? undefined} controls autoPlay loop playsInline className="aspect-video max-h-[70vh] w-full object-contain" />
        ) : project.image_url ? (
          // Generated CDN asset; dimensions are known by the worker, not Next.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={project.image_url} alt={project.topic} className="aspect-video w-full object-contain" />
        ) : project.status === 'cancelled' ? (
          <TerminalState
            icon={CircleX}
            title="Generation cancelled"
            description="This request will not continue processing."
          />
        ) : project.status === 'failed' ? (
          <TerminalState
            icon={CircleX}
            title="Generation failed"
            description="Start a new request when you are ready to try again."
          />
        ) : (
          <div className="text-center">
            <LoaderCircle className="mx-auto h-9 w-9 animate-spin text-indigo-400" />
            <p className="mt-3 text-sm">Creating the key visual…</p>
          </div>
        )}
      </div>
      <div className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div><h2 className="font-semibold">{project.topic}</h2><p className="mt-1 text-xs text-neutral-400">Class {project.class_level} · {project.subject} · {project.duration_seconds} seconds</p></div>
          {project.video_url ? (
            <a href={project.video_url} download className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-2 text-xs font-semibold text-neutral-950 hover:bg-neutral-200"><Download className="h-3.5 w-3.5" />Download</a>
          ) : null}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
          <Stage done={Boolean(project.image_url)} active={project.status === 'generating_image'} icon={ImageIcon} label="Create visual" />
          <Stage done={project.status === 'succeeded'} active={project.status === 'generating_video'} icon={Clapperboard} label="Animate video" />
        </div>
        {running ? (
          <div className="mt-4 flex items-center justify-between gap-3">
            <span className="text-xs text-neutral-400">{statusLabel(project.status)}{job ? ` · ${job.progress}%` : ''}</span>
            <button type="button" onClick={onCancel} className="inline-flex items-center gap-1.5 text-xs text-red-300 hover:text-red-200"><Square className="h-3 w-3 fill-current" />Cancel</button>
          </div>
        ) : null}
        {project.error_message ? <p className="mt-4 text-xs text-red-300">{project.error_message}</p> : null}
      </div>
    </section>
  );
}

function TerminalState({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof CircleX;
  title: string;
  description: string;
}) {
  return (
    <div className="px-6 text-center">
      <Icon className="mx-auto h-9 w-9 text-neutral-500" />
      <p className="mt-3 text-sm font-medium">{title}</p>
      <p className="mt-1 text-xs text-neutral-500">{description}</p>
    </div>
  );
}

function Stage({ done, active, icon: Icon, label }: { done: boolean; active: boolean; icon: typeof ImageIcon; label: string }) {
  return <div className={`flex items-center gap-2 rounded-lg px-3 py-2 ${done ? 'bg-emerald-500/15 text-emerald-300' : active ? 'bg-indigo-500/15 text-indigo-300' : 'bg-white/5 text-neutral-500'}`}>{done ? <CheckCircle2 className="h-4 w-4" /> : active ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}<span>{label}</span></div>;
}

function statusLabel(status: VideoProject['status']): string {
  if (status === 'generating_image') return 'Creating visual';
  if (status === 'generating_video') return 'Animating video';
  if (status === 'succeeded') return 'Ready';
  if (status === 'cancelled') return 'Cancelled';
  return 'Failed';
}
