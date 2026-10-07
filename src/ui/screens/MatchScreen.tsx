import { useCallback, useEffect, useState } from 'react';
import { sound } from '../../game/audio/sound';
import { GameEngine } from '../../game/engine/GameEngine';
import { getMatchLayout } from '../../game/levels/matchLayouts';
import { MatchRules, PLAYER_STYLE } from '../../game/rules/MatchRules';
import type { MatchConfig, MatchHud, MatchResult, Seat } from '../../game/types';
import { AsykIcon } from '../components/AsykIcon';
import { Icon } from '../components/Icon';
import { PowerMeter, RotateHint, Toast } from '../game/GameOverlays';
import { useGameEngine, usePauseOnHide } from '../game/useGameEngine';
import type { Route } from '../routes';
import { MatchResultOverlay } from './MatchResultOverlay';
import { PauseMenu } from './PauseMenu';

interface Props {
  config: MatchConfig;
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
          rules: new MatchRules(config, setResult),
          tutorial: false,
          reducedMotion: props.reducedMotion,
        },
        { onPauseRequest: () => setPauseOpen((p) => !p) },
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
      {m && !result && <TurnBanner hud={m} y={view.w2s(0, 720).y} />}
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

function PlayerCard({ seat, hud }: { seat: Seat; hud: MatchHud | null }) {
  const p = hud?.players[seat];
  const active = hud?.current === seat;
  return (
    <div
      className={`player-card${active ? ' player-card--active' : ''}`}
      style={{ '--player': PLAYER_STYLE[seat].color } as React.CSSProperties}
      aria-label={`${p?.name ?? ''}: выбито ${p?.knocked ?? 0}${active ? ', сейчас бросает' : ''}`}
    >
      <AsykIcon palette={PLAYER_STYLE[seat].palette} size={20} />
      <span className="player-card__name">{p?.name}</span>
      <b className="player-card__score bump" key={p?.knocked}>
        {p?.knocked ?? 0}
      </b>
      {active && <span className="player-card__turn">бросает</span>}
    </div>
  );
}

/** Крупная надпись «Ход: …» при каждой смене игрока — на одном устройстве это сигнал передать телефон. */
function TurnBanner({ hud, y }: { hud: MatchHud; y: number }) {
  const p = hud.players[hud.current];
  return (
    <div key={hud.turnId} className="turn-banner" style={{ top: y, '--player': PLAYER_STYLE[hud.current].color } as React.CSSProperties} aria-hidden="true">
      <span className="turn-banner__label">Ход</span>
      <span className="turn-banner__name">{p.name}</span>
    </div>
  );
}
