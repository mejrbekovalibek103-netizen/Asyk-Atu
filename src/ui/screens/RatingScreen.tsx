import { useCallback, useEffect, useState } from 'react';
import { signInWithGoogle, signOut, useAccount } from '../../net/account';
import {
  checkNickname,
  fetchLeaderboard,
  fetchMyProfile,
  NICK_MAX,
  RATING_ERROR_TEXT,
  ratingErrorText,
  saveNickname,
  type Leaderboard,
  type MyProfile,
  type RatingRow,
  type RatingSort,
} from '../../net/rating';
import { GoogleIcon } from '../components/GoogleIcon';
import { plural } from '../format';

interface Props {
  /** Google вернул игрока с ошибкой (закрыл окно входа). */
  authError: boolean;
}

const TABS: { sort: RatingSort; label: string; unit: [string, string, string] }[] = [
  { sort: 'asyks', label: 'Асыки', unit: ['асык', 'асыка', 'асыков'] },
  { sort: 'wins', label: 'Победы', unit: ['победа', 'победы', 'побед'] },
  { sort: 'played', label: 'Игры', unit: ['игра', 'игры', 'игр'] },
];

const valueOf = (r: RatingRow, sort: RatingSort) => (sort === 'asyks' ? r.asyks : sort === 'wins' ? r.wins : r.played);

