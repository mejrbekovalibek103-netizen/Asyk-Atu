import { useState } from 'react';
import { PLAYER_STYLE } from '../../game/rules/MatchRules';
import { formatRoomCode } from '../../net/protocol';
import { AsykIcon } from '../components/AsykIcon';

/**
 * Части комнаты ожидания (лобби): код комнаты и список мест за столом.
 * Список мест рассчитан на любое число игроков — сейчас в комнате двое.
 */

/** Одно место за столом. `name` — null, если место свободно (или игрок не в сети). */
export interface LobbySlot {
  seat: number;
  name: string | null;
  you: boolean;
  host: boolean;
  /** Будущее место в матче (порядок занятых мест) — от него цвет сақа; нет — место свободно. */
  order?: number;
}

export function PlayerSlots({ slots }: { slots: LobbySlot[] }) {
  return (
    <ul className="lobby-slots" aria-label="Игроки в комнате">
      {slots.map((s) => {
        const style = s.order === undefined ? undefined : PLAYER_STYLE[s.order];
        return (
          <li key={s.seat} className={`lobby-slot${s.name ? ' lobby-slot--on' : ' lobby-slot--empty'}`} style={{ '--player': style?.color ?? '#9aa0a6' } as React.CSSProperties}>
            <AsykIcon palette={style?.palette ?? 'saka'} size={28} ghost={!s.name} />
            <span className="lobby-slot__name">{s.name ?? (s.host ? 'Хозяин не в сети' : 'Свободное место')}</span>
            {s.host && <span className="lobby-slot__tag">хозяин</span>}
            {s.you && <span className="lobby-slot__tag lobby-slot__tag--you">вы</span>}
          </li>
        );
      })}
    </ul>
  );
}

/** Крупный код комнаты с кнопками «Копировать» и «Поделиться»: код можно продиктовать по телефону или ввести вручную. */
export function RoomCodeCard({ code, link }: { code: string; link: string }) {
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);
  const shown = formatRoomCode(code);
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const copy = async (what: 'code' | 'link') => {
    try {
      await navigator.clipboard.writeText(what === 'code' ? shown : link);
      setCopied(what);
      window.setTimeout(() => setCopied((c) => (c === what ? null : c)), 2000);
    } catch {
      // буфер обмена недоступен — код и ссылку можно выделить вручную
    }
  };
  const share = async () => {
    try {
      await navigator.share({ title: 'Асық ату — сыграем?', text: `Сыграем в асық ату онлайн! Код комнаты: ${shown}`, url: link });
    } catch {
      // пользователь закрыл окно «Поделиться»
    }
  };

  return (
    <section className="lobby-card code-card" aria-label="Код комнаты">
      <p className="code-card__label">Код комнаты</p>
      <p className="code-card__code" aria-label={`Код комнаты: ${shown.split('').join(' ')}`}>
        {shown}
      </p>
      <p className="doc__muted code-card__how">
        Друг вводит его в «Игра вдвоём → Онлайн → Войти по коду» или открывает ссылку.
      </p>
      <div className="share-row">
        <button className="btn btn--primary" onClick={() => copy('code')}>
          {copied === 'code' ? 'Код скопирован ✓' : 'Копировать код'}
        </button>
        <button className="btn" onClick={() => copy('link')}>
          {copied === 'link' ? 'Ссылка скопирована ✓' : 'Копировать ссылку'}
        </button>
        {canShare && (
          <button className="btn" onClick={share}>
            Поделиться
          </button>
        )}
      </div>
    </section>
  );
}
