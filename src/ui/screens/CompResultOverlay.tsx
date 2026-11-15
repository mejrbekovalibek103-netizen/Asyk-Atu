import { useAccount } from '../../net/account';
import { freeCount } from '../../net/collection';
import type { CompState } from '../../net/competitive';
import { PLAYER_STYLE } from '../../game/rules/MatchRules';
import { AsykIcon } from '../components/AsykIcon';
import { Modal } from '../components/Modal';
import { Ornament } from '../components/Ornament';
import { plural } from '../format';

interface Props {
  state: CompState;
  onCollection: () => void;
  onMenu: () => void;
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
export function CompResultOverlay({ state, onCollection, onMenu }: Props) {
  // база уже раздала асыки — перечитываем коллекцию, чтобы показать, сколько их теперь
  const { state: account } = useAccount();
  const r = state.result;
  const me = state.players.find((p) => p.isMe) ?? null;
  const others = state.players.filter((p) => !p.isMe);
  const reason = compEndText(state.match.endReason, !!r?.refunded);

  let title = 'Считаем итоги…';
  if (r?.refunded) title = 'Ставки вернулись';
  else if (r) title = r.delta > 0 ? 'Ты в плюсе!' : r.delta < 0 ? 'В этот раз не повезло' : 'Остался при своих';

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

      {me && others.length > 0 && !r?.refunded && (
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
              <p className="comp-result__hint">Твои асыки, выбитые соперником: {r.lost.length}</p>
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

      <div className="result-actions">
        <button className="btn btn--primary" onClick={onCollection} data-autofocus>
          В коллекцию
        </button>
        <button className="btn btn--ghost" onClick={onMenu}>
          В меню
        </button>
      </div>
    </Modal>
  );
}
