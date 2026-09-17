// Client-side expression feedback for the Scalar Fields calculator.
//
// This does NOT evaluate anything, and it is deliberately not a parser. The
// backend's AST walker (`backend-api/scalar_fields.py`) is the authority on
// what is valid and is the only thing that ever runs an expression; duplicating
// its grammar here would be a second source of truth that drifts, and the
// drift would show up as the panel accepting something the backend then
// rejects, or — far worse — greying out a formula that would have worked.
//
// What it does instead is catch the two mistakes that are worth reporting
// BEFORE a round trip, because they are common and unambiguous:
//
//   * an unbalanced parenthesis, which is what a half-typed formula looks like
//     and which would otherwise spend a request to be told "invalid syntax"
//   * an identifier that is neither a field on this cloud nor a known function
//     or constant — i.e. a typo, where naming the closest match is most of the
//     fix
//
// Everything else — precedence, arity, aggregate placement, division by zero —
// is left to the backend, which reports it with a column offset the panel
// underlines.
//
// Pure + stateless — safe to unit-test directly.

/** What the panel knows about this cloud's vocabulary. */
export interface ExpressionVocabulary {
  /** Field slugs referenceable in an expression (`x`, `intensity`, `curvature`). */
  fields: readonly string[];
  /** Elementwise function names (`sqrt`, `atan2`, `ifelse`). */
  functions: readonly string[];
  /** Whole-field aggregate names (`mean`, `std`, `percentile`). */
  aggregates: readonly string[];
  /** Bare constants (`pi`, `e`, `nan`, `inf`). */
  constants: readonly string[];
}

export interface ExpressionProblem {
  message: string;
  /** 0-based column offset into the expression, when known. */
  col?: number;
  /** A suggested replacement, when a near-miss was found. */
  suggestion?: string;
}

/** Identifiers that are Python keywords, so they can never be a call target. */
const KEYWORDS = new Set(['if', 'else', 'and', 'or', 'not', 'True', 'False', 'None']);

/**
 * Pre-validate `expression` against the cloud's vocabulary.
 *
 * Returns the first problem worth reporting, or null when nothing is obviously
 * wrong — which is NOT a promise that the backend will accept it.
 *
 * An empty expression returns null rather than a problem: a blank field is the
 * starting state, not an error, and the Run button is what should be disabled.
 */
export function checkExpression(
  expression: string,
  vocab: ExpressionVocabulary,
): ExpressionProblem | null {
  const src = expression ?? '';
  if (!src.trim()) return null;

  const unbalanced = findUnbalancedParen(src);
  if (unbalanced) return unbalanced;

  const known = new Set<string>([
    ...vocab.fields,
    ...vocab.functions,
    ...vocab.aggregates,
    ...vocab.constants,
  ]);

  for (const { name, col } of identifiers(src)) {
    if (KEYWORDS.has(name) || known.has(name)) continue;
    const suggestion = closestMatch(name, known);
    return {
      message: suggestion
        ? `Unknown name "${name}" — did you mean "${suggestion}"?`
        : `Unknown name "${name}".`,
      col,
      suggestion,
    };
  }
  return null;
}

/** Every identifier in `src`, with its offset. Numbers and operators are skipped. */
export function identifiers(src: string): Array<{ name: string; col: number }> {
  const out: Array<{ name: string; col: number }> = [];
  // Deliberately simple: an identifier is a letter/underscore run. A leading
  // digit makes it part of a number literal, which `\b` handles by not matching
  // inside `1e5` or `3.14`.
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    // Skip a match that begins immediately after a digit or a decimal point.
    // It is the tail of a numeric literal, not a name: `1e5` matches as the
    // single token `e5`, and `2.5E-3` as `E`. Testing the PRECEDING character
    // rather than the matched text is what covers both — an earlier version
    // checked only for a bare `e`/`E` and let `e5` through as an unknown name,
    // helpfully suggesting the user had meant the constant `e`.
    const before = src[m.index - 1];
    if (before !== undefined && /[0-9.]/.test(before)) continue;
    out.push({ name: m[0], col: m.index });
  }
  return out;
}

