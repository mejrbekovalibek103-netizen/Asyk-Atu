import { useState } from 'react';
import { signInWithGoogle, signOut, useAccount } from '../../net/account';
import { canStake, STAKE_SIZE } from '../../net/collection';
import { AsykIcon } from '../components/AsykIcon';
import { GoogleIcon } from '../components/GoogleIcon';
import { Icon } from '../components/Icon';
import { plural } from '../format';

interface Props {
  /** Google вернул игрока с ошибкой (например, он закрыл окно входа). */
  authError: boolean;
  onBack: () => void;
}

const ERRORS = {
  setup: 'База игроков ещё не настроена. Если ты владелец игры — выполни скрипт supabase/schema.sql в панели Supabase.',
  provider: 'Коллекция доступна только при входе через Google. Выйди и войди через Google.',
  network: 'Не удалось загрузить коллекцию. Проверь интернет и попробуй ещё раз.',
} as const;

/** «Моя коллекция»: вход через Google и асыки игрока. */
export function CollectionScreen({ authError, onBack }: Props) {
  const { state, reload } = useAccount();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(authError);

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
                  </p>
                  {state.granted > 0 && (
                    <p className="lobby-status lobby-status--ready">
                      Добро пожаловать! Тебе выдано {state.granted} {plural(state.granted, ['асык', 'асыка', 'асыков'])} для начала.
                    </p>
                  )}
                  <ul className="collection-grid" aria-label="Асыки в коллекции">
                    {state.asyks.map((a, i) => (
                      <li key={a.id}>
                        <AsykIcon size={44} rotate={((i * 37) % 11) - 5} />
                      </li>
                    ))}
                  </ul>
                  <p className="doc__muted">
                    {canStake(state.asyks)
                      ? `Хватает на ставку: для соревновательной игры нужно ${STAKE_SIZE} асыков. Сам режим скоро появится.`
                      : `Для соревновательной игры нужно ${STAKE_SIZE} асыков — пока не хватает.`}
                  </p>
                </>
              )}
            </section>
            <section className="lobby-card collection-card">
              <p className="doc__muted">
                Ты вошёл как <b>{state.email || 'игрок Google'}</b>. Коллекция привязана к этому аккаунту Google.
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