/** Рейтинг игроков и данные своего аккаунта: ID, ник, асыки, победы, игры. Почта не показывается. */
export function RatingScreen({ authError }: Props) {
  const { state: account } = useAccount();
  const signedIn = account.status === 'signedIn' || account.status === 'error';
  const [sort, setSort] = useState<RatingSort>('asyks');
  const [board, setBoard] = useState<Leaderboard | null>(null);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // рейтинг: при смене вкладки, входа/выхода и после смены ника
  useEffect(() => {
    if (account.status === 'loading') return;
    let alive = true;
    setBoardError(null);
    fetchLeaderboard(sort)
      .then((b) => alive && setBoard(b))
      .catch((e: unknown) => alive && setBoardError(ratingErrorText(e)));
    return () => {
      alive = false;
    };
  }, [sort, account.status, tick]);

  // свой профиль — только после входа (и после того, как база выдала стартовые асыки)
  const ready = account.status === 'signedIn' && account.asyks !== null;
  useEffect(() => {
    if (!ready) {
      setProfile(null);
      return;
    }
    let alive = true;
    setProfileError(null);
    fetchMyProfile()
      .then((p) => alive && setProfile(p))
      .catch((e: unknown) => alive && setProfileError(ratingErrorText(e)));
    return () => {
      alive = false;
    };
  }, [ready, tick]);

  const onProfile = useCallback((p: MyProfile) => {
    setProfile(p);
    setTick((t) => t + 1);
  }, []);

  const tab = TABS.find((t) => t.sort === sort)!;

  return (
    <main className="page page--doc page--nav">
      <div className="doc">
        <p className="kicker">Соревновательная игра</p>
        <h1 className="doc__title">Рейтинг</h1>

        {account.status === 'loading' && (
          <p className="doc__lead" role="status">
            Загрузка…
          </p>
        )}

        {account.status === 'signedOut' && <SignInCard authError={authError} />}

        {signedIn && (
          <section className="lobby-card account-card" aria-label="Мой аккаунт">
            {account.status === 'error' ? (
              <p className="setup__hint code-hint code-hint--error" role="alert">
                Не удалось загрузить профиль. Открой «Коллекцию» и попробуй ещё раз.
              </p>
            ) : profile ? (
              <AccountCard profile={profile} onProfile={onProfile} />
            ) : profileError ? (
              <p className="setup__hint code-hint code-hint--error" role="alert">
                {profileError}
              </p>
            ) : (
              <p className="lobby-status" role="status">
                Загружаем профиль…
              </p>
            )}
            <button className="btn btn--ghost account-card__out" onClick={() => void signOut()}>
              Выйти на этом устройстве
            </button>
          </section>
        )}

        <section className="lobby-card rating-card">
          <div className="mode-switch rating-tabs" role="tablist" aria-label="Рейтинг по">
            {TABS.map((t) => (
              <button
                key={t.sort}
                role="tab"
                aria-selected={sort === t.sort}
                className={`mode-switch__option${sort === t.sort ? ' mode-switch__option--on' : ''}`}
                onClick={() => setSort(t.sort)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {boardError ? (
            <p className="setup__hint code-hint code-hint--error" role="alert">
              {boardError}
            </p>
          ) : !board || board.sort !== sort ? (
            <p className="lobby-status" role="status">
              Загружаем рейтинг…
            </p>
          ) : board.rows.length === 0 ? (
            <p className="doc__muted">Пока никого нет — сыграй первый матч на асыки!</p>
          ) : (
            <>
              <ol className="rating-list" aria-label={`Рейтинг: ${tab.label.toLowerCase()}`}>
                {board.rows.map((r) => (
                  <RatingLine key={r.playerNo} row={r} sort={sort} unit={tab.unit} />
                ))}
              </ol>
              {board.me && !board.rows.some((r) => r.me) && (
                <ol className="rating-list rating-list--me" aria-label="Твоё место">
                  <RatingLine row={board.me} sort={sort} unit={tab.unit} />
                </ol>
              )}
              <p className="doc__muted rating-note">
                Игроков: {board.total}. Победа — в матче на асыки выбил больше каждого соперника; ничья и сдача не считаются.
              </p>
            </>
          )}
        </section>
      </div>
    </main>
  );
}

function RatingLine({ row, sort, unit }: { row: RatingRow; sort: RatingSort; unit: [string, string, string] }) {
  const v = valueOf(row, sort);
  return (
    <li className={`rating-row${row.me ? ' rating-row--me' : ''}${row.place <= 3 ? ` rating-row--top${row.place}` : ''}`}>
      <span className="rating-row__place">{row.place}</span>
      <span className="rating-row__name">
        {row.name}
        {row.me && <small> · ты</small>}
      </span>
      <span className="rating-row__value" aria-label={`${v} ${plural(v, unit)}`}>
        {v}
      </span>
    </li>
  );
}

function SignInCard({ authError }: { authError: boolean }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(authError);
  const signIn = async () => {
    setBusy(true);
    setFailed(false);
    if (!(await signInWithGoogle({ name: 'RATING' }))) {
      setFailed(true);
      setBusy(false);
    }
  };
  return (
    <section className="lobby-card account-card">
      <p className="doc__muted">Войди, чтобы попасть в рейтинг, увидеть свой ID и выбрать ник.</p>
      <button className="btn btn--xl btn--block btn--google" onClick={signIn} disabled={busy}>
        <GoogleIcon size={22} /> {busy ? 'Открываем Google…' : 'Продолжить с Google'}
      </button>
      {failed && (
        <p className="setup__hint code-hint code-hint--error" role="alert">
          Войти не получилось. Попробуй ещё раз.
        </p>
      )}
    </section>
  );
}

/** Мой аккаунт: ID игрока, ник и три числа. */
function AccountCard({ profile, onProfile }: { profile: MyProfile; onProfile: (p: MyProfile) => void }) {
  const [editing, setEditing] = useState(false);
  const [nick, setNick] = useState(profile.nickname ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const checked = checkNickname(nick);
    if (!checked.ok) return setError(RATING_ERROR_TEXT[checked.error]);
    setBusy(true);
    setError(null);
    try {
      const p = await saveNickname(checked.value);
      onProfile(p);
      setEditing(false);
    } catch (e) {
      setError(ratingErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="account-card__head">
        <div>
          <p className="account-card__name">{profile.name}</p>
          <p className="doc__muted">ID игрока: {profile.playerNo}</p>
        </div>
        {!editing && (
          <button
            className="btn account-card__edit"
            onClick={() => {
              setNick(profile.nickname ?? '');
              setError(null);
              setEditing(true);
            }}
          >
            {profile.nickname ? 'Сменить ник' : 'Выбрать ник'}
          </button>
        )}
      </div>

      {editing && (
        <form
          className="account-card__form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label className="name-field">
            <span className="sr-only">Ник</span>
            <input type="text" value={nick} maxLength={NICK_MAX} placeholder={`Ник (пусто — «Игрок ${profile.playerNo}»)`} autoComplete="nickname" autoFocus onChange={(e) => setNick(e.target.value)} />
          </label>
          <div className="comp-actions">
            <button type="submit" className="btn btn--primary" disabled={busy}>
              {busy ? 'Сохраняем…' : 'Сохранить'}
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setEditing(false)} disabled={busy}>
              Отмена
            </button>
          </div>
          {error && (
            <p className="setup__hint code-hint code-hint--error" role="alert">
              {error}
            </p>
          )}
          <p className="doc__muted">Ник видят все в рейтинге. 2–{NICK_MAX} символов: буквы, цифры, пробел, точка, дефис, _.</p>
        </form>
      )}

      <dl className="account-stats">
        <div>
          <dt>Асыки</dt>
          <dd>{profile.asyks}</dd>
        </div>
        <div>
          <dt>Победы</dt>
          <dd>{profile.wins}</dd>
        </div>
        <div>
          <dt>Игры</dt>
          <dd>{profile.played}</dd>
        </div>
      </dl>
      {profile.locked > 0 && (
        <p className="doc__muted">
          В коне сейчас {profile.locked} {plural(profile.locked, ['асык', 'асыка', 'асыков'])}, свободно {profile.free}.
        </p>
      )}
    </>
  );
}