/**
 * The offset of the first unbalanced parenthesis, or null when they match.
 *
 * Reports the CLOSING paren that has no opener at its own offset, and an
 * unclosed opener at the offset of the opener itself — in both cases the
 * character the user needs to look at, rather than the end of the string.
 */
function findUnbalancedParen(src: string): ExpressionProblem | null {
  const stack: number[] = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '(') stack.push(i);
    else if (src[i] === ')') {
      if (stack.length === 0) {
        return { message: 'Unmatched closing parenthesis.', col: i };
      }
      stack.pop();
    }
  }
  if (stack.length > 0) {
    return { message: 'Unclosed parenthesis.', col: stack[stack.length - 1] };
  }
  return null;
}

/**
 * The closest known name to `name`, or undefined when nothing is close enough.
 *
 * Edit distance with a threshold that scales with length: one edit for a short
 * name, two for a longer one. A fixed threshold either misses `intensty` →
 * `intensity` (2 edits at 9 characters) or suggests `pi` for `pa`.
 */
export function closestMatch(name: string, known: Iterable<string>): string | undefined {
  const lower = name.toLowerCase();
  let best: string | undefined;
  let bestDist = Infinity;
  const limit = name.length <= 4 ? 1 : 2;
  for (const candidate of known) {
    // A pure case difference is always the intended match.
    if (candidate.toLowerCase() === lower) return candidate;
    const d = editDistance(lower, candidate.toLowerCase(), limit);
    if (d <= limit && d < bestDist) {
      bestDist = d;
      best = candidate;
    }
  }
  return best;
}

/**
 * Levenshtein distance, abandoning once every cell of a row exceeds `limit`.
 *
 * The cutoff matters: this runs over the whole vocabulary on every keystroke,
 * and a cloud can carry dozens of fields.
 */
function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      row.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > limit) return limit + 1;
    prev = row;
  }
  return prev[b.length];
}

/**
 * A default slug for the field an expression will produce.
 *
 * Seeds the name input so the common case is one click. Derived from the
 * expression rather than left blank because "what do I call this" is friction
 * at exactly the moment the user has finished thinking.
 *
 * `intensity * 2` → `intensity_x2` is over-clever and would be wrong as often
 * as right, so this stays mechanical: strip to legal characters, collapse runs,
 * truncate, and fall back to `field` when nothing usable survives.
 */
export function suggestSlug(expression: string, taken: readonly string[] = []): string {
  const base = (expression ?? '')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_')
    .slice(0, 24)
    .replace(/^[0-9]/, 'f$&');
  const seed = base || 'field';
  const used = new Set(taken);
  if (!used.has(seed)) return seed;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${seed}_${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return seed;
}

/** Slug rules, mirrored from `scalar_fields.validate_slug` for instant feedback. */
export const MAX_SLUG_LEN = 32;

/**
 * Why `slug` is unusable as a field name, or null when it looks fine.
 *
 * The backend re-checks all of this and additionally rejects reserved slugs and
 * canonical import aliases, which this cannot know without the field list. So
 * `taken` is passed in, and everything else is left to the 400.
 */
export function checkSlug(slug: string, taken: readonly string[] = []): string | null {
  if (!slug) return 'Enter a name for the new field.';
  if (slug.length > MAX_SLUG_LEN) {
    return `Name is ${slug.length} characters; the limit is ${MAX_SLUG_LEN}.`;
  }
  if (!/^[A-Za-z_]/.test(slug)) return 'Name must start with a letter or underscore.';
  if (!/^[A-Za-z0-9_]+$/.test(slug)) {
    return 'Name may only contain letters, digits and underscores.';
  }
  if (taken.includes(slug)) return `This cloud already has a field named "${slug}".`;
  return null;
}
