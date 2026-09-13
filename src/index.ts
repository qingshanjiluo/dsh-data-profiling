/**
 * Deterministic CSV / JSON data profiling for DeepSeek Harness.
 *
 * `profile_csv` and `profile_json` infer a per-column type and report null rate,
 * distinct count, min/max, and sample values; `profile_report` renders either
 * result back into a markdown summary with data-quality findings. All three
 * tools are pure: text goes in, data comes out — no filesystem, network,
 * subprocess, or clock is touched, so the same input always yields the same
 * output.
 * @module @qingshanjiluo/dsh-data-profiling
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-data-profiling'
export const inject = ['tools']

/** Deployment knobs for the profiler. */
export interface Config {
  /** Distinct sample values reported per column. */
  sampleSize: number
  /** Maximum number of columns profiled; wider input is dropped with a note. */
  maxColumns: number
  /** Null rate (percent) above which `profile_report` flags a column. */
  nullWarnPct: number
}

/** Schemastery configuration for the profiler. */
export const Config: z<Config> = z.object({
  sampleSize: z.number().default(3),
  maxColumns: z.number().default(50),
  nullWarnPct: z.number().default(20),
})

/** One cell after normalisation; `null` means missing. */
type Cell = string | null

/** Statistics for a single column. */
interface ColumnProfile {
  name: string
  type: string
  total: number
  nulls: number
  nullPct: number
  distinct: number
  min: string
  max: string
  samples: string[]
}

/** Canonical profile returned by both profilers. */
interface ProfileResult {
  ok: boolean
  error: string
  note: string
  source: string
  rows: number
  columns: ColumnProfile[]
}

/** Tokens that count as "no value" once trimmed and lower-cased. */
const NULL_TOKENS = new Set(['', 'na', 'n/a', 'null', 'none', 'nil', 'nan', '-', '--'])

const NUMBER_RE = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/
const TRUE_TOKENS = new Set(['true', 't', 'yes', 'y'])
const FALSE_TOKENS = new Set(['false', 'f', 'no', 'n'])

/**
 * Render a number without floating-point noise, so `min`/`max` stay stable.
 * @param value - a finite number.
 * @returns at most six decimal places, no trailing zeroes.
 */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return ''
  if (Number.isInteger(value)) return String(value)
  return String(Math.round(value * 1e6) / 1e6)
}

/**
 * Serialise a nested JSON value so it can still be counted and sampled.
 * @param value - any JSON value.
 * @returns compact JSON with object keys sorted for determinism.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(entry => stableStringify(entry)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const parts = Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    return `{${parts.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * Normalise one raw CSV field.
 * @param raw - the untrimmed field text.
 * @returns the trimmed text, or `null` for empty / placeholder values.
 */
function csvCell(raw: string): Cell {
  const text = raw.trim()
  if (text.length === 0 || NULL_TOKENS.has(text.toLowerCase())) return null
  return text
}

/**
 * Normalise one JSON value into a comparable text cell.
 * @param value - a parsed JSON value.
 * @returns text, or `null` for missing values.
 */
function jsonCell(value: unknown): Cell {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value.length === 0 ? null : value
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return stableStringify(value)
}

/**
 * Classify one text cell.
 * @param text - a non-null cell.
 * @returns the single kind this value matches, or `'string'`.
 */
function classify(text: string): string {
  if (NUMBER_RE.test(text) && Number.isFinite(Number(text))) return 'number'
  const lower = text.toLowerCase()
  if (TRUE_TOKENS.has(lower) || FALSE_TOKENS.has(lower)) return 'boolean'
  if (DATE_RE.test(text) && !Number.isNaN(Date.parse(text))) return 'date'
  return 'string'
}

/**
 * Infer a column type: the common kind when every value agrees, else `string`.
 * @param values - non-null cells of one column.
 * @returns `'number' | 'boolean' | 'date' | 'string'`.
 */
function inferColumnType(values: readonly string[]): string {
  if (values.length === 0) return 'string'
  const first = classify(values[0])
  for (const value of values) if (classify(value) !== first) return 'string'
  return first
}

/**
 * Round a ratio to a two-decimal percentage.
 * @param part - numerator.
 * @param whole - denominator; zero yields 0.
 * @returns percent in the range 0..100.
 */
