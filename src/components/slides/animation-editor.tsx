'use client';

import { Play, RotateCcw, Save, Sparkles } from 'lucide-react';

import {
  DEFAULT_MOTION,
  MOTION_EASINGS,
  MOTION_ORIGINS,
  describeMotion,
  motionSchema,
  type Motion,
  type MotionEasing,
  type MotionOrigin,
} from '@agents/motion';

import type { SlideBlock } from '@/lib/slides/blocks';

/**
 * The animation panel.
 *
 * Everything the pipeline decided about a slide's motion is editable here, in
 * the same vocabulary the pipeline used — effect, intensity, timing, trigger.
 * The panel does not invent a second model of animation for people: it reads
 * and writes the exact `Motion` that is stored on the element and drawn by
 * `SlideCanvas`, so what the sliders say and what the slide does cannot come
 * apart.
 *
 * Deliberately not a timeline. A timeline asks a person to think in absolute
 * seconds across a dozen elements, which is precisely the arithmetic the
 * pipeline does for them (`ensureSlideMotion` computes the cascade); this asks
 * per element, "how does this one arrive?", and leaves the ordering alone
 * unless someone deliberately changes a delay.
 */

export interface AnimationEditorProps {
  blocks: SlideBlock[];
  selected: number | null;
  onSelect: (elementId: number) => void;
  onChange: (elementId: number, motion: Motion) => void;
  /** Give every element on the slide this motion, keeping each one's own delay. */
  onApplyAll: (motion: Motion) => void;
  onReplay: () => void;
  onReset: () => void;
  onSave: () => void;
  saving: boolean;
  dirty: boolean;
  error: string | null;
}

/** What to call an element in the list. Its words if it has any, else its role. */
function labelFor(block: SlideBlock): string {
  const words = block.text?.trim() || block.items?.[0]?.trim();
  if (words) return words.length > 38 ? `${words.slice(0, 37)}…` : words;

  if (block.type === 'image') return block.imagePrompt ? 'Illustration' : 'Picture';
  return block.role === 'body' ? block.type : block.role;
}

/** The motion an element has, or the "does nothing" one, so a control is never uncontrolled. */
function motionOf(block: SlideBlock | undefined): Motion {
  return block?.motion ?? { ...DEFAULT_MOTION, effect: 'none' };
}

