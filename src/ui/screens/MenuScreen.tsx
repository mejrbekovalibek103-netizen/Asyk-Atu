import { LEVELS } from '../../game/levels/levels';
import type { SaveData } from '../../storage/progress';
import { HeroScene } from '../components/HeroScene';
import { Icon } from '../components/Icon';
import { Ornament } from '../components/Ornament';
import type { Route } from '../routes';

interface Props {
  save: SaveData;
  muted: boolean;
  onToggleMute: () => void;
  onNavigate: (r: Route) => void;
}

export function MenuScreen({ save, muted, onToggleMute, onNavigate }: Props) {
  const passed = LEVELS.filter((l) => save.levels[l.id]?.passed).length;
  const played = save.stats.roundsPlayed > 0;

  return (
    <main className="page page--menu">
      <div className="menu__top">
        <Ornament className="menu__ornament" width={84} />
        <button className="icon-btn icon-btn--light" onClick={onToggleMute} aria-label={muted ? 'Включить звук' : 'Выключить звук'} aria-pressed={muted}>
          <Icon name={muted ? 'mute' : 'sound'} />
        </button>
      </div>

      <section className="menu">
        <div className="menu__text">
          <p className="kicker">Дәстүрлі ойын · традиционная игра</p>
          <h1 className="title">Асық ату</h1>
          <p className="subtitle">Прицелься. Брось. Выбей асық.</p>
          <p className="lead">Попробуй современную версию традиционной казахской игры на меткость: сам тянешь сақа, выбираешь силу и сбиваешь асыки с кона.</p>

          <div className="menu__actions">
            <button className="btn btn--primary btn--xl" onClick={() => onNavigate({ name: 'LEVEL_SELECT' })}>
              <Icon name="play" /> Играть
            </button>
            <button className="btn btn--duel" onClick={() => onNavigate({ name: 'MATCH_SETUP' })}>
              <Icon name="users" /> Игра вдвоём
            </button>
            <div className="menu__secondary">
              <button className="btn" onClick={() => onNavigate({ name: 'HOW_TO' })}>
                <Icon name="help" /> Как играть
              </button>
              <button className="btn" onClick={() => onNavigate({ name: 'RECORDS' })}>
                <Icon name="trophy" /> Рекорды
              </button>
            </div>
          </div>

          {played && (
            <p className="menu__progress">
              Лучший результат: <b>{save.stats.bestScore}</b> · Пройдено испытаний: <b>{passed}</b> из {LEVELS.length}
            </p>
          )}
        </div>

        <div className="menu__visual">
          <HeroScene />
          <aside className="fact-card">
            <Ornament className="fact-card__ornament" width={96} />
            <p>
              <b>Сақа</b> — главный асык игрока. Его часто красили и утяжеляли свинцом («құйма сақа»), чтобы бить точнее и сильнее.
            </p>
            <button className="link-btn" onClick={() => onNavigate({ name: 'ABOUT' })}>
              Об игре и традиции →
            </button>
          </aside>
        </div>
      </section>

      <footer className="menu__footer">Цифровая адаптация традиционной казахской игры · 2026</footer>
    </main>
  );
}
