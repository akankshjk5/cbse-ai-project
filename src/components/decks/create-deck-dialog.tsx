'use client';

import { useActionState, useCallback, useEffect, useRef, useState } from 'react';
import { FileOutput, Upload, X } from 'lucide-react';

import { createDeckAction, type CreateDeckFormState } from '@/lib/actions/decks';
import { DEFAULT_BOARD, INDIAN_BOARDS } from '@/lib/boards';
import {
  DECK_TEMPLATES,
  DEFAULT_TEMPLATE_ID,
  TEMPLATE_IDS,
  type DeckTemplate,
  type TemplateId,
} from '@/lib/templates';
import { formatBytes, MAX_REFERENCE_IMAGE_BYTES, referenceImageError } from '@/lib/uploads';

const GRADES = Array.from({ length: 10 }, (_, i) => i + 1);
const SUBJECTS = [
  'Mathematics',
  'Science',
  'Social Science',
  'English',
  'Hindi',
  'EVS',
  'Computer Science',
];
const SLIDE_COUNTS = [6, 8, 10, 12, 15, 20];
const LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'hi', label: 'Hindi' },
];

const initialState: CreateDeckFormState = { error: null };

const fieldClasses =
  'w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none transition-colors focus:border-indigo-500 dark:border-white/10 dark:bg-neutral-900';

/** Extensions the server accepts, keyed by the MIME type a paste carries. */
const PASTE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** Where a deck's design system comes from. Exactly one of the two. */
type StyleMode = 'template' | 'image';

/**
 * A template tile: the design system drawn as the slide it produces.
 *
 * Swatches would say which colours a template uses and nothing about what a
 * deck made from it looks like — and the choice being made here is the second
 * question, not the first. So the tile is a miniature slide, built from the
 * template's own background, text, accent and corner radius, which is the same
 * information a reference image would have carried.
 */
function TemplateTile({ template, selected }: { template: DeckTemplate; selected: boolean }) {
  const { colors, shapes } = template.style;
  const radius = `${(shapes.cornerRadius ?? 0.08) * 40}px`;

  return (
    <span
      className={`flex cursor-pointer flex-col gap-1.5 rounded-lg border p-1.5 transition-colors ${
        selected
          ? 'border-indigo-500 ring-2 ring-indigo-500/30'
          : 'border-black/10 hover:border-indigo-400 dark:border-white/10'
      }`}
    >
      <span
        aria-hidden
        className="flex aspect-video w-full flex-col justify-center gap-[5px] overflow-hidden px-2"
        style={{ background: colors.background, borderRadius: radius }}
      >
        <span
          className="block h-[6px] w-3/4 rounded-full"
          style={{ background: colors.primaryText }}
        />
        <span
          className="block h-[3px] w-full rounded-full"
          style={{ background: colors.secondaryText ?? colors.primaryText, opacity: 0.7 }}
        />
        <span
          className="block h-[3px] w-2/3 rounded-full"
          style={{ background: colors.secondaryText ?? colors.primaryText, opacity: 0.7 }}
        />
        <span
          className="mt-[2px] block h-[6px] w-1/3 rounded-full"
          style={{ background: colors.accent ?? colors.primaryText }}
        />
      </span>
      <span className="px-0.5 text-[11px] font-medium leading-tight">{template.name}</span>
    </span>
  );
}

