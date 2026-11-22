import { useEffect, useState } from 'react';
import { signInWithGoogle, signOut, useAccount } from '../../net/account';
import { canStake, freeCount, lockedMatches, STAKE_SIZE } from '../../net/collection';
import { compState, isCompOver } from '../../net/competitive';
import { AsykIcon } from '../components/AsykIcon';
import { GoogleIcon } from '../components/GoogleIcon';
import { Icon } from '../components/Icon';
import { plural } from '../format';

interface Props {
  /** Google вернул игрока с ошибкой (например, он закрыл окно входа). */
  authError: boolean;
  /** Открыть матч на асыки по коду (асыки игрока стоят в его коне). */
  onOpenMatch: (code: string) => void;
  /** К соревновательному режиму (#/comp). */
  onCompetitive: () => void;
  onBack: () => void;
}

/** Матч, в коне которого стоят асыки игрока: код для ссылки и идёт ли он ещё. */
interface LockedMatch {
  id: string;
  code: string | null;
  live: boolean;
}

/** «3 асыка стоят» — сколько асыков игрока в коне этого матча. */
function inKon(list: readonly { locked: string | null }[], id: string): string {
  const n = list.filter((a) => a.locked === id).length;
  return `${n} ${plural(n, ['асык стоит', 'асыка стоят', 'асыков стоят'])}`;
}

/** По id матчей (asyks.locked_match) узнаём их коды у базы — так получается ссылка «Открыть матч». */
function useLockedMatches(ids: string[]): LockedMatch[] {
  const key = ids.slice(0, 3).join(',');
  const [list, setList] = useState<LockedMatch[]>([]);
  useEffect(() => {
    const wanted = key ? key.split(',') : [];
    setList(wanted.map((id) => ({ id, code: null, live: true })));
    if (!wanted.length) return;
    let alive = true;
    void Promise.all(
      wanted.map((id) =>
        compState(id)
          .then((st): LockedMatch => ({ id, code: st.match.joinCode, live: !isCompOver(st.match.status) }))
          .catch((): LockedMatch => ({ id, code: null, live: true })),
      ),
    ).then((found) => {
      if (alive) setList(found);
    });
    return () => {
      alive = false;
    };
  }, [key]);
  return list;
}

const ERRORS = {
  setup: 'База игроков ещё не настроена. Если ты владелец игры — выполни скрипт supabase/schema.sql в панели Supabase.',
  provider: 'Коллекция доступна только при входе через Google. Выйди и войди через Google.',
  network: 'Не удалось загрузить коллекцию. Проверь интернет и попробуй ещё раз.',
} as const;

/** «Моя коллекция»: вход через Google и асыки игрока. */
export function CollectionScreen({ authError, onOpenMatch, onCompetitive, onBack }: Props) {
  const { state, reload } = useAccount();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(authError);
  const asyks = state.status === 'signedIn' ? state.asyks : null;
  const locked = useLockedMatches(asyks ? lockedMatches(asyks) : []);

  const signIn = async () => {
    setBusy(true);
    setFailed(false);
    if (!(await signInWithGoogle())) {
      setFailed(true);
      setBusy(false);
    }
  };

  return (
    <main className="page page--doc">
      <div className="doc">
        <button className="back-btn" onClick={onBack}>
          <Icon name="back" /> Назад
        </button>
        <p className="kicker">Онлайн игра</p>
        <h1 className="doc__title">Моя коллекция</h1>

        {state.status === 'loading' && (
          <p className="doc__lead" role="status">
            Загрузка…
          </p>
        )}

        {state.status === 'signedOut' && (
          <>
            <p className="doc__lead">
              Собирай асыки: в соревновательной игре каждый ставит в кон {STAKE_SIZE} своих асыков и забирает те, что выбил. Чтобы коллекция
              сохранялась и не терялась при смене телефона, войди через Google.
            </p>
            <section className="lobby-card collection-card">
              <button className="btn btn--xl btn--block btn--google" onClick={signIn} disabled={busy}>
                <GoogleIcon size={22} /> {busy ? 'Открываем Google…' : 'Продолжить с Google'}
              </button>
              {failed && (
                <p className="setup__hint code-hint code-hint--error" role="alert">
                  Войти не получилось. Попробуй ещё раз.
                </p>
              )}
              <p className="doc__muted">
                От Google игра использует только адрес почты — чтобы узнавать тебя при следующем входе. Пароль игра не видит. Новый игрок
                получает 10 асыков. Обычная онлайн-игра и испытания работают и без входа.
              </p>
            </section>
          </>
        )}

        {(state.status === 'signedIn' || state.status === 'error') && (
          <>
            <section className="lobby-card collection-card" aria-live="polite">
              {state.status === 'error' ? (
                <>
                  <p className="setup__hint code-hint code-hint--error" role="alert">
                    {ERRORS[state.reason]}
                  </p>
                  {state.reason === 'network' && (
                    <button className="btn" onClick={reload}>
                      <Icon name="restart" /> Повторить
                    </button>
                  )}
                </>
              ) : state.asyks === null ? (
                <p className="lobby-status" role="status">
                  Загружаем асыки…
                </p>
              ) : (
                <>
                  <p className="collection-count">
                    <b>{state.asyks.length}</b> {plural(state.asyks.length, ['асык', 'асыка', 'асыков'])}
                    {state.asyks.length !== freeCount(state.asyks) && <small className="collection-free"> · свободно {freeCount(state.asyks)}</small>}
                  </p>
                  {state.granted > 0 && (
                    <p className="lobby-status lobby-status--ready">
                      Добро пожаловать! Тебе выдано {state.granted} {plural(state.granted, ['асык', 'асыка', 'асыков'])} для начала.
                    </p>
                  )}
                  <ul className="collection-grid" aria-label="Асыки в коллекции">
                    {state.asyks.map((a, i) => (
                      <li key={a.id} className={a.locked ? 'collection-item collection-item--locked' : 'collection-item'} title={a.locked ? 'Стоит в коне матча' : undefined}>
                        <AsykIcon size={44} rotate={((i * 37) % 11) - 5} />
                        {a.locked && <span className="collection-item__badge">в коне</span>}
                      </li>
                    ))}
                  </ul>
                  {locked.map((m) => (
                    <div key={m.id} className="comp-active">
                      <p>
                        <b>{inKon(state.asyks!, m.id)} в коне матча.</b>{' '}
                        {m.live ? 'Вернутся после его конца.' : 'Матч окончен — асыки скоро вернутся.'}
                      </p>
                      {m.code && (
                        <button className="btn" onClick={() => onOpenMatch(m.code!)}>
                          Открыть матч
                        </button>
                      )}
                    </div>
                  ))}
                  <p className="doc__muted">
                    {canStake(state.asyks)
                      ? `Хватает на ставку: для матча на асыки нужно ${STAKE_SIZE} свободных.`
                      : `Для матча на асыки нужно ${STAKE_SIZE} свободных асыков — пока не хватает.`}
                  </p>
                  {canStake(state.asyks) && (
                    <button className="btn btn--primary" onClick={onCompetitive}>
                      Матч на асыки
                    </button>
                  )}
                </>
              )}
            </section>
            <section className="lobby-card collection-card">
              <p className="doc__muted">
                Ты вошёл через Google, коллекция привязана к этому аккаунту. Твой ID, ник и счёт — во вкладке «Рейтинг».
              </p>
              <button className="btn btn--ghost" onClick={() => void signOut()}>
                Выйти на этом устройстве
              </button>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
