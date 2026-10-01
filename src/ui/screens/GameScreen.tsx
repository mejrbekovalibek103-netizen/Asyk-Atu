import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { sound } from '../../game/audio/sound';
import { GameEngine } from '../../game/engine/GameEngine';
import { goalText, nextLevelId } from '../../game/levels/levels';
import { computeCamera, type Camera } from '../../game/render/Renderer';
import type { HudSnapshot, LevelConfig, RoundResult } from '../../game/types';
import type { RecordOutcome } from '../../storage/progress';
import { AsykIcon } from '../components/AsykIcon';
import { Icon } from '../components/Icon';
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

const noopSubscribe = () => () => undefined;

export function GameScreen(props: Props) {
  const { level, muted } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hudRef = useRef<HTMLElement>(null);
  const [engine, setEngine] = useState<GameEngine | null>(null);
  const [camera, setCamera] = useState<Camera>({ scale: 0.5, offsetX: 0, offsetY: 0 });
  const [size, setSize] = useState({ w: 0, h: 0, top: 0 });
  const [pauseOpen, setPauseOpen] = useState(false);
  const [result, setResult] = useState<{ result: RoundResult; outcome: RecordOutcome } | null>(null);

  // актуальные колбэки без пересоздания движка
  const cbRef = useRef(props);
  cbRef.current = props;

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const eng = new GameEngine(
      canvas,
      { level, tutorial: cbRef.current.tutorial, reducedMotion: cbRef.current.reducedMotion },
      {
        onRoundComplete: (r) => {
          const outcome = cbRef.current.onRoundComplete(r);
          setResult({ result: r, outcome });
          if (outcome.isNewRecord) window.setTimeout(() => sound.record(), 700);
        },
        onTutorialDone: () => cbRef.current.onTutorialDone(),
        onPauseRequest: () => setPauseOpen((p) => !p),
      },
    );

    const measure = () => {
      const r = container.getBoundingClientRect();
      const top = (hudRef.current?.getBoundingClientRect().height ?? 0) + 8;
      eng.resize(r.width, r.height, top);
      setCamera(computeCamera(r.width, r.height, top));
      setSize({ w: r.width, h: r.height, top });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    if (hudRef.current) ro.observe(hudRef.current);
    eng.start();
    setEngine(eng);
    return () => {
      ro.disconnect();
      eng.destroy();
      setEngine(null);
    };
  }, [level]);

  const snap = useSyncExternalStore<HudSnapshot | null>(
    engine ? engine.subscribe : noopSubscribe,
    engine ? engine.getSnapshot : () => null,
  );

  // пауза физики, пока открыто меню паузы или итог раунда
  useEffect(() => {
    engine?.setPaused(pauseOpen || !!result);
  }, [engine, pauseOpen, result]);

  // потеря фокуса вкладки — ставим паузу
  useEffect(() => {
    const onHide = () => {
      if (document.hidden && !result) setPauseOpen(true);
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [result]);

  useLayoutEffect(() => {
    canvasRef.current?.focus({ preventScroll: true });
  }, []);

  const restart = useCallback(() => {
    sound.uiClick();
    setResult(null);
    setPauseOpen(false);
    engine?.restart();
    canvasRef.current?.focus({ preventScroll: true });
  }, [engine]);

  const go = (r: Route) => {
    sound.uiClick();
    props.onNavigate(r);
  };

  const s = snap;
  const pct = Math.round((s?.power ?? 0) * 100);
  const w2s = (x: number, y: number) => ({ x: camera.offsetX + x * camera.scale, y: camera.offsetY + y * camera.scale });
  const meterTop = w2s(0, 870);
  const meterBottom = w2s(0, 1140);
  const meterX = Math.min(size.w - 58, w2s(628, 0).x);
  // подсказка у руки, пока игрок не взял сақа; дальше — над коном, чтобы не закрывать пунктир
  const coachNearHand = s?.tutorialStep === 'grab';
  const coachPos = coachNearHand ? w2s(400, 770) : { x: w2s(400, 0).x, y: Math.max(size.top + 70, w2s(0, 190).y) };
  const landscapePhone = size.h > 0 && size.h < 500 && size.w > size.h;
  const next = nextLevelId(level.id);

  return (
    <div className="game" ref={containerRef}>
      <canvas
        ref={canvasRef}
        className="game__canvas"
        tabIndex={0}
        aria-label={`Игровое поле «${level.name}». Зажми сақа в руке внизу и тяни к асыкам, отпусти для броска. Клавиатура: стрелки влево/вправо — направление, вверх/вниз — сила, пробел — бросок.`}
      />

      <header className="hud" ref={hudRef}>
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
            <div className="stat" aria-label={`Броски: ${s?.throwsUsed ?? 0} из ${level.throws}`}>
              <span className="stat__label">Броски</span>
              <span className="stat__value">
                <span className="stat__icons" aria-hidden="true">
                  {Array.from({ length: level.throws }, (_, i) => (
                    <AsykIcon key={i} palette="saka" size={17} ghost={i < (s?.throwsUsed ?? 0)} />
                  ))}
                </span>
                <span>
                  {s?.throwsUsed ?? 0}/{level.throws}
                </span>
              </span>
            </div>
            <div className="stat stat--score" aria-label={`Очки: ${s?.score ?? 0}`}>
              <span className="stat__label">Очки</span>
              <span className="stat__value" key={s?.score ?? 0}>
                <b className="bump">{s?.score ?? 0}</b>
              </span>
            </div>
            <div className="stat" aria-label={`Выбито ${s?.knocked ?? 0} из ${level.asyks.length}`}>
              <span className="stat__label">Выбито</span>
              <span className="stat__value">
                <span className="stat__icons stat__icons--tray" aria-hidden="true">
                  {level.asyks.map((_, i) => (
                    <AsykIcon key={i} size={15} ghost={i >= (s?.knocked ?? 0)} />
                  ))}
                </span>
                {s?.hasTarget && (
                  <span className="stat__target" title={s.targetOut ? 'Синий асык выбит' : 'Синий асык ещё в коне'}>
                    <AsykIcon palette="target" size={18} ghost={!s.targetOut} />
                    <span className="sr-only">{s.targetOut ? 'Синий асык выбит' : 'Синий асык ещё в коне'}</span>
                  </span>
                )}
                <span>
                  {s?.knocked ?? 0}/{level.asyks.length}
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

      {s?.message && (
        <div key={s.message.id} className={`toast toast--${s.message.tone}`} style={{ top: size.top + 6 }} role="status">
          {s.message.text}
        </div>
      )}
      {/* объявления для скринридеров */}
      <div className="sr-only" aria-live="polite">
        {s?.lastThrow && !s.lastThrow.practice
          ? `Бросок ${s.lastThrow.index}: выбито ${s.lastThrow.knocked}. Очки: ${s.score}.`
          : ''}
      </div>

      <div
        className={`power${s?.aiming ? ' power--active' : ''}`}
        style={{ left: meterX, top: meterTop.y, height: Math.max(90, meterBottom.y - meterTop.y) }}
        role="meter"
        aria-label="Сила броска"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <span className="power__label">Сила</span>
        <div className="power__track">
          <div className="power__fill" style={{ height: `${pct}%` }} />
          <span className="power__tick" style={{ bottom: '33%' }} />
          <span className="power__tick" style={{ bottom: '66%' }} />
        </div>
        <span className="power__value">{pct}%</span>
      </div>

      {s?.tutorialStep && !pauseOpen && <TutorialCoach step={s.tutorialStep} x={coachPos.x} y={coachPos.y} pointer={coachNearHand} />}

      {landscapePhone && !result && <div className="rotate-hint">Поверни телефон вертикально — поле будет крупнее</div>}

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
