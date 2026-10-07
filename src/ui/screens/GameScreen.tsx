import { useCallback, useEffect, useState } from 'react';
import { sound } from '../../game/audio/sound';
import { GameEngine } from '../../game/engine/GameEngine';
import { goalText, nextLevelId } from '../../game/levels/levels';
import { SoloRules } from '../../game/rules/SoloRules';
import type { LevelConfig, RoundResult } from '../../game/types';
import type { RecordOutcome } from '../../storage/progress';
import { AsykIcon } from '../components/AsykIcon';
import { Icon } from '../components/Icon';
import { PowerMeter, RotateHint, Toast } from '../game/GameOverlays';
import { useGameEngine, usePauseOnHide } from '../game/useGameEngine';
import type { Route } from '../routes';
import { PauseMenu } from './PauseMenu';
import { ResultOverlay } from './ResultOverlay';
import { TutorialCoach } from './TutorialCoach';

interface Props {
  level: LevelConfig;
  tutorial: boolean;
  muted: boolean;
  reducedMotion: boolean;
  isUnlocked: (levelId: string) => boolean;
  onToggleMute: () => void;
  onRoundComplete: (r: RoundResult) => RecordOutcome;
  onTutorialDone: () => void;
  onNavigate: (r: Route) => void;
}

/** Экран одиночного испытания. */
export function GameScreen(props: Props) {
  const { level, muted } = props;
  const [pauseOpen, setPauseOpen] = useState(false);
  const [result, setResult] = useState<{ result: RoundResult; outcome: RecordOutcome } | null>(null);

  const view = useGameEngine(
    (canvas) =>
      new GameEngine(
        canvas,
        {
          layout: level,
          rules: new SoloRules(level, props.tutorial, (r) => {
            const outcome = props.onRoundComplete(r);
            setResult({ result: r, outcome });
            if (outcome.isNewRecord) window.setTimeout(() => sound.record(), 700);
          }),
          tutorial: props.tutorial,
          reducedMotion: props.reducedMotion,
        },
        {
          onTutorialDone: () => props.onTutorialDone(),
          onPauseRequest: () => setPauseOpen((p) => !p),
        },
      ),
    level,
  );
  const { engine, snap: s, canvasRef } = view;
  const m = s?.mode.kind === 'solo' ? s.mode : null;

  // пауза физики, пока открыто меню паузы или итог раунда
  useEffect(() => {
    engine?.setPaused(pauseOpen || !!result);
  }, [engine, pauseOpen, result]);
  usePauseOnHide(() => setPauseOpen(true), !result);

  const restart = useCallback(() => {
    sound.uiClick();
    setResult(null);
    setPauseOpen(false);
    engine?.restart();
    canvasRef.current?.focus({ preventScroll: true });
  }, [engine, canvasRef]);

  const go = (r: Route) => {
    sound.uiClick();
    props.onNavigate(r);
  };

  // подсказка у руки, пока игрок не взял сақа; дальше — над коном, чтобы не закрывать пунктир
  const coachNearHand = s?.tutorialStep === 'grab';
  const coachPos = coachNearHand ? view.w2s(400, 770) : { x: view.w2s(400, 0).x, y: Math.max(view.size.top + 70, view.w2s(0, 190).y) };
  const next = nextLevelId(level.id);
  const throwsUsed = m?.throwsUsed ?? 0;
  const knocked = m?.knocked ?? 0;
  const score = m?.score ?? 0;

  return (
    <div className="game" ref={view.containerRef}>
      <canvas
        ref={canvasRef}
        className="game__canvas"
        tabIndex={0}
        aria-label={`Игровое поле «${level.name}». Зажми сақа в руке внизу и тяни к асыкам, отпусти для броска. Клавиатура: стрелки влево/вправо — направление, вверх/вниз — сила, пробел — бросок.`}
      />

      <header className="hud" ref={view.hudRef}>
        <div className="hud__bar">
          <button className="icon-btn" onClick={() => setPauseOpen(true)} aria-label="Пауза и меню">
            <Icon name="pause" />
          </button>
          <div className="hud__level">
            <span className="hud__level-name">
              {level.order}. {level.name}
            </span>
            <span className="hud__goal">{goalText(level)}</span>
          </div>
          <div className="hud__stats" aria-live="off">
            <div className="stat" aria-label={`Броски: ${throwsUsed} из ${level.throws}`}>
              <span className="stat__label">Броски</span>
              <span className="stat__value">
                <span className="stat__icons" aria-hidden="true">
                  {Array.from({ length: level.throws }, (_, i) => (
                    <AsykIcon key={i} palette="saka" size={17} ghost={i < throwsUsed} />
                  ))}
                </span>
                <span>
                  {throwsUsed}/{level.throws}
                </span>
              </span>
            </div>
            <div className="stat stat--score" aria-label={`Очки: ${score}`}>
              <span className="stat__label">Очки</span>
              <span className="stat__value" key={score}>
                <b className="bump">{score}</b>
              </span>
            </div>
            <div className="stat" aria-label={`Выбито ${knocked} из ${level.asyks.length}`}>
              <span className="stat__label">Выбито</span>
              <span className="stat__value">
                <span className="stat__icons stat__icons--tray" aria-hidden="true">
                  {level.asyks.map((_, i) => (
                    <AsykIcon key={i} size={15} ghost={i >= knocked} />
                  ))}
                </span>
                {m?.hasTarget && (
                  <span className="stat__target" title={m.targetOut ? 'Синий асык выбит' : 'Синий асык ещё в коне'}>
                    <AsykIcon palette="target" size={18} ghost={!m.targetOut} />
                    <span className="sr-only">{m.targetOut ? 'Синий асык выбит' : 'Синий асык ещё в коне'}</span>
                  </span>
                )}
                <span>
                  {knocked}/{level.asyks.length}
                </span>
              </span>
            </div>
          </div>
          <div className="hud__actions">
            <button className="icon-btn" onClick={props.onToggleMute} aria-label={muted ? 'Включить звук' : 'Выключить звук'} aria-pressed={muted}>
              <Icon name={muted ? 'mute' : 'sound'} />
            </button>
            <button className="icon-btn" onClick={restart} aria-label="Начать раунд заново">
              <Icon name="restart" />
            </button>
          </div>
        </div>
      </header>

      <Toast message={s?.message ?? null} top={view.size.top} />
      {/* объявления для скринридеров */}
      <div className="sr-only" aria-live="polite">
        {m?.lastThrow && !m.lastThrow.practice ? `Бросок ${m.lastThrow.index}: выбито ${m.lastThrow.knocked}. Очки: ${score}.` : ''}
      </div>

      <PowerMeter view={view} power={s?.power ?? 0} aiming={!!s?.aiming} />

      {s?.tutorialStep && !pauseOpen && <TutorialCoach step={s.tutorialStep} x={coachPos.x} y={coachPos.y} pointer={coachNearHand} />}

      <RotateHint view={view} hidden={!!result} />

      {pauseOpen && !result && (
        <PauseMenu
          muted={muted}
          onResume={() => {
            sound.uiClick();
            setPauseOpen(false);
            canvasRef.current?.focus({ preventScroll: true });
          }}
          onRestart={restart}
          onToggleMute={props.onToggleMute}
          onLevels={() => go({ name: 'LEVEL_SELECT' })}
          onHowTo={() => go({ name: 'HOW_TO' })}
          onHome={() => go({ name: 'MENU' })}
        />
      )}

      {result && (
        <ResultOverlay
          level={level}
          result={result.result}
          outcome={result.outcome}
          nextId={next && props.isUnlocked(next) ? next : null}
          onAgain={restart}
          onNext={(id) => go({ name: 'PLAYING', levelId: id })}
          onLevels={() => go({ name: 'LEVEL_SELECT' })}
          onHome={() => go({ name: 'MENU' })}
        />
      )}
    </div>
  );
}
