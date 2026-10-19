import { goalText, LEVELS } from '../../game/levels/levels';
import { isLevelUnlocked, type SaveData } from '../../storage/progress';
import { Icon } from '../components/Icon';
import { LevelPreview } from '../components/LevelPreview';
import { Stars } from '../components/Stars';
import { plural, timeLimitText } from '../format';
import type { Route } from '../routes';

interface Props {
  save: SaveData;
  onNavigate: (r: Route) => void;
  onBack: () => void;
}

export function LevelSelectScreen({ save, onNavigate, onBack }: Props) {
  const ids = LEVELS.map((l) => l.id);
  const totalStars = LEVELS.reduce((sum, l) => sum + (save.levels[l.id]?.stars ?? 0), 0);

  return (
    <main className="page page--doc">
      <div className="doc doc--wide">
        <button className="back-btn" onClick={onBack}>
          <Icon name="back" /> Назад
        </button>
        <div className="levels__head">
          <div>
            <h1 className="doc__title">Испытания</h1>
            <p className="doc__lead">Каждое испытание — своя расстановка асыков. Выполни цель, чтобы открыть следующее.</p>
          </div>
          <div className="levels__total" aria-label={`Собрано звёзд: ${totalStars} из ${LEVELS.length * 3}`}>
            <Stars value={1} max={1} size={22} /> {totalStars} / {LEVELS.length * 3}
          </div>
        </div>

        <ul className="levels">
          {LEVELS.map((level, i) => {
            const unlocked = isLevelUnlocked(save, ids, level.id);
            const p = save.levels[level.id];
            return (
              <li key={level.id}>
                <button
                  className={`level-card${unlocked ? '' : ' level-card--locked'}`}
                  disabled={!unlocked}
                  onClick={() => onNavigate({ name: 'PLAYING', levelId: level.id })}
                  aria-label={
                    unlocked
                      ? `Испытание ${level.order}: ${level.name}. ${goalText(level)}.${level.timeLimit ? ` Время: ${timeLimitText(level.timeLimit)}.` : ''} ${p ? `Лучший результат ${p.bestScore}, звёзд ${p.stars}` : 'Ещё не сыграно'}`
                      : `Испытание ${level.order}: ${level.name}, закрыто. Пройди «${LEVELS[i - 1].name}»`
                  }
                >
                  <div className="level-card__preview">
                    <LevelPreview level={level} />
                    {!unlocked && (
                      <span className="level-card__lock">
                        <Icon name="lock" size={28} />
                      </span>
                    )}
                  </div>
                  <div className="level-card__body">
                    <span className="level-card__num">{level.order}</span>
                    <h2 className="level-card__name">
                      {level.name} <small>{level.kazName}</small>
                    </h2>
                    <p className="level-card__desc">{level.description}</p>
                    <p className="level-card__goal">
                      🎯 {goalText(level)} · {level.throws} {plural(level.throws, ['бросок', 'броска', 'бросков'])}
                      {level.timeLimit ? <b className="level-card__time"> · ⏱ {timeLimitText(level.timeLimit)}</b> : null}
                    </p>
                    <div className="level-card__meta">
                      <Stars value={p?.stars ?? 0} size={18} />
                      <span>{unlocked ? (p ? `Рекорд: ${p.bestScore}` : 'Новое') : `Пройди «${LEVELS[i - 1].name}»`}</span>
                    </div>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </main>
  );
}
