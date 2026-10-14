'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, Film, Loader2, Play, RefreshCw, Sparkles, X } from 'lucide-react';
import { CLOUD_LESSON_ACTIVE_STATUSES, CLOUD_LESSON_LANGUAGES, CLOUD_LESSON_STYLE_COPY, CLOUD_LESSON_VISUAL_STYLES, CreateCloudLessonSchema,
  CloudLessonProjectSchema, cloudLessonAnimationCap, cloudLessonPictureCount, cloudLessonStorybookEstimateUsd,
  type CloudLessonProject, type CreateCloudLessonInput } from '@/lib/videos/cloud-lesson-contracts';
import type { CloudLessonDetail } from '@/lib/data/cloud-lessons';

const field = 'mt-2 w-full rounded-xl border border-black/10 bg-white px-3 py-2.5 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15 dark:border-white/15 dark:bg-neutral-900';
const button = 'inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50';
const active = (p: CloudLessonProject) => CLOUD_LESSON_ACTIVE_STATUSES.includes(p.status);
const labels: Record<string, string> = { preparing: 'Preparing lesson', generating_images: 'Creating images',
  generating_videos: 'Creating scenes', assembling: 'Assembling video', succeeded: 'Ready to watch', failed: 'Generation failed', cancelled: 'Cancelled' };

async function api(url: string, init?: RequestInit) {
  const response = await fetch(url, { ...init, cache: 'no-store' });
  let data;
  try { data = await response.json(); } catch { throw new Error(response.status === 401 ? 'Your session ended. Sign in again.' : 'The lesson service returned an unexpected response.'); }
  if (!response.ok) throw new Error(data.error || 'The request could not finish.');
  return data;
}

