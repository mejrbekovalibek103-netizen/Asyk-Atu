import { getMatchLayout, isGrowingLayout, layoutSizes, MATCH_LAYOUTS } from '../../game/levels/matchLayouts';
import { plural } from '../format';
import { LevelPreview } from './LevelPreview';

/**
 * Сколько асыков на растущем коне: для известного числа игроков — одно число (`growth` — с пояснением, что кон
 * растёт: в онлайне), иначе — для 2, 3 и 4.
 */
export function growingSizeText(id: string, players?: number, growth = true): string | null {
  if (!isGrowingLayout(id)) return null;
  if (players && players >= 2) {
    const n = getMatchLayout(id, players).asyks.length;
    const asyks = `${n} ${plural(n, ['асык', 'асыка', 'асыков'])}`;
    return growth ? `${asyks} для ${players} игроков — с каждым игроком кон растёт` : asyks;
  }
  const [a, b, c] = layoutSizes(id);
  return `Растёт с числом игроков: ${a} / ${b} / ${c} асыков для 2 / 3 / 4`;
}

/**
 * Выбор кона для матча: мини-схема, название и описание каждой расстановки. `players` — сколько игроков за столом
 * (растущие коны показываются в нужном размере); не задано — в виде для двоих, с подписью о росте.
 */
export function LayoutPicker({
  value,
  onChange,
  players,
  growth = true,
}: {
  value: string;
  onChange: (id: string) => void;
  players?: number;
  /** Пояснять, что кон растёт с числом игроков (на одном устройстве игроков всегда двое — не нужно). */
  growth?: boolean;
}) {
  return (
    <div className="layout-picker" role="radiogroup" aria-label="Расстановка асыков">
      {MATCH_LAYOUTS.map((base) => {
        const l = players ? getMatchLayout(base.id, players) : base;
        const size = growingSizeText(l.id, players, growth);
        return (
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
              {size && <span className="layout-option__size">{size}</span>}
            </span>
          </label>
        );
      })}
    </div>
  );
}