function percent(part: number, whole: number): number {
  if (whole <= 0) return 0
  return Math.round((part / whole) * 10000) / 100
}

/**
 * Pick the smallest or largest cell of one column.
 * @param values - non-null cells, in input order.
 * @param kind - the inferred column type.
 * @param want - `'min'` or `'max'`.
 * @returns boundary text; empty for an all-null column.
 */
function boundary(values: readonly string[], kind: string, want: 'min' | 'max'): string {
  if (values.length === 0) return ''
  if (kind === 'number') {
    let best = Number.NaN
    for (const value of values) {
      const parsed = Number(value)
      if (!Number.isFinite(parsed)) continue
      if (Number.isNaN(best) || (want === 'min' ? parsed < best : parsed > best)) best = parsed
    }
    if (!Number.isNaN(best)) return formatNumber(best)
  }
  let best = values[0]
  for (const value of values) {
    if (want === 'min' ? value < best : value > best) best = value
  }
  return best
}

/**
 * Summarise one column.
 * @param name - column name.
 * @param values - every cell of the column, including nulls.
 * @param sampleSize - how many distinct values to return.
 * @returns the canonical per-column profile.
 */
function summarizeColumn(name: string, values: readonly Cell[], sampleSize: number): ColumnProfile {
  const present: string[] = []
  for (const cell of values) if (cell !== null) present.push(cell)
  const order: string[] = []
  for (const value of present) if (!order.includes(value)) order.push(value)
  const type = inferColumnType(present)
  const nulls = values.length - present.length
  return {
    name,
    type,
    total: values.length,
    nulls,
    nullPct: percent(nulls, values.length),
    distinct: order.length,
    min: boundary(present, type, 'min'),
    max: boundary(present, type, 'max'),
    samples: order.slice(0, Math.max(0, sampleSize)),
  }
}

/**
 * Assemble a successful profile from column-major cells.
 * @param source - `'csv'` or `'json'`, echoed to the model.
 * @param names - column names, already capped.
 * @param columns - cells per column.
 * @param rows - number of data rows.
 * @param note - advisory text, empty when nothing was dropped.
 * @param sampleSize - how many distinct sample values to keep per column.
 * @returns the canonical profile result.
 */
function success(source: string, names: readonly string[], columns: readonly Cell[][], rows: number, note: string, sampleSize: number): ProfileResult {
  return {
    ok: true,
    error: '',
    note,
    source,
    rows,
    columns: names.map((entry, index) => summarizeColumn(entry, columns[index] ?? [], sampleSize)),
  }
}

/**
 * A failed profile: always schema-complete so the renderer stays trivial.
 * @param source - `'csv'` or `'json'`.
 * @param error - what the model should fix.
 * @returns an `ok: false` profile.
 */
function failure(source: string, error: string): ProfileResult {
  return { ok: false, error, note: '', source, rows: 0, columns: [] }
}

/**
 * Split CSV text into raw rows. Quoted fields may contain commas, newlines, and
 * doubled quotes; blank lines are ignored and a UTF-8 BOM is skipped.
 * @param text - the CSV document.
 * @returns rows of raw field text.
 */
function splitCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0
  const finishField = (): void => {
    row.push(field)
    field = ''
  }
  const finishRow = (): void => {
    finishField()
    rows.push(row)
    row = []
  }
  while (index < text.length) {
    const char = text[index]
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 2
          continue
        }
        inQuotes = false
      } else {
        field += char
      }
      index += 1
      continue
    }
    if (char === '"' && field.length === 0) {
      inQuotes = true
      index += 1
      continue
    }
    if (char === ',') {
      finishField()
      index += 1
      continue
    }
    if (char === '\r') {
      index += 1
      continue
    }
    if (char === '\n') {
      finishRow()
      index += 1
      continue
    }
    field += char
    index += 1
  }
  if (field.length > 0 || row.length > 0) finishRow()
  return rows.filter(entry => !(entry.length === 1 && entry[0].trim().length === 0))
}

/**
 * Name the columns, falling back to `col<N>` and de-duplicating repeats.
 * @param header - the header row, or `undefined` for headerless input.
 * @param width - number of columns.
 * @returns one unique name per column, in order.
 */