export function CreateDeckDialog() {
  const [open, setOpen] = useState(false);
  const [referenceName, setReferenceName] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [styleMode, setStyleMode] = useState<StyleMode>('template');
  const [templateId, setTemplateId] = useState<TemplateId>(DEFAULT_TEMPLATE_ID);
  const formRef = useRef<HTMLFormElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [state, formAction, pending] = useActionState(createDeckAction, initialState);

  /**
   * Shows the chosen image and remembers its name.
   *
   * `URL.createObjectURL` needs its counterpart revoke or the blob is pinned in
   * memory for the life of the document, so the old preview is released before
   * a new one replaces it.
   */
  const showFile = useCallback((file: File) => {
    setReferenceName(file.name);
    setPreview((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return URL.createObjectURL(file);
    });
  }, []);

  /**
   * Accepts a file only if it passes the same check the action applies.
   *
   * Size in particular has to be caught here: a body over the Server Action cap
   * is rejected by the framework before the action runs, which surfaces as a
   * runtime error rather than anything `useActionState` can render.
   */
  const acceptFile = useCallback(
    (file: File): boolean => {
      const problem = referenceImageError(file);
      if (problem) {
        setPasteError(problem);
        return false;
      }
      setPasteError(null);
      showFile(file);
      return true;
    },
    [showFile],
  );

  const clearFile = useCallback(() => {
    setReferenceName(null);
    setPreview((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return null;
    });
  }, []);

  useEffect(() => {
    if (state.error === null && !pending && open && formRef.current) {
      formRef.current.reset();
      clearFile();
      setPasteError(null);
      setStyleMode('template');
      setTemplateId(DEFAULT_TEMPLATE_ID);
      setOpen(false);
    }
    // Only reset once the pending submit that produced this state settles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, pending]);

  /**
   * Ctrl/Cmd-V anywhere in the dialog fills the file input.
   *
   * A pasted screenshot is a `File` with no name, and `input.files` is
   * read-only — the only way to hand one to a form input is a `DataTransfer`
   * list. Doing that (rather than keeping the blob in React state) means the
   * Server Action sees an ordinary multipart upload and needs no paste-specific
   * path of its own.
   */
  useEffect(() => {
    // Only while the reference-image option is the one on screen: in template
    // mode there is no file input to fill, and swallowing a paste there would
    // stop Ctrl+V working in the topic field.
    if (!open || styleMode !== 'image') return;

    function onPaste(event: ClipboardEvent) {
      const items = Array.from(event.clipboardData?.items ?? []);
      const imageItem = items.find((item) => item.type.startsWith('image/'));

      if (!imageItem) {
        // Pasting text into a text field must still work — say nothing unless
        // the clipboard held a file we had to turn down.
        if (items.some((item) => item.kind === 'file')) {
          setPasteError('That file is not an image. Paste a PNG, JPEG or WebP.');
        }
        return;
      }

      const extension = PASTE_EXTENSIONS[imageItem.type];
      if (!extension) {
        setPasteError(`${imageItem.type} is not supported. Paste a PNG, JPEG or WebP.`);
        return;
      }

      const pasted = imageItem.getAsFile();
      if (!pasted) return;

      event.preventDefault();

      // Screenshots arrive as "image.png" or nameless; timestamp it so two
      // pastes in one session are distinguishable in storage.
      const named = new File([pasted], `pasted-${Date.now()}.${extension}`, {
        type: imageItem.type,
      });

      // Only hand it to the input once it has passed the size/type check —
      // otherwise the form would carry a file the submit is guaranteed to fail.
      if (!acceptFile(named)) return;

      const transfer = new DataTransfer();
      transfer.items.add(named);
      if (fileInputRef.current) fileInputRef.current.files = transfer.files;
    }

    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [open, styleMode, acceptFile]);

  // Release the last preview when the dialog unmounts.
  useEffect(() => () => clearFile(), [clearFile]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 active:bg-indigo-700"
      >
        <FileOutput className="h-4 w-4" strokeWidth={2} />
        Create PPTX
      </button>

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-deck-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm"
        >
          <div className="w-full max-w-md rounded-xl border border-black/10 bg-white p-5 shadow-xl dark:border-white/10 dark:bg-neutral-900">
            <div className="flex items-center justify-between">
              <h2 id="create-deck-title" className="text-base font-semibold">
                Create a PPTX
              </h2>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setOpen(false)}
                className="rounded p-1 text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form ref={formRef} action={formAction} className="mt-4 flex flex-col gap-3.5">
              <div className="grid grid-cols-2 gap-3.5">
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  Class
                  <select name="gradeLevel" required defaultValue={8} className={fieldClasses}>
                    {GRADES.map((grade) => (
                      <option key={grade} value={grade}>
                        Class {grade}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  Subject
                  <select name="subject" required defaultValue="" className={fieldClasses}>
                    <option value="" disabled>
                      Select subject
                    </option>
                    {SUBJECTS.map((subject) => (
                      <option key={subject} value={subject}>
                        {subject}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  Board
                  <select name="board" required defaultValue={DEFAULT_BOARD} className={fieldClasses}>
                    {INDIAN_BOARDS.map((board) => (
                      <option key={board} value={board}>
                        {board}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  Language
                  <select name="language" required defaultValue="en" className={fieldClasses}>
                    {LANGUAGES.map(({ value, label }) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  Slides
                  <select name="slideCount" required defaultValue={10} className={fieldClasses}>
                    {SLIDE_COUNTS.map((count) => (
                      <option key={count} value={count}>
                        {count} slides
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Topic
                <input
                  type="text"
                  name="topic"
                  required
                  placeholder="e.g. Photosynthesis in plants"
                  className={fieldClasses}
                />
              </label>

              <div className="flex flex-col gap-2 text-sm font-medium">
                <span>Design</span>

                {/* The chosen mode travels as a plain hidden field: an empty
                    value means "no template", which is what the action reads
                    as "use the uploaded reference instead". */}
                <input
                  type="hidden"
                  name="template"
                  value={styleMode === 'template' ? templateId : ''}
                />

                <div
                  role="radiogroup"
                  aria-label="Where the deck's design comes from"
                  className="flex gap-1 rounded-lg bg-black/5 p-1 dark:bg-white/10"
                >
                  {(
                    [
                      ['template', 'Use a template'],
                      ['image', 'Match an image'],
                    ] as const
                  ).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      role="radio"
                      aria-checked={styleMode === mode}
                      onClick={() => {
                        setStyleMode(mode);
                        setPasteError(null);
                        // A file left on the input while a template is chosen
                        // would never be read — clear it so what the dialog
                        // shows is what the deck gets.
                        if (mode === 'template') {
                          if (fileInputRef.current) fileInputRef.current.value = '';
                          clearFile();
                        }
                      }}
                      className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                        styleMode === mode
                          ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-800 dark:text-neutral-100'
                          : 'text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {styleMode === 'template' ? (
                  <>
                    <span className="font-normal text-neutral-500 dark:text-neutral-400">
                      {DECK_TEMPLATES[templateId].description}
                    </span>
                    <div
                      role="radiogroup"
                      aria-label="Template"
                      className="grid grid-cols-3 gap-2"
                    >
                      {TEMPLATE_IDS.map((id) => (
                        <button
                          key={id}
                          type="button"
                          role="radio"
                          aria-checked={templateId === id}
                          aria-label={DECK_TEMPLATES[id].name}
                          onClick={() => setTemplateId(id)}
                          className="text-left"
                        >
                          <TemplateTile
                            template={DECK_TEMPLATES[id]}
                            selected={templateId === id}
                          />
                        </button>
                      ))}
                    </div>
                  </>
                ) : null}

                <div className={styleMode === 'image' ? 'flex flex-col gap-1.5' : 'hidden'}>
                  <label htmlFor="referenceImage" className="sr-only">
                    Reference image
                  </label>
                  <span className="font-normal text-neutral-500 dark:text-neutral-400">
                    Every colour, font and spacing rule is read from it. PNG, JPEG or WebP, up to{' '}
                    {formatBytes(MAX_REFERENCE_IMAGE_BYTES)}.
                  </span>
                  <div className="flex items-center gap-2">
                    <label
                      htmlFor="referenceImage"
                      className="flex flex-1 cursor-pointer items-center gap-2 rounded-lg border border-dashed border-black/15 px-3 py-2 text-sm text-neutral-600 transition-colors hover:border-indigo-500 hover:text-indigo-600 dark:border-white/15 dark:text-neutral-300"
                    >
                      <Upload className="h-4 w-4 shrink-0" />
                      <span className="truncate">
                        {referenceName ?? 'Choose an image, or paste one with Ctrl+V'}
                      </span>
                    </label>
                    <input
                      ref={fileInputRef}
                      id="referenceImage"
                      type="file"
                      name="referenceImage"
                      accept="image/png,image/jpeg,image/webp"
                      className="hidden"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (!file) {
                          setPasteError(null);
                          clearFile();
                          return;
                        }
                        // A rejected pick is cleared off the input too, so the
                        // form cannot submit a file the user was just told about.
                        if (!acceptFile(file)) {
                          event.target.value = '';
                          clearFile();
                        }
                      }}
                    />

                    {preview ? (
                      <span className="relative shrink-0">
                        {/* Local blob URL, so next/image would buy nothing here. */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={preview}
                          alt="Style reference preview"
                          className="h-10 w-16 rounded-md border border-black/10 object-cover dark:border-white/10"
                        />
                        <button
                          type="button"
                          aria-label="Remove reference image"
                          onClick={() => {
                            if (fileInputRef.current) fileInputRef.current.value = '';
                            clearFile();
                          }}
                          className="absolute -right-1.5 -top-1.5 rounded-full bg-neutral-800 p-0.5 text-white shadow hover:bg-neutral-700"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ) : null}
                  </div>
                  {pasteError ? (
                    <span className="font-normal text-red-600 dark:text-red-400">{pasteError}</span>
                  ) : null}
                </div>
              </div>

              {state.error ? (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-400">
                  {state.error}
                </p>
              ) : null}

              <div className="mt-1 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-lg px-3.5 py-2 text-sm font-medium text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/10"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={pending}
                  className="rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-60"
                >
                  {pending ? 'Creating…' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
