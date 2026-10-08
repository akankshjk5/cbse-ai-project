import { z } from 'zod';

// Exact graphics drawn by the worker's deterministic compositor
// (ops/runpod/lesson_compositor.py). Generative models never draw these.

export const ARROW_DIRECTIONS = [
  'up', 'down', 'left', 'right', 'up-right', 'down-right', 'down-left', 'up-left',
] as const;

const EQUATION_STEP = /^[0-9a-z+\-*/=().^ <>]{1,32}$/;

export const LessonOverlaySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('arrow'), direction: z.enum(ARROW_DIRECTIONS) }),
  z.object({
    kind: z.literal('equation'),
    steps: z.array(
      z.string().trim().toLowerCase().regex(EQUATION_STEP, 'Use short ASCII math such as "2x + 3 = 11"')
        .refine((step) => !/[a-z]{3,}/.test(step), 'Variables must be single letters, not words'),
    ).min(1).max(4),
  }),
  z.object({
    kind: z.literal('groups'),
    groups: z.array(z.object({
      count: z.number().int().min(1).max(12),
      token: z.string().trim().toLowerCase().regex(/^[0-9a-z]{0,3}$/).default(''),
    })).min(1).max(5),
    showTotal: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('bars'),
    values: z.array(z.number().nonnegative().finite()).min(2).max(6),
    unit: z.string().trim().regex(/^[%a-zA-Z/°]{0,6}$/).default(''),
  }),
  z.object({
    kind: z.literal('timeline'),
    years: z.array(z.number().int().min(-3000).max(2100)).min(2).max(6),
    current: z.number().int(),
  }).refine(
    (timeline) => timeline.years.every((year, index) => index === 0 || year > timeline.years[index - 1])
      && timeline.years.includes(timeline.current),
    'Timeline years must be ascending and include the current year',
  ),
]);

export type LessonOverlay = z.infer<typeof LessonOverlaySchema>;

// ----------------------------------------------------------------------------
// Tiny arithmetic parser used only to audit planner-supplied math.
// ----------------------------------------------------------------------------

type Evaluator = (variables: Record<string, number>) => number;

function tokenize(source: string): string[] {
  const tokens = source.replace(/\s+/g, '').match(/\d+(?:\.\d+)?|[a-z]|[+\-*/^()]/g) ?? [];
  if (tokens.join('') !== source.replace(/\s+/g, '')) throw new Error('Unsupported symbol');
  // Insert implicit multiplication: 2x, 3(x+1), (x+1)(x-1), x y.
  const result: string[] = [];
  tokens.forEach((token, index) => {
    const previous = tokens[index - 1];
    if (
      previous
      && (/^[\d.a-z]+$/.test(previous) || previous === ')')
      && (/^[a-z]$/.test(token) || token === '(' || (/^\d/.test(token) && previous === ')'))
    ) {
      result.push('*');
    }
    result.push(token);
  });
  return result;
}

function parseExpression(source: string): { evaluate: Evaluator; variables: Set<string> } {
  const tokens = tokenize(source);
  const variables = new Set<string>();
  let position = 0;
  const peek = () => tokens[position];
  const take = () => tokens[position++];

  function primary(): Evaluator {
    const token = take();
    if (token === undefined) throw new Error('Unexpected end');
    if (token === '(') {
      const inner = sum();
      if (take() !== ')') throw new Error('Missing )');
      return inner;
    }
    if (token === '-') {
      const operand = power();
      return (vars) => -operand(vars);
    }
    if (/^\d/.test(token)) {
      const value = Number(token);
      return () => value;
    }
    if (/^[a-z]$/.test(token)) {
      variables.add(token);
      return (vars) => vars[token];
    }
    throw new Error(`Unexpected ${token}`);
  }
  function power(): Evaluator {
    const base = primary();
    if (peek() === '^') {
      take();
      const exponent = power();
      return (vars) => base(vars) ** exponent(vars);
    }
    return base;
  }
  function product(): Evaluator {
    let left = power();
    while (peek() === '*' || peek() === '/') {
      const operator = take();
      const right = power();
      const current = left;
      left = operator === '*' ? (vars) => current(vars) * right(vars) : (vars) => current(vars) / right(vars);
    }
    return left;
  }
  function sum(): Evaluator {
    let left = product();
    while (peek() === '+' || peek() === '-') {
      const operator = take();
      const right = product();
      const current = left;
      left = operator === '+' ? (vars) => current(vars) + right(vars) : (vars) => current(vars) - right(vars);
    }
    return left;
  }

  const evaluate = sum();
  if (position !== tokens.length) throw new Error('Trailing tokens');
  return { evaluate, variables };
}