function headerNames(header: readonly string[] | undefined, width: number): string[] {
  const used = new Map<string, number>()
  const names: string[] = []
  for (let column = 0; column < width; column++) {
    const base = (header?.[column] ?? '').trim() || `col${column + 1}`
    const seen = used.get(base) ?? 0
    used.set(base, seen + 1)
    names.push(seen === 0 ? base : `${base}__${seen + 1}`)
  }
  return names
}

/**
 * Profile CSV text.
 * @param csvText - the whole CSV document.
 * @param hasHeader - when `false`, columns are named `col1..colN`.
 * @param config - deployment knobs.
 * @returns the canonical profile, or an `ok: false` explanation.
 */
function profileCsv(csvText: string, hasHeader: boolean | undefined, config: Config): ProfileResult {
  const rows = splitCsv(csvText)
  if (rows.length === 0) return failure('csv', 'no data: the supplied CSV text is empty')
  const useHeader = hasHeader !== false
  const dataRows = useHeader ? rows.slice(1) : rows
  const width = rows.reduce((best, entry) => Math.max(best, entry.length), 0)
  if (width === 0) return failure('csv', 'no data: the CSV has no columns')
  const budget = Math.max(1, Math.floor(config.maxColumns))
  const kept = Math.min(width, budget)
  const note = width > kept ? `${width - kept} of ${width} columns were skipped (maxColumns=${budget})` : ''
  const names = headerNames(useHeader ? rows[0] : undefined, kept)
  const columns: Cell[][] = []
  for (let column = 0; column < kept; column++) {
    columns.push(dataRows.map(entry => (column < entry.length ? csvCell(entry[column]) : null)))
  }
  return success('csv', names, columns, dataRows.length, note, config.sampleSize)
}

/**
 * Profile JSON text describing records.
 * @param jsonText - a JSON array of objects, a single object, or an array of scalars.
 * @param config - deployment knobs.
 * @returns the canonical profile, or an `ok: false` explanation.
 */
function profileJson(jsonText: string, config: Config): ProfileResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch (error) {
    return failure('json', `invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const list = Array.isArray(parsed) ? parsed : [parsed]
  if (list.length === 0) return failure('json', 'no data: the JSON array is empty')
  const records: Record<string, unknown>[] = []
  for (const item of list) {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) records.push(item as Record<string, unknown>)
    else records.push({ value: item })
  }
  const names: string[] = []
  const seen = new Set<string>()
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (seen.has(key)) continue
      seen.add(key)
      names.push(key)
    }
  }
  const budget = Math.max(1, Math.floor(config.maxColumns))
  const kept = Math.min(names.length, budget)
  const note = names.length > kept ? `${names.length - kept} of ${names.length} columns were skipped (maxColumns=${budget})` : ''
  const columns: Cell[][] = names.slice(0, kept).map(key => records.map(record => jsonCell(record[key])))
  return success('json', names.slice(0, kept), columns, records.length, note, config.sampleSize)
}

/** Narrow an unknown JSON value to a string-keyed record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Read a numeric field with a fallback. */
function numOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Read a string field with a fallback. */
function strOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/**
 * Accept a profile handed back by the model, field by field.
 * @param value - the `profile` argument, however shaped.
 * @returns a usable profile, or `null` when it is not one.
 */
function readProfile(value: unknown): ProfileResult | null {
  if (!isRecord(value)) return null
  if (!Array.isArray(value.columns)) return null
  const columns: ColumnProfile[] = []
  for (const raw of value.columns) {
    if (!isRecord(raw) || typeof raw.name !== 'string') return null
    const samples = Array.isArray(raw.samples) ? raw.samples.filter((entry): entry is string => typeof entry === 'string') : []
    columns.push({
      name: raw.name,
      type: strOr(raw.type, 'string'),
      total: numOr(raw.total, 0),
      nulls: numOr(raw.nulls, 0),
      nullPct: numOr(raw.nullPct, 0),
      distinct: numOr(raw.distinct, 0),
      min: strOr(raw.min, ''),
      max: strOr(raw.max, ''),
      samples,
    })
  }
  return {
    ok: true,
    error: '',
    note: strOr(value.note, ''),
    source: strOr(value.source, 'unknown'),
    rows: numOr(value.rows, 0),
    columns,
  }
}

/**
 * Escape one markdown table cell and keep it short.
 * @param text - raw cell text.
 * @returns single-line, pipe-safe, length-bounded text.
 */
function mdCell(text: string): string {
  const flat = text.replace(/\s+/g, ' ').replace(/\|/g, '\\|')
  return flat.length <= 60 ? flat : `${flat.slice(0, 57)}...`
}

/**
 * Findings a reviewer should look at, in column order.
 * @param profile - a validated profile.
 * @param config - deployment knobs.
 * @returns advisory lines; empty when the data looks clean.
 */
function findings(profile: ProfileResult, config: Config): string[] {
  const lines: string[] = []
  for (const column of profile.columns) {
    if (column.nullPct > config.nullWarnPct) {
      lines.push(`\`${column.name}\`: ${column.nullPct}% null (${column.nulls}/${column.total}), above the ${config.nullWarnPct}% threshold`)
    }
    if (column.total > 1 && column.distinct === 1) lines.push(`\`${column.name}\`: constant column — one distinct value across ${column.total} rows`)
    if (column.distinct > 0 && column.type === 'string' && column.samples.some(entry => classify(entry) !== 'string')) {
      lines.push(`\`${column.name}\`: mixed values — typed string because kinds disagree`)
    }
  }
  return lines
}

