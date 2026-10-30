import { MATCH_LAYOUTS } from '../../game/levels/matchLayouts';
import { LevelPreview } from './LevelPreview';

/** Выбор кона для матча: мини-схема, название и описание каждой расстановки. */
export function LayoutPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  return (
    <div className="layout-picker" role="radiogroup" aria-label="Расстановка асыков">
      {MATCH_LAYOUTS.map((l) => (
        <label key={l.id} className={`layout-option${value === l.id ? ' layout-option--on' : ''}`}>
          <input type="radio" name="layout" value={l.id} checked={value === l.id} onChange={() => onChange(l.id)} className="sr-only" />
          <span className="layout-option__preview">
            <LevelPreview level={l} />
          </span>
          <span className="layout-option__body">
            <b>
              {l.name} <small>{l.kazName}</small>
            </b>
            <span>{l.description}</span>
          </span>
        </label>
      ))}
    </div>
  );
}
