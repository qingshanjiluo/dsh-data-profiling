import { describe, expect, it } from 'vitest'
import { apply, Config, inject, name } from '../src/index.ts'

interface RegisteredTool {
  name: string
  execute(args: never, exec: never): Promise<unknown>
  output: { render(args: never, value: never): unknown[] }
}

interface PluginConfig {
  sampleSize: number
  maxColumns: number
  nullWarnPct: number
}

const DEFAULTS: PluginConfig = { sampleSize: 3, maxColumns: 50, nullWarnPct: 20 }

/** Mount the plugin against a stub registry and return what it registered. */
function mount(config: Partial<PluginConfig> = {}): RegisteredTool[] {
  const registered: RegisteredTool[] = []
  const ctx = { tools: { register: (def: RegisteredTool) => registered.push(def) } }
  // The plugin only reads ctx.tools; a partial stub is the real surface it touches.
  apply(ctx as never, { ...DEFAULTS, ...config } as never)
  return registered
}

/** Look up one registered tool by name. */
function tool(toolName: string, config: Partial<PluginConfig> = {}): RegisteredTool {
  const found = mount(config).find(entry => entry.name === toolName)
  if (found === undefined) throw new Error(`${toolName} is not registered`)
  return found
}

/** Call a tool through its validating wrapper with a stub execution context. */
async function call<T>(target: RegisteredTool, args: Record<string, unknown>): Promise<T> {
  return await target.execute(args as never, {} as never) as T
}

interface Profile {
  ok: boolean
  error: string
  note: string
  source: string
  rows: number
  columns: {
    name: string
    type: string
    total: number
    nulls: number
    nullPct: number
    distinct: number
    min: string
    max: string
    samples: string[]
  }[]
}

interface Report {
  ok: boolean
  error: string
  markdown: string
}

type Column = Profile['columns'][number]

function column(profile: Profile, columnName: string): Column {
  const found = profile.columns.find(entry => entry.name === columnName)
  if (found === undefined) throw new Error(`column ${columnName} missing from ${JSON.stringify(profile.columns)}`)
  return found
}

const SAMPLE_CSV
  = 'name,age,joined,active\n'
  + 'alice,30,2024-01-05,true\n'
  + 'bob,25,2024-02-11,false\n'
  + 'carol,,2024-03-01,true\n'
  + ',40,2024-04-02,no\n'

describe('dsh-data-profiling plugin contract', () => {
  it('exports the loader plugin face', () => {
    expect(name).toBe('dsh-data-profiling')
    expect(inject).toEqual(['tools'])
    expect(typeof apply).toBe('function')
    expect(Config).toBeInstanceOf(Object)
  })

  it('registers exactly the three documented tools', () => {
    expect(mount().map(entry => entry.name)).toEqual(['profile_csv', 'profile_json', 'profile_report'])
  })
})