/**
 * Render the markdown report.
 * @param profile - a validated profile.
 * @param config - deployment knobs.
 * @param title - caller-supplied heading.
 * @returns markdown text.
 */
function renderMarkdown(profile: ProfileResult, config: Config, title: string): string {
  const heading = title.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Data Profile'
  const cells = profile.rows * profile.columns.length
  const missing = profile.columns.reduce((sum, column) => sum + column.nulls, 0)
  const lines: string[] = []
  lines.push(`## ${heading}`, '')
  lines.push(`- Source: ${profile.source}`)
  lines.push(`- Rows: ${profile.rows}`)
  lines.push(`- Columns: ${profile.columns.length}`)
  lines.push(`- Null cells: ${missing} of ${cells} (${percent(missing, cells)}%)`)
  if (profile.note.length > 0) lines.push(`- Note: ${mdCell(profile.note)}`)
  lines.push('')
  lines.push('| Column | Type | Nulls | Null % | Distinct | Min | Max | Samples |')
  lines.push('| --- | --- | ---: | ---: | ---: | --- | --- | --- |')
  for (const column of profile.columns) {
    lines.push(
      `| ${mdCell(column.name)} | ${column.type} | ${column.nulls} | ${column.nullPct} | ${column.distinct} `
      + `| ${mdCell(column.min) || '—'} | ${mdCell(column.max) || '—'} | ${mdCell(column.samples.join(', ')) || '—'} |`,
    )
  }
  lines.push('')
  const issues = findings(profile, config)
  if (issues.length === 0) {
    lines.push('### Findings', '', 'No data-quality issues above the configured thresholds.')
  } else {
    lines.push('### Findings', '', ...issues.map(entry => `- ${entry}`))
  }
  return `${lines.join('\n')}\n`
}

/**
 * Short plain-text digest of a profile, for the model-facing render.
 * @param value - a successful profile.
 * @returns one line per column.
 */
function textDigest(value: ProfileResult): string {
  const head = `${value.source}: ${value.rows} rows x ${value.columns.length} columns`
  const body = value.columns.map(column =>
    `- ${column.name}: ${column.type}, null ${column.nulls} (${column.nullPct}%), distinct ${column.distinct}`
    + `, min ${column.min === '' ? '—' : column.min}, max ${column.max === '' ? '—' : column.max}`
    + `${column.samples.length === 0 ? '' : `, samples [${column.samples.join(', ')}]`}`)
  const note = value.note.length === 0 ? [] : [`note: ${value.note}`]
  return [head, ...body, ...note].join('\n')
}

/** Output schema shared by both profilers. `satisfies` keeps the literal
 *  schema types so `defineTool` can infer the exact return value. */
