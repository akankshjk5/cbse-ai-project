'use client';

import {
  CheckCircle2,
  Clapperboard,
  CircleX,
  Clock3,
  Download,
  ImageIcon,
  Languages,
  LoaderCircle,
  Mic2,
  Play,
  Square,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import { VIDEO_SUBJECTS } from '@/lib/videos/contracts';
import {
  LESSON_VIDEO_DURATIONS,
  type LessonVideoDetail,
  type LessonVideoDuration,
  type LessonVideoProject,
  type LessonVideoScene,
} from '@/lib/videos/lesson-contracts';
import { VIDEO_LANGUAGES, type VideoLanguageCode } from '@/lib/videos/languages';

const fieldClasses =
  'w-full rounded-lg border border-black/10 bg-white px-3 py-2.5 text-sm outline-none transition-colors focus:border-indigo-500 dark:border-white/10 dark:bg-neutral-900';

function isRunning(project: LessonVideoProject | null): boolean {
  return Boolean(project && [
    'preparing',
    'generating_images',
    'generating_videos',
    'assembling',
  ].includes(project.status));
}

export function LessonVideoStudio({ initialProjects }: { initialProjects: LessonVideoProject[] }) {
  const [projects, setProjects] = useState(initialProjects);
  const [selected, setSelected] = useState<LessonVideoProject | null>(initialProjects[0] ?? null);
  const [scenes, setScenes] = useState<LessonVideoScene[]>([]);
  const [progress, setProgress] = useState(initialProjects[0]?.status === 'succeeded' ? 100 : 0);
  const [etaSeconds, setEtaSeconds] = useState<number | null>(null);
  const [sceneProgress, setSceneProgress] = useState<Record<string, number>>({});
  const [completedClips, setCompletedClips] = useState(0);
  const [totalClips, setTotalClips] = useState(0);
  const [activeSceneIndex, setActiveSceneIndex] = useState<number | null>(null);
  const [waitingForWorker, setWaitingForWorker] = useState(false);
  const [classLevel, setClassLevel] = useState(8);
  const [subject, setSubject] = useState('');
  const [topic, setTopic] = useState('');
  const [languageCode, setLanguageCode] = useState<VideoLanguageCode>('en-IN');
  const [targetDurationSeconds, setTargetDurationSeconds] = useState<LessonVideoDuration>(60);
  const [submitting, setSubmitting] = useState(false);
  const [setupElapsedSeconds, setSetupElapsedSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const selectedId = selected?.id ?? null;
  const running = isRunning(selected);

  useEffect(() => {
    if (selected?.status !== 'preparing') return;
    const startedAt = Date.parse(selected.created_at);
    const tick = () => setSetupElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [selected?.id, selected?.status, selected?.created_at]);

  useEffect(() => {
    if (!selectedId) return;
    let stopped = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const response = await fetch(`/api/lesson-videos/${selectedId}`, { cache: 'no-store' });
        const body = await response.json() as LessonVideoDetail & { error?: string };
        if (!response.ok) throw new Error(body.error ?? 'Could not refresh video status.');
        if (stopped) return;
        setSelected(body.project);
        setScenes(body.scenes);
        setProgress(body.progress);
        setEtaSeconds(body.etaSeconds);
        setSceneProgress(body.sceneProgress);
        setCompletedClips(body.completedClips);
        setTotalClips(body.totalClips);
        setActiveSceneIndex(body.activeSceneIndex);
        setWaitingForWorker(body.waitingForWorker);
        setPollError(null);
        setProjects((current) => [
          body.project,
          ...current.filter((project) => project.id !== body.project.id),
        ]);
        if (isRunning(body.project)) timer = window.setTimeout(() => void poll(), 2000);
      } catch (caught) {
        if (!stopped) {
          setPollError(caught instanceof Error ? caught.message : 'Could not refresh video status.');
          if (running) timer = window.setTimeout(() => void poll(), 5000);
        }
      }
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [selectedId, running]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSetupElapsedSeconds(0);
    setSubmitting(true);
    setError(null);
    setPollError(null);
    try {
      const response = await fetch('/api/lesson-videos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ classLevel, subject, topic, languageCode, targetDurationSeconds }),
      });
      const body = await response.json() as { project?: LessonVideoProject; error?: string };
      if (!response.ok || !body.project) throw new Error(body.error ?? 'Could not start video.');
      setSelected(body.project);
      setScenes([]);
      setProgress(0);
      setEtaSeconds(null);
      setSceneProgress({});
      setCompletedClips(0);
      setTotalClips(0);
      setActiveSceneIndex(null);
      setWaitingForWorker(false);
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
      const response = await fetch(`/api/lesson-videos/${selected.id}`, { method: 'DELETE' });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Could not cancel video.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not cancel video.');
    }
  }

  function selectProject(project: LessonVideoProject) {
    setSelected(project);
    setScenes([]);
    setProgress(project.status === 'succeeded' ? 100 : 0);
    setEtaSeconds(null);
    setSceneProgress({});
    setCompletedClips(0);
    setTotalClips(0);
    setActiveSceneIndex(null);
    setWaitingForWorker(false);
    setError(null);
    setPollError(null);
  }

  return (
    <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(340px,430px)_minmax(0,1fr)]">
      <div className="space-y-5">
        <form onSubmit={submit} className="rounded-2xl border border-black/10 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-neutral-900">
          <div className="flex items-center gap-2"><Clapperboard className="h-5 w-5 text-indigo-600 dark:text-indigo-400" /><h2 className="font-semibold">Create a narrated lesson</h2></div>
          <p className="mt-1 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">Lumina plans the lesson, checks the facts, creates topic-specific scenes locally, adds voice-over in your selected language, and assembles one learning video.</p>

          <div className="mt-5 grid grid-cols-2 gap-3">
            <label className="text-sm font-medium">Class<select value={classLevel} onChange={(event) => setClassLevel(Number(event.target.value))} className={`${fieldClasses} mt-1.5`}>{Array.from({ length: 12 }, (_, index) => index + 1).map((grade) => <option key={grade} value={grade}>Class {grade}</option>)}</select></label>
            <label className="text-sm font-medium">Subject<select required value={subject} onChange={(event) => setSubject(event.target.value)} className={`${fieldClasses} mt-1.5`}><option value="" disabled>Select subject</option>{VIDEO_SUBJECTS.map((item) => <option key={item}>{item}</option>)}</select></label>
          </div>
          <label className="mt-3 block text-sm font-medium">Topic<input required minLength={3} maxLength={300} value={topic} onChange={(event) => setTopic(event.target.value)} placeholder="e.g. How Python loops work" className={`${fieldClasses} mt-1.5`} /></label>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <label className="text-sm font-medium">Voice-over language<select value={languageCode} onChange={(event) => setLanguageCode(event.target.value as VideoLanguageCode)} className={`${fieldClasses} mt-1.5`}>{VIDEO_LANGUAGES.map((language) => <option key={language.code} value={language.code}>{language.label}</option>)}</select></label>
            <label className="text-sm font-medium">Video length<select value={targetDurationSeconds} onChange={(event) => setTargetDurationSeconds(Number(event.target.value) as LessonVideoDuration)} className={`${fieldClasses} mt-1.5`}>{LESSON_VIDEO_DURATIONS.map((duration) => <option key={duration} value={duration}>{duration} seconds</option>)}</select></label>
          </div>
          <button type="submit" disabled={submitting} className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">{submitting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4 fill-current" />}{submitting ? 'Saving request…' : 'Generate narrated video'}</button>
          {selected?.status === 'preparing' ? <PreparationProgress elapsedSeconds={setupElapsedSeconds} /> : null}
          {!submitting && (!subject || topic.trim().length < 3) ? <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">Choose a subject and enter a topic of at least 3 characters.</p> : null}
          {error ? <p className="mt-3 text-xs text-red-600 dark:text-red-400">{error}</p> : null}
          {pollError ? <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">{pollError} Retrying automatically.</p> : null}
        </form>

        {projects.length > 0 ? <section><h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Recent videos</h2><div className="space-y-2">{projects.map((project) => <button key={project.id} type="button" onClick={() => selectProject(project)} className={`w-full rounded-xl border p-3 text-left transition-colors ${selected?.id === project.id ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-500/10' : 'border-black/10 hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5'}`}><span className="block truncate text-sm font-medium">{project.title}</span><span className="mt-0.5 block text-xs text-neutral-500">Class {project.class_level} · {project.subject} · {project.target_duration_seconds}s · {project.language_name} · {statusLabel(project.status)}</span></button>)}</div></section> : null}
      </div>

      <ResultPanel
        project={selected}
        scenes={scenes}
        progress={progress}
        etaSeconds={etaSeconds}
        sceneProgress={sceneProgress}
        completedClips={completedClips}
        totalClips={totalClips}
        activeSceneIndex={activeSceneIndex}
        waitingForWorker={waitingForWorker}
        onCancel={() => void cancel()}
      />
    </div>
  );
}

function PreparationProgress({ elapsedSeconds }: { elapsedSeconds: number }) {
  return (
    <div className="mt-3 rounded-lg bg-indigo-50 p-3 text-xs text-indigo-900 dark:bg-indigo-500/10 dark:text-indigo-200">
      <div className="flex items-center justify-between gap-3">
        <span>Planning, fact review, translation and voice-over fitting</span>
        <span className="shrink-0 font-semibold">Preparing lesson</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-indigo-950/10 dark:bg-white/10"><div className="h-full w-1/3 animate-pulse rounded-full bg-indigo-500" /></div>
      <p className="mt-2 text-indigo-700 dark:text-indigo-300">Elapsed {formatElapsed(elapsedSeconds)} · you can switch to Presentation; this saved request keeps running. Animation progress appears after the lesson and narration are ready.</p>
    </div>
  );
}

interface ResultPanelProps {
  project: LessonVideoProject | null;
  scenes: LessonVideoScene[];
  progress: number;
  etaSeconds: number | null;
  sceneProgress: Record<string, number>;
  completedClips: number;
  totalClips: number;
  activeSceneIndex: number | null;
  waitingForWorker: boolean;
  onCancel: () => void;
}

function ResultPanel({
  project,
  scenes,
  progress,
  etaSeconds,
  sceneProgress,
  completedClips,
  totalClips,
  activeSceneIndex,
  waitingForWorker,
  onCancel,
}: ResultPanelProps) {
  if (!project) return <div className="flex min-h-[480px] items-center justify-center rounded-2xl border border-dashed border-black/15 bg-black/[0.02] p-8 text-center dark:border-white/15 dark:bg-white/[0.02]"><div><Clapperboard className="mx-auto h-9 w-9 text-neutral-300" /><p className="mt-3 text-sm text-neutral-500">Your narrated lesson will appear here.</p></div></div>;

  const running = isRunning(project);
  const generatedImages = scenes.filter((scene) => scene.image_url);
  const playableScenes = scenes.filter((scene) => scene.video_url);
  const latestClip = playableScenes.at(-1);
  const displayProgress = project.status === 'succeeded'
    ? 100
    : project.status === 'preparing'
      ? 0
    : running
      ? Math.min(99, 15 + Math.round(progress * 0.85))
      : progress;
  return (
    <section className="overflow-hidden rounded-2xl border border-black/10 bg-neutral-950 text-white shadow-sm dark:border-white/10">
      <div className="flex min-h-[360px] items-center justify-center bg-black">
        {project.final_video_url ? <video src={project.final_video_url} controls playsInline preload="metadata" className="aspect-video max-h-[70vh] w-full object-contain" /> : latestClip?.video_url ? <div className="w-full"><video key={latestClip.video_url} src={latestClip.video_url} controls playsInline preload="metadata" className="aspect-video max-h-[70vh] w-full object-contain" /><p className="bg-neutral-950 px-4 py-2 text-center text-xs text-neutral-400">Scene {latestClip.scene_index} is ready to preview while the remaining scenes generate.</p></div> : generatedImages.length > 0 ? <div className="grid aspect-video w-full grid-cols-2 gap-1 overflow-hidden bg-neutral-900 p-1 sm:grid-cols-4">{generatedImages.slice(0, 12).map((scene) => <img key={scene.id} src={scene.image_url!} alt={`Scene ${scene.scene_index}`} className="h-full min-h-24 w-full object-cover" />)}</div> : project.status === 'cancelled' ? <TerminalState title="Generation cancelled" description="Queued work has been stopped." /> : project.status === 'failed' ? <TerminalState title="Generation failed" description={failureDescription(project.error_message)} /> : <div className="text-center"><LoaderCircle className="mx-auto h-9 w-9 animate-spin text-indigo-400" /><p className="mt-3 text-sm">{statusLabel(project.status)}…</p></div>}
      </div>
      <div className="p-5">
        {waitingForWorker ? <p className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">No worker currently handles this saved video. Progress and the ETA are paused until a worker is available.</p> : null}
        <div className="flex items-start justify-between gap-4"><div><h2 className="font-semibold">{project.title}</h2><p className="mt-1 text-xs text-neutral-400">Class {project.class_level} · {project.subject} · {project.target_duration_seconds} seconds · {project.language_name}</p>{project.learning_objective !== 'Preparing the lesson plan' ? <p className="mt-2 text-xs leading-relaxed text-neutral-300">{project.learning_objective}</p> : null}</div>{project.final_video_url ? <a href={project.final_video_url} download className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-white px-3 py-2 text-xs font-semibold text-neutral-950 hover:bg-neutral-200"><Download className="h-3.5 w-3.5" />Download</a> : null}</div>
        <div className="mt-4 grid grid-cols-3 gap-2 text-xs"><Stage done={['generating_videos', 'assembling', 'succeeded'].includes(project.status)} active={project.status === 'generating_images'} icon={ImageIcon} label="Create scenes" /><Stage done={['assembling', 'succeeded'].includes(project.status)} active={project.status === 'generating_videos'} icon={Clapperboard} label="Animate scenes" /><Stage done={project.status === 'succeeded'} active={project.status === 'assembling'} icon={Mic2} label="Voice + assemble" /></div>
        {running ? <div className="mt-4"><div className="flex flex-wrap items-center justify-between gap-3 text-xs"><span className="text-neutral-300">{statusLabel(project.status)}{project.status === 'preparing' ? '' : ` · ${displayProgress}%`}</span><span className="inline-flex items-center gap-1.5 text-neutral-400"><Clock3 className="h-3.5 w-3.5" />{formatEta(etaSeconds)}</span><button type="button" onClick={onCancel} className="inline-flex items-center gap-1.5 text-red-300 hover:text-red-200"><Square className="h-3 w-3 fill-current" />Cancel</button></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10"><div className={`h-full rounded-full bg-indigo-400 transition-all ${project.status === 'preparing' ? 'w-1/3 animate-pulse' : ''}`} style={project.status === 'preparing' ? undefined : { width: `${displayProgress}%` }} /></div><p className="mt-2 text-xs text-neutral-400">{project.status === 'preparing' ? 'Your saved request continues while you use Presentation.' : `${completedClips}/${totalClips || scenes.length} clips ready${activeSceneIndex ? ` · generating scene ${activeSceneIndex}` : ''}. ETA updates from measured job times.`}</p></div> : null}
        {project.status === 'succeeded' ? <p className="mt-4 inline-flex items-center gap-1.5 text-xs text-emerald-300"><CheckCircle2 className="h-4 w-4" />All scene clips and the final narrated video are ready.</p> : null}
        {scenes.length > 0 ? <div className="mt-5 border-t border-white/10 pt-4"><div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-neutral-400"><Languages className="h-3.5 w-3.5" />Lesson scenes</div><div className="mt-3 grid gap-3 sm:grid-cols-2">{scenes.map((scene) => {
          const percent = sceneProgress[scene.id] ?? (scene.status === 'succeeded' ? 100 : 0);
          return <div key={scene.id} className="overflow-hidden rounded-lg bg-white/5">{scene.video_url ? <video src={scene.video_url} controls playsInline preload="metadata" poster={scene.image_url ?? undefined} className="aspect-video w-full bg-black object-contain" /> : scene.image_url ? <img src={scene.image_url} alt={`Scene ${scene.scene_index}`} className="aspect-video w-full object-cover" /> : <div className="flex aspect-video items-center justify-center bg-black/30"><LoaderCircle className={`h-6 w-6 text-neutral-500 ${scene.status.startsWith('generating_') ? 'animate-spin' : ''}`} /></div>}<div className="p-3"><div className="flex items-center justify-between gap-2 text-xs"><span className="font-semibold">Scene {scene.scene_index}</span><span className={scene.video_url ? 'text-emerald-300' : 'text-neutral-400'}>{scene.video_url ? 'Clip ready — play now' : `${sceneStatus(scene.status)} · ${percent}%`}</span></div><div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10"><div className={`h-full rounded-full transition-all ${scene.video_url ? 'bg-emerald-400' : 'bg-indigo-400'}`} style={{ width: `${percent}%` }} /></div>{scene.caption ? <p className="mt-2 text-sm font-semibold text-white">{scene.caption}</p> : null}<p className="mt-2 text-xs leading-relaxed text-neutral-300">{scene.fact}</p></div></div>;
        })}</div></div> : null}
      </div>
    </section>
  );
}

function TerminalState({ title, description }: { title: string; description: string }) {
  return <div className="px-6 text-center"><CircleX className="mx-auto h-9 w-9 text-neutral-500" /><p className="mt-3 text-sm font-medium">{title}</p><p className="mt-1 text-xs text-neutral-500">{description}</p></div>;
}

function failureDescription(message: string | null): string {
  if (!message) return 'Start a new request when you are ready to try again.';
  if (message.includes('visualDescription must describe only physical objects')) {
    return 'The local planner could not create trustworthy text-free visuals for this topic. No clips were generated.';
  }
  if (message.startsWith('[\n  {') || message.startsWith('[{')) {
    return 'The lesson did not pass its accuracy checks. No clips were generated.';
  }
  return message;
}

function Stage({ done, active, icon: Icon, label }: { done: boolean; active: boolean; icon: typeof ImageIcon; label: string }) {
  return <div className={`flex items-center gap-2 rounded-lg px-3 py-2 ${done ? 'bg-emerald-500/15 text-emerald-300' : active ? 'bg-indigo-500/15 text-indigo-300' : 'bg-white/5 text-neutral-500'}`}>{done ? <CheckCircle2 className="h-4 w-4" /> : active ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}<span>{label}</span></div>;
}

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function formatEta(seconds: number | null): string {
  if (seconds === null) return 'Calculating ETA';
  if (seconds <= 5) return 'Finishing now';
  const minutes = Math.ceil(seconds / 60);
  return `About ${minutes} min remaining`;
}

function statusLabel(status: LessonVideoProject['status']): string {
  if (status === 'preparing') return 'Preparing lesson and voice-over';
  if (status === 'generating_images') return 'Creating topic visuals';
  if (status === 'generating_videos') return 'Animating lesson scenes';
  if (status === 'assembling') return 'Adding voice-over and assembling';
  if (status === 'succeeded') return 'Ready';
  if (status === 'cancelled') return 'Cancelled';
  return 'Failed';
}

function sceneStatus(status: LessonVideoScene['status']): string {
  if (status === 'queued_image') return 'Waiting for visual';
  if (status === 'generating_image') return 'Creating visual';
  if (status === 'queued_video') return 'Visual ready';
  if (status === 'generating_video') return 'Animating';
  if (status === 'succeeded') return 'Ready';
  if (status === 'cancelled') return 'Cancelled';
  return 'Failed';
}