describe('profile_csv', () => {
  it('infers per-column types and stats from a header row', async () => {
    const profile = await call<Profile>(tool('profile_csv'), { csvText: SAMPLE_CSV })
    expect(profile.ok).toBe(true)
    expect(profile.error).toBe('')
    expect(profile.note).toBe('')
    expect(profile.source).toBe('csv')
    expect(profile.rows).toBe(4)
    expect(profile.columns.map(entry => entry.name)).toEqual(['name', 'age', 'joined', 'active'])
    expect(column(profile, 'name').type).toBe('string')
    expect(column(profile, 'age').type).toBe('number')
    expect(column(profile, 'joined').type).toBe('date')
    expect(column(profile, 'active').type).toBe('boolean')
    expect(column(profile, 'age').total).toBe(4)
    expect(column(profile, 'age').nulls).toBe(1)
    expect(column(profile, 'age').nullPct).toBe(25)
    expect(column(profile, 'age').distinct).toBe(3)
    expect(column(profile, 'age').min).toBe('25')
    expect(column(profile, 'age').max).toBe('40')
    expect(column(profile, 'name').samples).toEqual(['alice', 'bob', 'carol'])
  })

  it('names columns positionally when hasHeader is false and compares numbers numerically', async () => {
    const profile = await call<Profile>(tool('profile_csv'), { csvText: '9\n10\n2\n', hasHeader: false })
    expect(profile.rows).toBe(3)
    expect(profile.columns.map(entry => entry.name)).toEqual(['col1'])
    expect(column(profile, 'col1').type).toBe('number')
    // Code-unit order would rank "9" above "10"; numeric order does not.
    expect(column(profile, 'col1').min).toBe('2')
    expect(column(profile, 'col1').max).toBe('10')
  })

  it('honours quoting, embedded delimiters, and embedded newlines', async () => {
    const csv = 'city,note\n"Paris","says ""hi"", loudly"\n"Oslo","line one\nline two"\n'
    const profile = await call<Profile>(tool('profile_csv'), { csvText: csv })
    expect(profile.rows).toBe(2)
    expect(column(profile, 'city').samples).toEqual(['Paris', 'Oslo'])
    expect(column(profile, 'note').distinct).toBe(2)
    expect(column(profile, 'note').samples[0]).toBe('says "hi", loudly')
  })

  it('treats placeholder text as missing and a disagreeing column as string', async () => {
    const profile = await call<Profile>(tool('profile_csv'), { csvText: 'id,value\n1,N/A\n2,7\n3,x\n' })
    expect(column(profile, 'value').nulls).toBe(1)
    expect(column(profile, 'value').nullPct).toBe(33.33)
    expect(column(profile, 'value').type).toBe('string')
    expect(column(profile, 'id').type).toBe('number')
  })

  it('fails cleanly on empty input instead of throwing', async () => {
    const profile = await call<Profile>(tool('profile_csv'), { csvText: '   \n  \n' })
    expect(profile.ok).toBe(false)
    expect(profile.error.length).toBeGreaterThan(0)
    expect(profile.rows).toBe(0)
    expect(profile.columns).toEqual([])
  })

  it('caps columns and samples from config', async () => {
    const profile = await call<Profile>(tool('profile_csv', { maxColumns: 2, sampleSize: 1 }), { csvText: 'a,b,c\n1,2,3\n4,5,6\n' })
    expect(profile.columns.map(entry => entry.name)).toEqual(['a', 'b'])
    expect(profile.note).toContain('1 of 3 columns were skipped')
    expect(column(profile, 'a').samples).toEqual(['1'])
  })

  it('renders a model-facing text block', () => {
    const blocks = tool('profile_csv').output.render({ csvText: '' } as never, {
      ok: true, error: '', note: '', source: 'csv', rows: 2,
      columns: [{ name: 'age', type: 'number', total: 2, nulls: 0, nullPct: 0, distinct: 2, min: '1', max: '2', samples: ['1', '2'] }],
    } as never) as { type: string; text: string }[]
    expect(blocks[0].type).toBe('text')
    expect(blocks[0].text).toContain('age: number')
  })
})

describe('profile_json', () => {
  it('profiles an array of objects, unioning keys in first-seen order', async () => {
    const json = JSON.stringify([
      { id: 1, tags: ['a', 'b'], score: 9.5 },
      { id: 2, tags: [], city: 'Oslo' },
      { id: 3, city: null },
    ])
    const profile = await call<Profile>(tool('profile_json'), { jsonText: json })
    expect(profile.ok).toBe(true)
    expect(profile.source).toBe('json')
    expect(profile.rows).toBe(3)
    expect(profile.columns.map(entry => entry.name)).toEqual(['id', 'tags', 'score', 'city'])
    expect(column(profile, 'id').type).toBe('number')
    expect(column(profile, 'id').min).toBe('1')
    expect(column(profile, 'id').max).toBe('3')
    expect(column(profile, 'score').nulls).toBe(2)
    expect(column(profile, 'score').nullPct).toBe(66.67)
    expect(column(profile, 'city').nullPct).toBe(66.67)
    expect(column(profile, 'tags').samples[0]).toBe('["a","b"]')
    expect(column(profile, 'tags').type).toBe('string')
  })

  it('accepts a single object and an array of scalars', async () => {
    const single = await call<Profile>(tool('profile_json'), { jsonText: '{"a": 1, "b": false}' })
    expect(single.rows).toBe(1)
    expect(single.columns.map(entry => entry.name)).toEqual(['a', 'b'])
    expect(column(single, 'b').type).toBe('boolean')
    const scalars = await call<Profile>(tool('profile_json'), { jsonText: '[1, 2, 3]' })
    expect(scalars.columns.map(entry => entry.name)).toEqual(['value'])
    expect(column(scalars, 'value').type).toBe('number')
    expect(column(scalars, 'value').samples).toEqual(['1', '2', '3'])
  })

  it('reports invalid JSON and an empty array as failures', async () => {
    const broken = await call<Profile>(tool('profile_json'), { jsonText: '{"a": ' })
    expect(broken.ok).toBe(false)
    expect(broken.error).toContain('invalid JSON')
    expect(broken.columns).toEqual([])
    const empty = await call<Profile>(tool('profile_json'), { jsonText: '[]' })
    expect(empty.ok).toBe(false)
    expect(empty.error).toContain('no data')
  })

  it('renders a model-facing text block', () => {
    const blocks = tool('profile_json').output.render({ jsonText: '' } as never, {
      ok: false, error: 'invalid JSON: boom', note: '', source: 'json', rows: 0, columns: [],
    } as never) as { type: string; text: string }[]
    expect(blocks[0].type).toBe('text')
    expect(blocks[0].text).toContain('invalid JSON')
  })
})

