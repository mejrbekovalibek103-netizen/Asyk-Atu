import { useState } from 'react';
import { useAccount } from '../../net/account';
import { freeCount, STAKE_SIZE } from '../../net/collection';
import type { CompState } from '../../net/competitive';
import { PLAYER_STYLE } from '../../game/rules/MatchRules';
import { AsykIcon } from '../components/AsykIcon';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { Ornament } from '../components/Ornament';
import { plural } from '../format';

interface Props {
  state: CompState;
  /**
   * «Реванш» (сразу ставка и старт, как только готовы все) или «В комнату» (лобби, где хозяин может сменить кон).
   * Промис — переход в лобби следующего матча; отказ — текст ошибки показывается здесь же.
   */
  onRematch: (kind: 'rematch' | 'room') => Promise<void>;
  onCollection: () => void;
  onMenu: () => void;
  /** Текст ошибки → строка для игрока. */
  errorText: (e: unknown) => string;
}

const asyks = (n: number) => `${n} ${plural(n, ['асык', 'асыка', 'асыков'])}`;

/** Почему матч закончился — коротко, к игроку на «ты». */
export function compEndText(reason: string | null, refunded: boolean): string {
  switch (reason) {
    case 'cleared':
      return 'Кон пуст — все асыки выбиты.';
    case 'throws_out':
      return 'Броски закончились.';
    case 'all_forfeited':
      return 'Игроки сдались — матч окончен.';
    case 'stale':
      return 'Матч долго стоял без ходов — раздали то, что уже выбито.';
    case 'server':
      return 'Сбой сервера — матч отменён.';
    case 'version':
      return 'Игра обновилась — матч отменён.';
    case 'host_left':
      return 'Хозяин вышел — матч отменён.';
    case 'left':
      return 'Игрок вышел до старта — матч отменён.';
    case 'not_ready':
      return 'Не все подтвердили, что на месте, — матч отменён.';
    case 'lobby_expired':
      return 'Лобби простояло слишком долго — матч отменён.';
    default:
      return refunded ? 'Матч отменён.' : 'Матч окончен.';
  }
}

/** «+3», «−2», «0» — итог по асыкам. */
export function deltaText(delta: number): string {
  return delta > 0 ? `+${delta}` : delta < 0 ? `−${-delta}` : '0';
}

/** Места по числу выбитых: поровну — одно место (1, 1, 3). */
export function placesByKnocked<T extends { knocked: number }>(players: readonly T[]): { p: T; place: number }[] {
  return [...players].sort((a, b) => b.knocked - a.knocked).map((p) => ({ p, place: 1 + players.filter((x) => x.knocked > p.knocked).length }));
}

/** Асыки одного раздела итогов: цвет — хозяина асыка (как тамга в коне). */
function SlotIcons({ state, list, label }: { state: CompState; list: number[]; label: string }) {
  if (!list.length) return <p className="comp-result__empty">—</p>;
  return (
    <ul className="comp-result__icons" aria-label={`${label}: ${asyks(list.length)}`}>
      {list.map((slot, i) => {
        const owner = state.slots.find((s) => s.slot === slot)?.ownerSeat ?? null;
        return (
          <li key={slot}>
            <AsykIcon size={30} palette={owner === null ? 'bone' : PLAYER_STYLE[owner].palette} rotate={((i * 37) % 11) - 5} />
          </li>
        );
      })}
    </ul>
  );
}