export function CloudLessonStudio({ initialProjects, initialId, setupError, animationAllowance }: {
  initialProjects: CloudLessonProject[]; initialId?: string; setupError?: string; animationAllowance: number;
}) {
  const [projects, setProjects] = useState(initialProjects);
  const [selected, setSelected] = useState(initialId ?? initialProjects[0]?.id ?? '');
  const [detail, setDetail] = useState<CloudLessonDetail | null>(null);
  const [error, setError] = useState(setupError ?? '');
  const [pollError, setPollError] = useState('');
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [offer, setOffer] = useState<{ exact: CloudLessonProject | null; reusable: CloudLessonProject | null; input: CreateCloudLessonInput } | null>(null);
  const [input, setInput] = useState<CreateCloudLessonInput>({ classLevel: 6, subject: 'Science', languageCode: 'en-IN', topic: '', durationSeconds: 60, visualStyle: 'illustrated' });
  const submitting = useRef(false);
  const style = input.visualStyle ?? 'illustrated'; const seconds = input.durationSeconds ?? 60;
  const storybook = style === 'storybook';
  const animated = cloudLessonAnimationCap(style, seconds);
  // animationAllowance is six five-second clips; one clip is a sixth of it.
  const storybookEstimate = cloudLessonStorybookEstimateUsd(seconds, animationAllowance / 30);

  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const list = await api('/api/cloud-lessons', { signal: controller.signal });
        const rows = CloudLessonProjectSchema.array().parse(list.projects);
        if (controller.signal.aborted) return;
        setProjects(rows);
        if (selected) {
          const current: CloudLessonDetail = await api(`/api/cloud-lessons/${selected}`, { signal: controller.signal });
          if (controller.signal.aborted) return;
          setDetail(current);
        }
        setPollError('');
      } catch (err) { if (!controller.signal.aborted) setPollError(err instanceof Error ? err.message : 'Could not refresh lesson progress.'); }
      if (!controller.signal.aborted) timer = setTimeout(tick, 5000);
    };
    timer = setTimeout(tick, 0);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [selected]);

  const choose = (id: string) => {
    setSelected(id); setDetail(null); setOffer(null);
    window.history.replaceState(null, '', `/app/cloud-lessons?lesson=${encodeURIComponent(id)}`);
  };
  const generate = async (request: CreateCloudLessonInput) => {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError('');
    try {
      const result = await api('/api/cloud-lessons', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
      const project = CloudLessonProjectSchema.parse(result.project);
      setProjects(previous => [project, ...previous.filter(p => p.id !== project.id)]);
      choose(project.id);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not start the lesson.'); }
    finally { submitting.current = false; setBusy(false); }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (submitting.current) return;
    const parsed = CreateCloudLessonSchema.safeParse(input);
    if (!parsed.success) { setError('Choose a class and subject, then enter a topic of 3 to 300 characters.'); return; }
    submitting.current = true; setBusy(true); setError(''); setOffer(null);
    try {
      const query = new URLSearchParams({ classLevel: String(parsed.data.classLevel), subject: parsed.data.subject, topic: parsed.data.topic, languageCode: parsed.data.languageCode, durationSeconds: String(parsed.data.durationSeconds), visualStyle: parsed.data.visualStyle });
      const cached = await api(`/api/cloud-lessons/cache?${query}`);
      if (cached.exact || cached.reusable) {
        setOffer({ exact: cached.exact ? CloudLessonProjectSchema.parse(cached.exact) : null,
          reusable: cached.reusable ? CloudLessonProjectSchema.parse(cached.reusable) : null, input: parsed.data });
      } else {
        submitting.current = false;
        await generate(parsed.data);
      }
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not check existing lessons.'); }
    finally { submitting.current = false; setBusy(false); }
  };
  const cancel = async () => {
    if (!selected || cancelling) return;
    setCancelling(true); setError('');
    try { await api(`/api/cloud-lessons/${selected}`, { method: 'DELETE' });
      const updated: CloudLessonDetail = await api(`/api/cloud-lessons/${selected}`); setDetail(updated);
      setProjects(previous => previous.map(p => p.id === selected ? updated.project : p));
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not cancel the lesson.'); }
    finally { setCancelling(false); }
  };
  const current = detail?.project.id === selected ? detail : null;
  const project = current?.project ?? projects.find(p => p.id === selected);

  return <div className="mt-7 grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
    <div className="space-y-5">
      <form onSubmit={submit} className="rounded-2xl border border-black/8 bg-neutral-50/70 p-5 dark:border-white/10 dark:bg-neutral-900/50">
        <h2 className="flex items-center gap-2 font-semibold"><Sparkles className="h-4 w-4 text-indigo-500" />Create a lesson</h2>
        <p className="mt-1 text-sm text-neutral-500">One topic, clearly explained in your chosen style.</p>
        <div className="mt-5 grid grid-cols-2 gap-3">
          <label className="text-sm font-medium">Class<select className={field} value={input.classLevel} onChange={e => { setOffer(null); setInput({ ...input, classLevel: Number(e.target.value) }); }}>
            {Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={i + 1}>Class {i + 1}</option>)}
          </select></label>
          <label className="text-sm font-medium">Language<select className={field} value={input.languageCode} onChange={e => { setOffer(null); setInput({ ...input, languageCode: e.target.value as CreateCloudLessonInput['languageCode'] }); }}>
            {CLOUD_LESSON_LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select></label>
        </div>
        <label className="mt-4 block text-sm font-medium">Subject<input required minLength={2} maxLength={100} className={field} value={input.subject} placeholder="Science, Mathematics, History…" onChange={e => { setOffer(null); setInput({ ...input, subject: e.target.value }); }} /></label>
        <label className="mt-4 block text-sm font-medium">Topic<textarea required minLength={3} maxLength={300} rows={3} className={`${field} resize-y`} value={input.topic} placeholder="How does the water cycle work?" onChange={e => { setOffer(null); setInput({ ...input, topic: e.target.value }); }} /></label>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <label className="text-sm font-medium">Duration<select className={field} value={input.durationSeconds} onChange={e => { setOffer(null); setInput({ ...input, durationSeconds: Number(e.target.value) as 30 | 60 }); }}>
            <option value={30}>30 seconds · 4 scenes</option><option value={60}>60 seconds · 8 scenes</option>
          </select></label>
          <label className="text-sm font-medium">Visual style<select className={field} value={input.visualStyle} onChange={e => { setOffer(null); setInput({ ...input, visualStyle: e.target.value as CreateCloudLessonInput['visualStyle'] }); }}>
            {CLOUD_LESSON_VISUAL_STYLES.map(s => <option key={s} value={s}>{CLOUD_LESSON_STYLE_COPY[s].label}</option>)}
          </select></label>
        </div>
        <p className="mt-3 text-xs text-neutral-500">{CLOUD_LESSON_STYLE_COPY[style].description}</p>
        <div className="mt-4 flex flex-wrap gap-2 text-xs text-neutral-500"><span className="rounded-md bg-black/5 px-2 py-1 dark:bg-white/10">{seconds} seconds</span><span className="rounded-md bg-black/5 px-2 py-1 dark:bg-white/10">1080p</span><span className="rounded-md bg-black/5 px-2 py-1 dark:bg-white/10">Narrated</span>{storybook && <span className="rounded-md bg-black/5 px-2 py-1 dark:bg-white/10">{cloudLessonPictureCount(style, seconds)} pictures</span>}</div>
        {storybook
          ? <p className="mt-4 text-xs leading-relaxed text-neutral-500">About ${storybookEstimate.toFixed(2)} for this lesson: {cloudLessonPictureCount(style, seconds)} engraved pictures, {animated} animated scene{animated === 1 ? '' : 's'}, the script and a storyteller voice. Retries and provider prices can raise it. Usually ready in {seconds === 30 ? '6 to 10' : '10 to 18'} minutes. Existing matching lessons have no new generation charge.</p>
          : <p className="mt-4 text-xs leading-relaxed text-neutral-500">Animation allowance: up to ${(animationAllowance * animated / 6).toFixed(2)}, plus script, images and speech. Provider prices and retries affect the total. Existing matching lessons have no new generation charge.</p>}
        <button disabled={busy} className={`${button} mt-5 w-full`} type="submit">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Film className="h-4 w-4" />}Check and generate</button>
        <p className="mt-3 text-xs text-neutral-500">Up to 2 lessons at once · 10 new lessons per 24 hours</p>
      </form>
      {offer && <div className="rounded-2xl border border-indigo-500/25 bg-indigo-500/5 p-5" role="status">
        <h3 className="font-medium">{offer.exact ? 'This lesson already exists' : 'Reuse visuals from your existing lesson'}</h3>
        <p className="mt-1 text-sm font-medium">{offer.exact?.title ?? offer.reusable?.title ?? offer.input.topic}</p>
        <p className="mt-2 text-sm text-neutral-500">{offer.exact ? 'Watch the completed lesson with no new generation charge.' : 'Create narration and captions in the selected language. The images and animations will be reused, saving their generation cost.'}</p>
        <button type="button" className={`${button} mt-4`} disabled={busy} onClick={() => offer.exact ? choose(offer.exact.id) : void generate(offer.input)}>{offer.exact ? 'Use existing lesson' : 'Generate language version'}</button>
      </div>}
      {error && <p role="alert" className="rounded-xl bg-red-500/10 p-4 text-sm text-red-600 dark:text-red-400">{error}</p>}
      <section aria-label="Your lessons" className="rounded-2xl border border-black/8 p-4 dark:border-white/10">
        <h2 className="mb-3 text-sm font-semibold">Your lessons</h2>
        {!projects.length && <p className="text-sm text-neutral-500">Your first lesson will appear here.</p>}
        <div className="max-h-[400px] space-y-1 overflow-y-auto">{projects.map(p => <button type="button" key={p.id} onClick={() => choose(p.id)} aria-pressed={selected === p.id} className={`w-full rounded-xl p-3 text-left transition ${selected === p.id ? 'bg-indigo-500/10' : 'hover:bg-black/5 dark:hover:bg-white/5'}`}>
          <p className="truncate text-sm font-medium">{p.title ?? p.topic}</p><p className="mt-1 text-xs text-neutral-500">Class {p.class_level} · {CLOUD_LESSON_LANGUAGES.find(l => l.code === p.language_code)?.label}{p.visual_style === 'storybook' ? ' · Storybook' : ''} · {labels[p.status]}</p>
        </button>)}</div>
      </section>
    </div>
    <section className="min-w-0 rounded-2xl border border-black/8 p-5 sm:p-7 dark:border-white/10" aria-label="Lesson preview">
      {pollError && <p role="alert" className="mb-4 rounded-xl bg-amber-500/10 p-3 text-sm">{pollError} Progress will retry automatically.</p>}
      {!project ? <div className="flex min-h-[440px] flex-col items-center justify-center text-center">
        <div className="flex h-20 w-20 items-center justify-center rounded-3xl bg-indigo-500/10"><Play className="h-8 w-8 text-indigo-500" /></div>
        <h2 className="mt-5 text-xl font-semibold">A small lesson. A clearer idea.</h2><p className="mt-2 max-w-sm text-sm leading-relaxed text-neutral-500">Choose a class, subject and topic to create a narrated lesson with images, motion and clear captions.</p>
      </div> : <>
        <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-medium uppercase tracking-wider text-indigo-500">{project.subject} · Class {project.class_level}</p><p className="mt-1 text-xs text-neutral-500">{project.target_duration_seconds} seconds · {CLOUD_LESSON_STYLE_COPY[project.visual_style ?? 'illustrated'].label}</p><h2 className="mt-2 text-xl font-semibold">{project.title ?? project.topic}</h2><p className="mt-2 text-sm text-neutral-500">{project.learning_objective ?? labels[project.status]}</p></div>
          {active(project) && <button type="button" disabled={cancelling} onClick={() => void cancel()} className="inline-flex items-center gap-1 rounded-lg border border-black/10 px-3 py-2 text-sm dark:border-white/15"><X className="h-4 w-4" />{cancelling ? 'Cancelling…' : 'Cancel'}</button>}
        </div>
        {project.status === 'succeeded' && project.final_video_url ? <div className="mt-6"><video key={project.final_video_url} src={project.final_video_url} controls playsInline preload="metadata" className="aspect-video w-full rounded-xl bg-black" aria-label={project.title ?? project.topic} />
          <a href={project.final_video_url} target="_blank" rel="noopener noreferrer" className={`${button} mt-4`}>Open / download video</a></div> : <div className="mt-6 flex aspect-video flex-col items-center justify-center rounded-xl bg-neutral-100 dark:bg-neutral-900">
          {active(project) ? <Loader2 className="h-9 w-9 animate-spin text-indigo-500" /> : <Film className="h-9 w-9 text-neutral-400" />}<p className="mt-4 text-sm font-medium">{labels[project.status]}</p>
          {current?.waitingForWorker && <p className="mt-2 max-w-xs px-4 text-center text-xs text-neutral-500">Waiting for the next generation step. Progress updates automatically.</p>}
          {project.visual_style === 'storybook' && project.status === 'generating_images' && !project.reused_from_project_id && current
            && !current.jobs.some(j => j.kind === 'image' && j.status === 'succeeded')
            && <p className="mt-2 max-w-xs px-4 text-center text-xs text-neutral-500">The first picture sets the look. The others are drawn to match it once it is ready.</p>}
        </div>}
        {project.error_message && <p role="alert" className="mt-4 rounded-xl bg-red-500/10 p-4 text-sm text-red-600 dark:text-red-400">{project.error_message}</p>}
        {active(project) && current && <div className="mt-6" aria-live="polite"><div className="mb-2 flex justify-between text-sm"><span>{labels[project.status]}</span><span>{current.progress}%</span></div><progress value={current.progress} max={100} aria-label="Lesson generation progress" className="h-2 w-full accent-indigo-600" /></div>}
        {current && <div className="mt-5 grid gap-2 sm:grid-cols-2">{current.stages.map(stage => <div key={stage.key} className="flex items-center gap-2 rounded-xl bg-black/3 p-3 text-sm dark:bg-white/5">{stage.completed ? <Check className="h-4 w-4 text-emerald-500" /> : <RefreshCw className="h-4 w-4 text-neutral-400" />}<span>{stage.label}</span><span className="ml-auto text-xs text-neutral-500">{stage.count}/{stage.total}</span></div>)}</div>}
        <p className="mt-5 text-xs text-neutral-500">Recorded cost {active(project) ? 'so far' : ''}: ${project.cost_usd.toFixed(4)} · Animation charges are estimates; provider invoices are authoritative.{project.reused_from_project_id ? ' Visuals reused from your existing lesson.' : ''}</p>
        {current && current.scenes.length > 0 && <details className="mt-6"><summary className="cursor-pointer text-sm font-medium">{project.target_duration_seconds / 7.5}-scene lesson outline</summary><ol className="mt-3 space-y-3">{current.scenes.map(scene => <li key={scene.id} className="rounded-xl bg-black/3 p-3 text-sm dark:bg-white/5"><p className="font-medium">{scene.scene_index}. {scene.title ? `${scene.title} · ` : ''}{scene.caption}</p><p className="mt-1 text-neutral-500">{scene.narration}</p></li>)}</ol></details>}
      </>}
    </section>
  </div>;
}