describe('profile_report', () => {
  it('renders a markdown table and flags columns over the null threshold', async () => {
    const profile = await call<Profile>(tool('profile_csv'), { csvText: SAMPLE_CSV })
    const report = await call<Report>(tool('profile_report'), { profile })
    expect(report.ok).toBe(true)
    expect(report.error).toBe('')
    expect(report.markdown).toContain('## Data Profile')
    expect(report.markdown).toContain('- Source: csv')
    expect(report.markdown).toContain('- Rows: 4')
    expect(report.markdown).toContain('- Columns: 4')
    expect(report.markdown).toContain('- Null cells: 2 of 16 (12.5%)')
    expect(report.markdown).toContain('| Column | Type | Nulls | Null % | Distinct | Min | Max | Samples |')
    expect(report.markdown).toContain('| age | number | 1 | 25 | 3 | 25 | 40 | 30, 25, 40 |')
    expect(report.markdown).toContain('| joined | date | 0 | 0 | 4 | 2024-01-05 | 2024-04-02 | 2024-01-05, 2024-02-11, 2024-03-01 |')
    expect(report.markdown).toContain('### Findings')
    expect(report.markdown).toContain('`age`: 25% null (1/4), above the 20% threshold')
  })

  it('reports a clean profile and honours a flattened custom title', async () => {
    const profile = await call<Profile>(tool('profile_csv'), { csvText: 'a,b\n1,x\n2,z\n' })
    const report = await call<Report>(tool('profile_report', { nullWarnPct: 90 }), { profile, title: 'Sales 2024\nsecond line' })
    expect(report.markdown).toContain('## Sales 2024 second line')
    expect(report.markdown).toContain('No data-quality issues above the configured thresholds.')
  })

  it('flags constant columns and reads the configured threshold', async () => {
    const profile = await call<Profile>(tool('profile_csv'), { csvText: 'k,v,m\n1,same,7\n,,txt\n' })
    const report = await call<Report>(tool('profile_report', { nullWarnPct: 0 }), { profile })
    expect(report.markdown).toContain('`v`: constant column')
    expect(report.markdown).toContain('above the 0% threshold')
    expect(report.markdown).toContain('`m`: mixed values')
  })

  it('escapes pipes so a value cannot break the table', async () => {
    const profile = await call<Profile>(tool('profile_csv'), { csvText: 'expr\n1|2\n3|4\n' })
    const report = await call<Report>(tool('profile_report'), { profile })
    expect(report.markdown).toContain('1\\|2')
    expect(report.markdown.split('\n').filter(entry => entry.startsWith('|')).length).toBe(3)
  })

  it('rejects input that is not a profile without throwing', async () => {
    const notAProfile = await call<Report>(tool('profile_report'), { profile: 'nope' })
    expect(notAProfile.ok).toBe(false)
    expect(notAProfile.markdown).toBe('')
    expect(notAProfile.error).toContain('columns')
    const missingColumns = await call<Report>(tool('profile_report'), { profile: { rows: 2 } })
    expect(missingColumns.ok).toBe(false)
  })

  it('renders a model-facing text block', () => {
    const blocks = tool('profile_report').output.render({ profile: {} } as never, {
      ok: true, error: '', markdown: '## Hi',
    } as never) as { type: string; text: string }[]
    expect(blocks[0]).toEqual({ type: 'text', text: '## Hi' })
  })
})

describe('pipeline and determinism', () => {
  it('round-trips a profile through JSON text', async () => {
    const csvProfile = await call<Profile>(tool('profile_csv'), { csvText: 'x,y\n1,2\n3,4\n' })
    const roundTrip = await call<Profile>(tool('profile_json'), { jsonText: JSON.stringify(csvProfile) })
    expect(roundTrip.ok).toBe(true)
    expect(roundTrip.rows).toBe(1)
    expect(roundTrip.columns.map(entry => entry.name)).toEqual(['ok', 'error', 'note', 'source', 'rows', 'columns'])
    const report = await call<Report>(tool('profile_report'), { profile: csvProfile })
    expect(report.ok).toBe(true)
    expect(report.markdown).toContain('- Columns: 2')
  })

  it('is deterministic for identical input and for nested key order', async () => {
    const first = await call<Profile>(tool('profile_csv'), { csvText: SAMPLE_CSV })
    const second = await call<Profile>(tool('profile_csv'), { csvText: SAMPLE_CSV })
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    const jsonA = await call<Profile>(tool('profile_json'), { jsonText: '[{"v":{"b":1,"a":2}}]' })
    const jsonB = await call<Profile>(tool('profile_json'), { jsonText: '[{"v":{"a":2,"b":1}}]' })
    expect(column(jsonA, 'v').samples).toEqual(column(jsonB, 'v').samples)
    expect(column(jsonA, 'v').samples[0]).toBe('{"a":2,"b":1}')
  })
})
