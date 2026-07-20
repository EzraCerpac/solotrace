import { Icon } from './Icon'
import type { ProcessingRun } from '../types'

export function PipelineStrip({
  run,
  onCancel,
}: {
  run: ProcessingRun
  onCancel: () => void
}) {
  if (run.state === 'complete') return null
  return (
    <section
      className={`pipeline-strip ${run.state}`}
      aria-live="polite"
      aria-label="Draft progress"
    >
      <div className="pipeline-message">
        <Icon name={run.state === 'failed' ? 'warning' : 'spark'} />
        <div>
          <strong>{run.message}</strong>
          {run.error && <span>{run.error}</span>}
        </div>
        {['queued', 'running'].includes(run.state) && (
          <button type="button" className="button secondary" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      <ol>
        {run.stages.map((stage) => (
          <li key={stage.id} data-status={stage.status}>
            <span className="stage-dot">
              {stage.status === 'complete' ? <Icon name="check" /> : null}
            </span>
            <span>
              {stage.label}
              {stage.detail && <small>{stage.detail}</small>}
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}
