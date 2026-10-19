import { useCallback, useEffect, useState } from 'react';
import { sound } from '../../game/audio/sound';
import { GameEngine, type MatchSyncState } from '../../game/engine/GameEngine';
import { getMatchLayout } from '../../game/levels/matchLayouts';
import { MatchRules } from '../../game/rules/MatchRules';
import type { MatchConfig, MatchHud, MatchResult, Seat } from '../../game/types';
import { clearDuelRound, saveDuelRound } from '../../storage/roundSave';
import { Icon } from '../components/Icon';
import { PowerMeter, RotateHint, Toast } from '../game/GameOverlays';
import { HandoffCard, PlayerCard, TurnBanner } from '../game/MatchParts';
import { useGameEngine, usePauseOnHide } from '../game/useGameEngine';
import type { Route } from '../routes';
import { MatchResultOverlay } from './MatchResultOverlay';
import { PauseMenu } from './PauseMenu';

interface Props {
  config: MatchConfig;
  /** Продолжить сохранённый матч (после перезагрузки страницы). */
  restore?: MatchSyncState;
  muted: boolean;
  reducedMotion: boolean;
  onToggleMute: () => void;
  /** Реванш: тот же состав, первым бросает другой игрок. */
  onRematch: () => void;
  onNavigate: (r: Route) => void;
}

/** Матч вдвоём на одном устройстве. */
export function MatchScreen(props: Props) {
  const { config, muted } = props;
  const layout = getMatchLayout(config.layoutId);
  const [pauseOpen, setPauseOpen] = useState(false);
  const [result, setResult] = useState<MatchResult | null>(null);

  const view = useGameEngine(
    (canvas) =>
      new GameEngine(
        canvas,
        {
          layout,
          rules: new MatchRules(config, (r) => {
            clearDuelRound(); // матч окончен — продолжать нечего
            setResult(r);
          }),
          tutorial: false,
          reducedMotion: props.reducedMotion,
          restore: props.restore,
        },
        {
          onPauseRequest: () => setPauseOpen((p) => !p),
          onCheckpoint: (state) => saveDuelRound(config, state),
        },
      ),
    config,
  );
  const { engine, snap: s, canvasRef } = view;
  const m: MatchHud | null = s?.mode.kind === 'match' ? s.mode : null;

  useEffect(() => {
    engine?.setPaused(pauseOpen || !!result);
  }, [engine, pauseOpen, result]);
  usePauseOnHide(() => setPauseOpen(true), !result);

  const restart = useCallback(() => {
    sound.uiClick();
    clearDuelRound();
    setResult(null);
    setPauseOpen(false);
    engine?.restart();
    canvasRef.current?.focus({ preventScroll: true });
  }, [engine, canvasRef]);

  const go = (r: Route) => {
    sound.uiClick();
    props.onNavigate(r);
  };

  return (
    <div className="game" ref={view.containerRef}>
      <canvas
        ref={canvasRef}
        className="game__canvas"
        tabIndex={0}
        aria-label={`Матч вдвоём на коне «${layout.name}». Игроки бросают по очереди: зажми сақа в руке внизу, тяни к асыкам и отпусти.`}
      />

      <header className="hud" ref={view.hudRef}>
        <div className="hud__bar">
          <button className="icon-btn" onClick={() => setPauseOpen(true)} aria-label="Пауза и меню">
            <Icon name="pause" />
          </button>
          <div className="hud__level">
            <span className="hud__level-name">Матч · {layout.name}</span>
            <span className="hud__goal">
              {m ? `В коне ${m.asyksLeft} из ${m.totalAsyks} · бросок ${m.totalThrows}/${m.maxThrows}` : ''}
            </span>
          </div>
          <div className="hud__stats hud__stats--match">
            {([0, 1] as Seat[]).map((seat) => (
              <PlayerCard key={seat} seat={seat} hud={m} />
            ))}
          </div>
          <div className="hud__actions">
            <button className="icon-btn" onClick={props.onToggleMute} aria-label={muted ? 'Включить звук' : 'Выключить звук'} aria-pressed={muted}>
              <Icon name={muted ? 'mute' : 'sound'} />
            </button>
            <button className="icon-btn" onClick={restart} aria-label="Начать матч заново">
              <Icon name="restart" />
            </button>
          </div>
        </div>
      </header>

      <Toast message={s?.message ?? null} top={view.size.top} />
      {m && !result && !pauseOpen && m.handoff && (
        <HandoffCard
          hud={m}
          y={view.w2s(0, 700).y}
          onReady={() => {
            sound.uiClick();
            engine?.confirmHandoff();
            canvasRef.current?.focus({ preventScroll: true });
          }}
        />
      )}
      {m && !result && !m.handoff && <TurnBanner hud={m} y={view.w2s(0, 720).y} />}
      <div className="sr-only" aria-live="polite">
        {m ? `Ход: ${m.players[m.current].name}. Счёт ${m.players[0].knocked}:${m.players[1].knocked}.` : ''}
      </div>

      <PowerMeter view={view} power={s?.power ?? 0} aiming={!!s?.aiming} />
      <RotateHint view={view} hidden={!!result} />

      {pauseOpen && !result && (
        <PauseMenu
          muted={muted}
          restartLabel="Начать матч заново"
          onResume={() => {
            sound.uiClick();
            setPauseOpen(false);
            canvasRef.current?.focus({ preventScroll: true });
          }}
          onRestart={restart}
          onToggleMute={props.onToggleMute}
          onNewMatch={() => go({ name: 'MATCH_SETUP' })}
          onHome={() => go({ name: 'MENU' })}
        />
      )}

      {result && (
        <MatchResultOverlay
          result={result}
          layoutName={layout.name}
          onRematch={() => {
            sound.uiClick();
            props.onRematch();
          }}
          onNewMatch={() => go({ name: 'MATCH_SETUP' })}
          onHome={() => go({ name: 'MENU' })}
        />
      )}
    </div>
  );
}