export function AnimationEditor({
  blocks,
  selected,
  onSelect,
  onChange,
  onApplyAll,
  onReplay,
  onReset,
  onSave,
  saving,
  dirty,
  error,
}: AnimationEditorProps) {
  const block = selected === null ? undefined : blocks[selected];
  const motion = motionOf(block);

  /** Edit one field of the selected element's motion. Re-parsed so it stays valid by construction. */
  const set = (patch: Partial<Motion>) => {
    if (selected === null) return;
    onChange(selected, motionSchema.parse({ ...motion, ...patch }));
  };

  const animated = motion.effect !== 'none';

  return (
    <aside className="w-[280px] shrink-0 space-y-4 rounded-xl border border-black/10 p-3 dark:border-white/10">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-indigo-500" strokeWidth={2} />
        <h2 className="text-sm font-semibold">Animation</h2>
        <button
          type="button"
          onClick={onReplay}
          title="Replay this slide"
          className="ml-auto rounded-lg border border-black/10 p-1.5 transition-colors hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/10"
        >
          <Play className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </div>

      {/* Elements */}
      <div className="space-y-1">
        <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          Element
        </p>
        <ol className="max-h-44 space-y-0.5 overflow-y-auto">
          {blocks.map((entry, elementId) => {
            const entryMotion = motionOf(entry);
            return (
              <li key={elementId}>
                <button
                  type="button"
                  onClick={() => onSelect(elementId)}
                  className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                    elementId === selected
                      ? 'bg-indigo-50 text-indigo-900 dark:bg-indigo-500/15 dark:text-indigo-100'
                      : 'hover:bg-black/5 dark:hover:bg-white/5'
                  }`}
                >
                  <span className="truncate">{labelFor(entry)}</span>
                  <span className="ml-auto shrink-0 text-[10px] text-neutral-500 dark:text-neutral-400">
                    {entryMotion.effect === 'none'
                      ? '—'
                      : entryMotion.effect === 'zoom-in'
                        ? 'in'
                        : 'out'}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>

      {block ? (
        <>
          {/* Effect */}
          <Field label="Effect">
            <Segmented
              value={motion.effect}
              options={[
                ['none', 'None'],
                ['zoom-in', 'Zoom in'],
                ['zoom-out', 'Zoom out'],
              ]}
              onChange={(value) => set({ effect: value as Motion['effect'] })}
            />
          </Field>

          {animated ? (
            <>
              <Field label="Trigger">
                <Segmented
                  value={motion.trigger}
                  options={[
                    ['enter', 'On open'],
                    ['hover', 'Hover'],
                    ['click', 'Click'],
                  ]}
                  onChange={(value) => set({ trigger: value as Motion['trigger'] })}
                />
              </Field>

              <Slider
                label="Amount"
                value={motion.intensity}
                min={0.05}
                max={1}
                step={0.05}
                format={(value) => `${Math.round(value * 50)}%`}
                onChange={(intensity) => set({ intensity })}
              />

              <Slider
                label="Duration"
                value={motion.duration}
                min={0.1}
                max={3}
                step={0.05}
                format={(value) => `${value.toFixed(2)}s`}
                onChange={(duration) => set({ duration })}
              />

              {motion.trigger === 'enter' ? (
                <Slider
                  label="Delay"
                  value={motion.delay}
                  min={0}
                  max={3}
                  step={0.05}
                  format={(value) => `${value.toFixed(2)}s`}
                  onChange={(delay) => set({ delay })}
                />
              ) : null}

              <Field label="Easing">
                <select
                  value={motion.easing}
                  onChange={(event) => set({ easing: event.target.value as MotionEasing })}
                  className="w-full rounded-lg border border-black/10 bg-transparent px-2 py-1.5 text-xs dark:border-white/10"
                >
                  {MOTION_EASINGS.map((easing) => (
                    <option key={easing} value={easing}>
                      {easing}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Zoom from">
                <select
                  value={motion.origin}
                  onChange={(event) => set({ origin: event.target.value as MotionOrigin })}
                  className="w-full rounded-lg border border-black/10 bg-transparent px-2 py-1.5 text-xs dark:border-white/10"
                >
                  {MOTION_ORIGINS.map((origin) => (
                    <option key={origin} value={origin}>
                      {origin}
                    </option>
                  ))}
                </select>
              </Field>

              {motion.trigger === 'enter' ? (
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={motion.fade}
                    onChange={(event) => set({ fade: event.target.checked })}
                    className="h-3.5 w-3.5 accent-indigo-600"
                  />
                  Fade in as it zooms
                </label>
              ) : null}
            </>
          ) : null}

          <p className="text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
            {describeMotion(block.motion)}
          </p>

          <button
            type="button"
            onClick={() => onApplyAll(motion)}
            className="w-full rounded-lg border border-black/10 px-2.5 py-1.5 text-xs transition-colors hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/10"
          >
            Apply to every element
          </button>
        </>
      ) : (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Pick an element — in the list above, or by clicking it on the slide.
        </p>
      )}

      {error ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty || saving}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-40"
        >
          <Save className="h-3.5 w-3.5" strokeWidth={2} />
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onReset}
          disabled={!dirty || saving}
          title="Discard unsaved changes"
          className="rounded-lg border border-black/10 px-2.5 py-1.5 text-xs transition-colors hover:bg-black/5 disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/10"
        >
          <RotateCcw className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </div>
    </aside>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
        {label}
      </p>
      {children}
    </div>
  );
}

function Segmented({
  value,
  options,
  onChange,
}: {
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex gap-1 rounded-lg border border-black/10 p-0.5 dark:border-white/10">
      {options.map(([key, label]) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange(key)}
          className={`flex-1 rounded-md px-1.5 py-1 text-[11px] transition-colors ${
            key === value
              ? 'bg-indigo-600 text-white'
              : 'hover:bg-black/5 dark:hover:bg-white/10'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px]">
        <span className="font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          {label}
        </span>
        <span className="tabular-nums text-neutral-500 dark:text-neutral-400">
          {format(value)}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full accent-indigo-600"
      />
    </div>
  );
}
