import { DAY_NAMES, formatClock, parseClock, type Schedule } from '@shared/schedule'
import { useT } from '../i18n'
import Select from './Select'

type Props = {
  value: Schedule
  onChange(next: Schedule): void
}

/**
 * Monday first. A week starting on Sunday reads wrong to most of the world,
 * and this app ships in two languages.
 */
const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0]

/** Intervals people actually want, rather than a free-text minute count. */
const INTERVALS: Array<{ value: string; label: string }> = [
  { value: '5', label: 'Every 5 minutes' },
  { value: '15', label: 'Every 15 minutes' },
  { value: '30', label: 'Every 30 minutes' },
  { value: '60', label: 'Every hour' },
  { value: '120', label: 'Every 2 hours' },
  { value: '240', label: 'Every 4 hours' },
  { value: '480', label: 'Every 8 hours' },
  { value: '720', label: 'Every 12 hours' },
  { value: '1440', label: 'Every day' }
]

/**
 * The "when" half of the task editor.
 *
 * Each schedule kind shows only its own controls: an interval needs no time of
 * day, and a weekday picker on a task that runs every ten minutes is noise.
 */
export default function ScheduleFields({ value, onChange }: Props) {
  const t = useT()

  return (
    <>
      <div className="row">
        <div className="field">
          <label>{t('Repeat')}</label>
          <Select
            value={value.kind}
            onChange={(kind) => onChange(switchKind(value, kind))}
            options={[
              { value: 'interval', label: t('On a timer'), hint: t('Every N minutes or hours') },
              { value: 'daily', label: t('Every day'), hint: t('At a time you choose') },
              { value: 'weekly', label: t('Certain days'), hint: t('Weekdays at a set time') },
              { value: 'once', label: t('Once'), hint: t('A single run, then done') }
            ]}
          />
        </div>

        {value.kind === 'interval' && (
          <div className="field">
            <label>{t('How often')}</label>
            <Select
              value={String(value.everyMinutes)}
              onChange={(minutes) => onChange({ kind: 'interval', everyMinutes: Number(minutes) })}
              options={INTERVALS.map((option) => ({ ...option, label: t(option.label) }))}
            />
          </div>
        )}

        {(value.kind === 'daily' || value.kind === 'weekly') && (
          <div className="field narrow">
            <label>{t('At')}</label>
            <input
              className="input mono"
              type="time"
              value={formatClock(value.atMinutes)}
              onChange={(event) => {
                const minutes = parseClock(event.target.value)
                if (minutes !== null) onChange({ ...value, atMinutes: minutes })
              }}
            />
          </div>
        )}

        {value.kind === 'once' && (
          <div className="field">
            <label>{t('When')}</label>
            <input
              className="input mono"
              type="datetime-local"
              value={toLocalInput(value.atEpochMs)}
              onChange={(event) => {
                const parsed = Date.parse(event.target.value)
                if (Number.isFinite(parsed)) onChange({ kind: 'once', atEpochMs: parsed })
              }}
            />
          </div>
        )}
      </div>

      {value.kind === 'weekly' && (
        <div className="field">
          <label>{t('On these days')}</label>
          <div className="day-picker">
            {MONDAY_FIRST.map((day) => {
              const active = value.days.includes(day)

              return (
                <button
                  key={day}
                  type="button"
                  className={`day-chip ${active ? 'active' : ''}`}
                  aria-pressed={active}
                  onClick={() =>
                    onChange({
                      ...value,
                      days: active
                        ? value.days.filter((entry) => entry !== day)
                        : [...value.days, day]
                    })
                  }
                >
                  {t(DAY_NAMES[day])}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </>
  )
}

/** Keeps whatever the new kind can reuse, so switching back and forth is lossless. */
function switchKind(current: Schedule, kind: Schedule['kind']): Schedule {
  const atMinutes = 'atMinutes' in current ? current.atMinutes : 9 * 60

  switch (kind) {
    case 'interval':
      return { kind: 'interval', everyMinutes: 60 }
    case 'daily':
      return { kind: 'daily', atMinutes }
    case 'weekly':
      return {
        kind: 'weekly',
        atMinutes,
        // Weekdays, because a task you set up on a Tuesday afternoon almost
        // never means "and also both weekend days".
        days: current.kind === 'weekly' ? current.days : [1, 2, 3, 4, 5]
      }
    case 'once':
      // An hour out: far enough to edit the rest of the form first.
      return { kind: 'once', atEpochMs: Date.now() + 60 * 60_000 }
  }
}

/** `datetime-local` wants local time with no zone, which toISOString will not give. */
function toLocalInput(epochMs: number): string {
  const date = new Date(epochMs)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}
