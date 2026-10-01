import type { TutorialStep } from '../../game/types';

const STEPS: TutorialStep[] = ['grab', 'drag', 'release', 'watch'];

const isTouch = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;

function text(step: TutorialStep): { title: string; body: string } {
  switch (step) {
    case 'grab':
      return {
        title: isTouch ? 'Коснись руки с сақа' : 'Зажми сақа в руке',
        body: isTouch ? 'Палец на руке внизу экрана — и не отпускай.' : 'Наведи курсор на руку внизу и зажми кнопку мыши.',
      };
    case 'drag':
      return {
        title: 'Тяни к асыкам',
        body: 'Направление — куда тянешь. Пунктир показывает путь сақа.',
      };
    case 'release':
      return {
        title: 'Дальше — сильнее. Отпускай!',
        body: 'Кружок — где сақа остановится без столкновений. Целься за асык.',
      };
    case 'watch':
      return { title: 'Бросок!', body: 'Асык, вылетевший за меловую линию кона, — выбит.' };
  }
}

/** Короткое интерактивное обучение: шаги переключаются реальными действиями игрока. */
export function TutorialCoach({ step, x, y, pointer }: { step: TutorialStep; x: number; y: number; pointer: boolean }) {
  const t = text(step);
  const idx = STEPS.indexOf(step);
  return (
    <div className="coach" style={{ left: x, top: y }} role="status" aria-live="polite">
      <div className="coach__head">
        <span className="coach__badge">Пробный бросок</span>
        <span className="coach__dots" aria-hidden="true">
          {STEPS.map((s, i) => (
            <i key={s} className={i <= idx ? 'on' : ''} />
          ))}
        </span>
      </div>
      <strong className="coach__title">{t.title}</strong>
      <p className="coach__body">{t.body}</p>
      {pointer && <span className="coach__arrow" aria-hidden="true" />}
    </div>
  );
}