/** Итоги матча на асыки: «Твой улов», «Вернулись», «Ушли» и итог вида «+3». */
export function CompResultOverlay({ state, onRematch, onCollection, onMenu, errorText }: Props) {
  const [busy, setBusy] = useState<'rematch' | 'room' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // база уже раздала асыки — перечитываем коллекцию, чтобы показать, сколько их теперь
  const { state: account } = useAccount();
  const r = state.result;
  const me = state.players.find((p) => p.isMe) ?? null;
  const others = state.players.filter((p) => !p.isMe);
  const many = state.players.length > 2;
  const standings = placesByKnocked(state.players);
  const reason = compEndText(state.match.endReason, !!r?.refunded);

  let title = 'Считаем итоги…';
  if (r?.refunded) title = 'Ставки вернулись';
  else if (r) title = r.delta > 0 ? 'Ты в плюсе!' : r.delta < 0 ? 'В этот раз не повезло' : 'Остался при своих';

  const free = account.status === 'signedIn' && account.asyks ? freeCount(account.asyks) : null;
  // невыбитые и выигранные асыки уже вернулись — для реванша нужно 5 свободных
  const canRematch = free === null || free >= STAKE_SIZE;
  const called = state.match.nextCode !== null;
  const go = async (kind: 'rematch' | 'room') => {
    setBusy(kind);
    setError(null);
    try {
      await onRematch(kind);
    } catch (e) {
      setError(errorText(e));
      setBusy(null);
    }
  };

  const collection =
    account.status === 'signedIn' && account.asyks
      ? `В коллекции ${asyks(account.asyks.length)}, свободно ${freeCount(account.asyks)}.`
      : account.status === 'signedIn'
        ? 'Обновляем коллекцию…'
        : null;

  return (
    <Modal labelledBy="comp-result-title" className="modal--result modal--comp">
      <Ornament className="modal__ornament" />
      <p className="modal__kicker">Матч на асыки</p>
      <h2 id="comp-result-title" className="modal__title">
        {title}
      </h2>
      <p className="modal__text">{reason}</p>

      {r && !r.refunded && (
        <p className={`comp-delta${r.delta > 0 ? ' comp-delta--up' : r.delta < 0 ? ' comp-delta--down' : ''}`} aria-label={`Итог: ${deltaText(r.delta)}`}>
          {deltaText(r.delta)}
        </p>
      )}

      {many && !r?.refunded && (
        <ol className="comp-standings" aria-label="Кто сколько выбил">
          {standings.map(({ p, place }) => (
            <li key={p.lobbySlot} className={`comp-standings__row${p.isMe ? ' comp-standings__row--me' : ''}`}>
              <span className="comp-standings__place">{place}</span>
              <AsykIcon size={22} palette={p.seat === null ? 'bone' : PLAYER_STYLE[p.seat].palette} />
              <span className="comp-standings__name">
                {p.name}
                {p.isMe && <small> · ты</small>}
                {p.forfeited && <small> · не доиграл</small>}
              </span>
              <b>{p.knocked}</b>
            </li>
          ))}
        </ol>
      )}

      {!many && me && others.length > 0 && !r?.refunded && (
        <p className="comp-result__score">
          Ты выбил {asyks(me.knocked)} · {others.map((p) => `${p.name}: ${p.knocked}`).join(' · ')}
        </p>
      )}

      {r && (
        <div className="comp-result">
          {!r.refunded && (
            <section className="comp-result__part comp-result__part--won">
              <h3>Твой улов</h3>
              <p className="comp-result__hint">Чужие асыки, которые ты выбил: {r.won.length}</p>
              <SlotIcons state={state} list={r.won} label="Твой улов" />
            </section>
          )}
          <section className="comp-result__part">
            <h3>Вернулись</h3>
            <p className="comp-result__hint">Твои асыки снова в коллекции: {r.returned.length}</p>
            <SlotIcons state={state} list={r.returned} label="Вернулись" />
          </section>
          {!r.refunded && (
            <section className="comp-result__part comp-result__part--lost">
              <h3>Ушли</h3>
              <p className="comp-result__hint">Твои асыки, выбитые {many ? 'соперниками' : 'соперником'}: {r.lost.length}</p>
              <SlotIcons state={state} list={r.lost} label="Ушли" />
            </section>
          )}
        </div>
      )}

      {collection && (
        <p className="result-tip" role="status">
          {collection}
        </p>
      )}

      {called && busy === null && (
        <p className="lobby-status lobby-status--ready comp-rematch-call" role="status">
          {many ? 'Тебя зовут на реванш!' : 'Соперник зовёт на реванш!'}
        </p>
      )}
      {!canRematch && (
        <p className="setup__hint" role="status">
          Для реванша нужно {STAKE_SIZE} свободных асыков, у тебя {free}.
        </p>
      )}
      {error && (
        <p className="setup__hint code-hint code-hint--error" role="alert">
          {error}
        </p>
      )}

      <div className="result-actions">
        <button className="btn btn--primary" onClick={() => void go('rematch')} disabled={busy !== null || !canRematch} data-autofocus>
          <Icon name="restart" /> {busy === 'rematch' ? 'Готовим реванш…' : 'Реванш'}
        </button>
        <button className="btn result-actions__wide" onClick={() => void go('room')} disabled={busy !== null}>
          <Icon name="users" /> {busy === 'room' ? 'Открываем…' : 'В комнату'}
        </button>
      </div>
      <div className="result-actions result-actions--minor">
        <button className="btn btn--ghost" onClick={onCollection} disabled={busy !== null}>
          В коллекцию
        </button>
        <button className="btn btn--ghost" onClick={onMenu} disabled={busy !== null}>
          <Icon name="home" /> В меню
        </button>
      </div>
    </Modal>
  );
}