const PROFILE_PROPERTIES = {
  ok: { type: 'boolean', required: true, description: 'Whether the input could be profiled.' },
  error: { type: 'string', required: true, description: 'Why profiling failed; empty when ok is true.' },
  note: { type: 'string', required: true, description: 'Advisory text such as dropped columns; empty when nothing to report.' },
  source: { type: 'string', required: true, description: 'Which tool produced this profile: csv or json.' },
  rows: { type: 'integer', required: true, description: 'Number of data rows profiled (header excluded).' },
  columns: {
    type: 'array',
    required: true,
    description: 'One entry per column, in document order.',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', required: true, description: 'Column name, or col<N> when the input was headerless.' },
        type: { type: 'string', required: true, description: 'Inferred kind: number, date, boolean, or string.' },
        total: { type: 'integer', required: true, description: 'Cells examined in this column.' },
        nulls: { type: 'integer', required: true, description: 'Cells treated as missing.' },
        nullPct: { type: 'number', required: true, description: 'Missing share of the column, in percent (0-100, two decimals).' },
        distinct: { type: 'integer', required: true, description: 'Count of different non-null values.' },
        min: { type: 'string', required: true, description: 'Smallest value: numeric compare for number columns, otherwise code-unit order; empty when all null.' },
        max: { type: 'string', required: true, description: 'Largest value, using the same comparison as min; empty when all null.' },
        samples: { type: 'array', required: true, description: 'First distinct values in appearance order.', items: { type: 'string' } },
      },
    },
  },
} satisfies ParameterSchemaSpec

/**
 * Register the profiling tools on `ctx.tools`.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - deployment's explicit profiler policy.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'profile_csv',
    description:
      'Profile CSV text supplied inline (paste the file contents — this tool reads no files). '
      + 'Returns one entry per column with an inferred type (number, date, boolean, or string), '
      + 'null count and percentage, distinct count, min, max, and a few sample values. '
      + 'Pass hasHeader=false when the first line is data.',
    parameters: {
      csvText: { type: 'string', required: true, description: 'The complete CSV document, including the header line.' },
      hasHeader: { type: 'boolean', description: 'Whether line 1 holds column names. Defaults to true.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: PROFILE_PROPERTIES },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok ? textDigest(value) : `profile_csv could not profile the input: ${value.error}`,
      }],
    },
    isConcurrencySafe: () => true,
    execute(args) {
      return Promise.resolve(profileCsv(args.csvText, args.hasHeader, config))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'profile_json',
    description:
      'Profile JSON text: an array of objects (one record per element), a single object, or an '
      + 'array of scalars. Column names are the union of keys in first-seen order; missing keys '
      + 'count as null and nested objects or arrays are compared as compact JSON. Same per-column '
      + 'shape as profile_csv: inferred type, null percentage, distinct, min, max, samples.',
    parameters: {
      jsonText: { type: 'string', required: true, description: 'The JSON document to profile.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: PROFILE_PROPERTIES },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok ? textDigest(value) : `profile_json could not profile the input: ${value.error}`,
      }],
    },
    isConcurrencySafe: () => true,
    execute(args) {
      return Promise.resolve(profileJson(args.jsonText, config))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'profile_report',
    description:
      'Turn a profile produced by profile_csv or profile_json into a markdown report: a summary, '
      + 'a per-column table, and data-quality findings (columns over the configured null threshold, '
      + 'constant columns, candidate keys, and mixed-type columns). Pass the earlier tool result '
      + 'object verbatim as `profile`.',
    parameters: {
      profile: {
        type: 'json',
        required: true,
        description: 'The canonical profile object returned by profile_csv or profile_json.',
      },
      title: { type: 'string', description: 'Report heading. Defaults to "Data Profile".' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: 'Whether a report could be built from the supplied profile.' },
          error: { type: 'string', required: true, description: 'Why the report failed; empty when ok is true.' },
          markdown: { type: 'string', required: true, description: 'The full markdown report; empty when ok is false.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok ? value.markdown : `profile_report failed: ${value.error}`,
      }],
    },
    isConcurrencySafe: () => true,
    execute(args) {
      const profile = readProfile(args.profile)
      if (profile === null) {
        return Promise.resolve({
          ok: false,
          error: 'profile must be an object with a "columns" array, exactly as returned by profile_csv or profile_json',
          markdown: '',
        })
      }
      return Promise.resolve({
        ok: true,
        error: '',
        markdown: renderMarkdown(profile, config, args.title ?? ''),
      })
    },
  }))
}