const SAMPLE_POINTS = [-2.5, -1, 0.5, 1.75, 3.2];
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

function linearRoot(evaluate: Evaluator, variable: string): number | null {
  const at = (value: number) => evaluate({ [variable]: value });
  const intercept = at(0);
  const slope = at(1) - intercept;
  if (!Number.isFinite(slope) || close(slope, 0)) return null;
  // Confirm the step really is linear before trusting the root.
  if (!SAMPLE_POINTS.every((point) => close(at(point), intercept + slope * point))) return null;
  return -intercept / slope;
}

/**
 * Returns null when every step is consistent, otherwise a reason. Equations
 * must be linear in one variable and share one solution; plain expressions must
 * be algebraically equivalent to each other (a simplification chain).
 */
export function auditEquationSteps(steps: string[]): string | null {
  try {
    const equations = steps.map((step) => step.split('='));
    if (equations.some((parts) => parts.length > 2)) return 'A step contains more than one "="';
    const allEquations = equations.every((parts) => parts.length === 2);
    const allExpressions = equations.every((parts) => parts.length === 1);
    if (!allEquations && !allExpressions) return 'Mixes equations and expressions';

    if (allEquations) {
      let root: number | null = null;
      for (const [left, right] of equations) {
        const lhs = parseExpression(left);
        const rhs = parseExpression(right);
        const variables = new Set([...lhs.variables, ...rhs.variables]);
        if (variables.size !== 1) return 'Each equation must use exactly one variable';
        const [variable] = [...variables];
        const stepRoot = linearRoot((vars) => lhs.evaluate(vars) - rhs.evaluate(vars), variable);
        if (stepRoot === null) return 'Each equation must be linear with one solution';
        if (root !== null && !close(root, stepRoot)) return 'Equation steps do not share one solution';
        root = stepRoot;
      }
      return null;
    }

    const parsed = steps.map((step) => parseExpression(step));
    const variables = [...new Set(parsed.flatMap((item) => [...item.variables]))];
    for (const point of SAMPLE_POINTS) {
      const assignment = Object.fromEntries(variables.map((name, index) => [name, point + index * 0.37]));
      const first = parsed[0].evaluate(assignment);
      if (!parsed.every((item) => close(item.evaluate(assignment), first))) {
        return 'Expression steps are not equivalent';
      }
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'Unparseable math';
  }
}

function numbersIn(text: string): Set<string> {
  return new Set((text.match(/\d+(?:\.\d+)?/g) ?? []).map((value) => String(Number(value))));
}

/**
 * Keep an overlay only if it is exactly supported by the audited fact. Showing
 * no diagram is safe; showing a wrong one is misinformation.
 */
export function auditOverlay(overlay: LessonOverlay, fact: string): { overlay: LessonOverlay; issue: string | null } {
  if (overlay.kind === 'none' || overlay.kind === 'arrow') return { overlay, issue: null };
  if (overlay.kind === 'timeline') {
    // The highlighted year must be this scene's fact; the other years are
    // checked against the whole lesson by auditTimelines.
    return numbersIn(fact).has(String(overlay.current))
      ? { overlay, issue: null }
      : { overlay: { kind: 'none' }, issue: `timeline year ${overlay.current} is not in the audited fact` };
  }
  const factNumbers = numbersIn(fact);
  const shown = overlay.kind === 'equation'
    ? overlay.steps.join(' ')
    : overlay.kind === 'groups'
      ? overlay.groups.map((group) => `${group.count} ${/^\d+$/.test(group.token) ? group.token : ''}`)
        .concat(overlay.showTotal ? [String(overlay.groups.reduce((sum, group) => sum + group.count, 0))] : [])
        .join(' ')
      : overlay.values.join(' ');
  const unsupported = [...numbersIn(shown)].filter((value) => !factNumbers.has(value));
  if (unsupported.length > 0) {
    return { overlay: { kind: 'none' }, issue: `numbers ${unsupported.join(', ')} are not in the audited fact` };
  }
  if (overlay.kind === 'equation') {
    const issue = auditEquationSteps(overlay.steps);
    if (issue) return { overlay: { kind: 'none' }, issue };
  }
  if (overlay.kind === 'bars') {
    // Bars must compare like quantities; "age 16 vs year 1656" is not a chart.
    const yearLike = overlay.values.some((value) => value >= 1000 && value <= 2100);
    const small = overlay.values.some((value) => value < 100);
    if (yearLike && small) return { overlay: { kind: 'none' }, issue: 'bars mix years with small quantities' };
  }
  return { overlay, issue: null };
}

/**
 * Coerce a model-written overlay into a valid one, or none. Overlays are an
 * optional teaching aid, so a malformed one must never fail a whole lesson.
 */
export function coerceOverlay(raw: unknown): LessonOverlay {
  let candidate = raw;
  if (raw && typeof raw === 'object') {
    const draft = { ...(raw as Record<string, unknown>) };
    if (Array.isArray(draft.groups)) {
      draft.groups = draft.groups.map((group) => (
        group && typeof group === 'object'
          ? {
            ...(group as Record<string, unknown>),
            token: String((group as { token?: unknown }).token ?? '')
              .toLowerCase().replace(/[^0-9a-z]/g, '').slice(0, 3),
          }
          : group
      ));
    }
    if (Array.isArray(draft.steps)) {
      draft.steps = draft.steps.map((step) => String(step).toLowerCase()
        .replace(/×/g, '*').replace(/÷/g, '/').replace(/[−–]/g, '-'));
    }
    if (typeof draft.unit === 'string') draft.unit = draft.unit.replace(/[^%a-zA-Z/°]/g, '').slice(0, 6);
    if (Array.isArray(draft.years)) {
      const current = Math.round(Number(draft.current));
      const years = draft.years.map((year) => Math.round(Number(year))).filter(Number.isFinite);
      if (Number.isFinite(current)) years.push(current);
      draft.years = [...new Set(years)].sort((a, b) => a - b).slice(0, 6);
      draft.current = current;
    }
    candidate = draft;
  }
  const parsed = LessonOverlaySchema.safeParse(candidate);
  return parsed.success ? parsed.data : { kind: 'none' };
}

/**
 * Timeline years other than the highlighted one must each be stated in some
 * fact of the lesson; unsupported years are removed, and a timeline left with
 * fewer than two years is dropped.
 */
export function auditTimelines<T extends { fact: string; overlay: LessonOverlay }>(scenes: T[]): T[] {
  const lessonNumbers = numbersIn(scenes.map((scene) => scene.fact).join(' '));
  return scenes.map((scene) => {
    if (scene.overlay.kind !== 'timeline') return scene;
    const years = scene.overlay.years.filter((year) => lessonNumbers.has(String(year)));
    if (years.length < 2 || !years.includes(scene.overlay.current)) {
      return { ...scene, overlay: { kind: 'none' } as LessonOverlay };
    }
    return { ...scene, overlay: { ...scene.overlay, years } };
  });
}
