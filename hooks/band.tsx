import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import type { Mode, Spend } from '../types'
import { day, fresh, thresholds } from './accounting'
import { compactNow } from './compaction'
import type { Runtime } from './runtime'
import { safe, texts } from './runtime'
import { readCompacting, readFailing, readSpend } from './state'
import type { Texts } from './texts'
import { short } from './texts'

const LEVELS = '▁▂▃▄▅▆▇█'

function sparkline(values: number[]): string {
  const largest = Math.max(1, ...values)

  return values.map(v => LEVELS[Math.min(LEVELS.length - 1, Math.floor((v / largest) * LEVELS.length))]).join('')
}

function color(pct: number): string {
  if (pct >= 85) return 'red'
  if (pct >= 60) return 'yellow'

  return 'green'
}

function contextColor(tokens: number, window: number | null): string {
  const t = thresholds(window)
  if (tokens >= t.switch) return 'red'
  if (tokens >= t.warn) return 'yellow'

  return 'green'
}

type AbovePrompt = RenderInput<'AbovePrompt'>

/** The band, or null when there is nothing to show yet (or no data to show it with). */
export async function drawBand($: EngineInterface, e: AbovePrompt, rt: Runtime): Promise<RenderElement | null> {
  let s: Spend | null
  let t: Texts
  let now: number
  let running: Mode | null
  let stale: boolean
  try {
    s = await readSpend($)
    t = await texts($, rt)
    now = await $.clock.now()
    running = await readCompacting($)
    stale = (await readFailing($)) !== null
  } catch {
    // Without the data the band has nothing to show: the chain goes on without it.
    return null
  }
  if (e.props.hasSurvey || s === null) return null

  const ss = s.session
  const inputTotal = ss.input + ss.cacheRead + ss.cacheWrite
  if (inputTotal + ss.output === 0 && s.today === 0 && s.limits.length === 0 && s.context === null && !stale) return null

  const { Box, Button, Text } = $.ui.resolve(e)
  const k = (n: number) => short(n, t.decimal)
  const busy = e.props.isWorking || running !== null
  const cache = inputTotal > 0 ? Math.round((ss.cacheRead / inputTotal) * 100) : 0
  // Past midnight with no count yet: yesterday's total is not today's.
  const today = s.day === day(now) ? s.today : 0
  const dot = <Text dimColor>  ·  </Text>
  // Before its first response a subagent has no measured context yet.
  const agents = Object.values(s.agents ?? {}).filter(n => n > 0)
  const largest = Math.max(0, ...agents)
  const limit = thresholds(s.window)

  return (
    <Box paddingX={1} flexDirection="row">
      <Text wrap="truncate-end">
        {stale && <Text color="yellow">{`⚠ ${t.stale}  `}</Text>}
        {s.turns.length > 0 && <Text color="cyan">{sparkline(s.turns)}  </Text>}
        <Text bold>{k(fresh(ss))}</Text>
        <Text dimColor> tokens</Text>
        {dot}
        <Text dimColor>↑ </Text>
        <Text>{k(ss.input + ss.cacheWrite)}</Text>
        <Text dimColor>  ↓ </Text>
        <Text>{k(ss.output)}</Text>
        {dot}
        <Text dimColor>cache </Text>
        <Text>{cache}%</Text>
        {dot}
        <Text dimColor>{`${t.today} `}</Text>
        <Text bold>{k(today)}</Text>
        {s.limits.map(l => {
          // The window already rolled over and no new response brought the value: do not show the old one.
          const pct = l.resetsAt && Date.parse(l.resetsAt) <= now ? 0 : l.percentUsed

          return (
            <Text key={l.kind}>
              {dot}
              <Text dimColor>{t.labels[l.kind] ?? l.kind} </Text>
              <Text color={color(pct)}>{Math.round(pct)}%</Text>
            </Text>
          )
        })}
      </Text>
      {/* Outside the truncating text: on a narrow terminal the context is the last to go. */}
      {s.context !== null && (
        <Text>
          {dot}
          <Text dimColor>ctx </Text>
          <Text color={contextColor(s.context, s.window)}>{k(s.context)}</Text>
          {s.window !== null && <Text dimColor>/{k(s.window)}</Text>}
        </Text>
      )}
      {agents.length > 0 && (
        <Text>
          {dot}
          <Text dimColor>{`${agents.length === 1 ? t.agent : t.agents(agents.length)} `}</Text>
          <Text color={contextColor(largest, s.window)}>{k(largest)}</Text>
        </Text>
      )}
      <Text>  </Text>
      {busy ? (
        e.props.isWorking || running === null ? null : <Text dimColor>{t.compacting(running)}</Text>
      ) : (
        <Button
          key="compact"
          label="compact"
          hotkey="c"
          variant={s.context !== null && s.context >= limit.switch ? 'primary' : undefined}
          dimColor={s.context === null || s.context < limit.warn}
          onPress={() => safe($, rt, 'compact', () => compactNow($, rt))}
        />
      )}
    </Box>
  )
}
