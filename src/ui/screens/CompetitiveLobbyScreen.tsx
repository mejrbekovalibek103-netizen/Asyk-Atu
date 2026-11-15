import { useEffect, useRef, useState, type ReactNode } from 'react';
import { sound } from '../../game/audio/sound';
import { getStakeLayout, STAKE_LAYOUTS, type StakeLayoutId } from '../../game/levels/matchLayouts';
import { PLAYER_STYLE } from '../../game/rules/MatchRules';
import { signInWithGoogle, useAccount, type AccountState } from '../../net/account';
import { freeCount, lockedMatches, STAKE_SIZE } from '../../net/collection';
import {
  CompError,
  compJoin,
  compOpen,
  compState,
  isCompOver,
  parseCompCodeInput,
  toLocalTime,
  useCompMatch,
  type CompMatchView,
  type CompPlayer,
  type CompState,
} from '../../net/competitive';
import { onlineAvailable } from '../../net/config';
import { AsykIcon } from '../components/AsykIcon';
import { GoogleIcon } from '../components/GoogleIcon';
import { Icon } from '../components/Icon';
import { LevelPreview } from '../components/LevelPreview';
import { Modal } from '../components/Modal';
import { cleanName, NAME_MAX, plural } from '../format';
import { takeRematchIntent } from '../game/rematchIntent';
import { StakeModal } from '../game/StakeModal';
import { compEndText } from './CompResultOverlay';
import { CompetitiveMatchScreen, compText } from './CompetitiveMatchScreen';

/**
 * Соревновательный режим «на асыки»: создание матча (#/comp), лобби и проверка готовности (#/comp/<код>).
 * Сама игра — CompetitiveMatchScreen. Всё решает база: здесь только просьбы (создать, войти, поставить,
 * бросить жребий) и показ её ответа.
 */

const asyks = (n: number) => `${n} ${plural(n, ['асык', 'асыка', 'асыков'])}`;
const fmtCode = (code: string) => `${code.slice(0, 5)}-${code.slice(5)}`;
const UNAVAILABLE = 'Соревновательный режим временно недоступен. Обычная онлайн-игра работает как раньше.';

// ——— вход в режим с экрана «Онлайн игра» ———

/** Что показать на переключателе «Соревновательная» (экран «Онлайн игра»). */
export type CompEntry =
  | { kind: 'loading' }
  | { kind: 'signedOut' }
  | { kind: 'ready'; free: number; inMatch: boolean }
  | { kind: 'error' };

function entryOf(s: AccountState): CompEntry {
  if (s.status === 'signedOut') return { kind: 'signedOut' };
  if (s.status === 'error') return { kind: 'error' };
  if (s.status === 'signedIn' && s.asyks) return { kind: 'ready', free: freeCount(s.asyks), inMatch: lockedMatches(s.asyks).length > 0 };
  return { kind: 'loading' };
}

/** Невидимый помощник: узнаёт, вошёл ли игрок и сколько у него свободных асыков (грузится отдельно, вместе с Supabase). */
export function CompAccountProbe({ onChange }: { onChange: (e: CompEntry) => void }) {
  const { state } = useAccount();
  const ref = useRef(onChange);
  ref.current = onChange;
  useEffect(() => ref.current(entryOf(state)), [state]);
  return null;
}

/** Вход через Google с возвратом на экран соревновательного режима. */
export function compSignIn(): Promise<boolean> {
  return signInWithGoogle({ name: 'COMP_SETUP' });
}

// ——— общие части ———

function Page({ kicker, title, onBack, backLabel = 'Назад', children }: { kicker?: string; title: string; onBack: () => void; backLabel?: string; children: ReactNode }) {
  return (
    <main className="page page--doc">
      <div className="doc">
        <button className="back-btn" onClick={onBack}>
          <Icon name="back" /> {backLabel}
        </button>
        {kicker && <p className="kicker">{kicker}</p>}
        <h1 className="doc__title">{title}</h1>
        {children}
      </div>
    </main>
  );
}

function SignInCard({ authError, text }: { authError: boolean; text: string }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(authError);
  const signIn = async () => {
    setBusy(true);
    setFailed(false);
    // адрес этого экрана запоминается сам: после Google игрок вернётся сюда же
    if (!(await signInWithGoogle().catch(() => false))) {
      setFailed(true);
      setBusy(false);
    }
  };
  return (
    <>
      <p className="doc__lead">{text}</p>
      <section className="lobby-card collection-card">
        <button className="btn btn--xl btn--block btn--google" onClick={signIn} disabled={busy}>
          <GoogleIcon size={22} /> {busy ? 'Открываем Google…' : 'Войти через Google'}
        </button>
        {failed && (
          <p className="setup__hint code-hint code-hint--error" role="alert">
            Войти не получилось. Попробуй ещё раз.
          </p>
        )}
        <p className="doc__muted">Асыки хранятся в твоём аккаунте Google. Новый игрок получает 10 асыков. Обычная онлайн-игра работает и без входа.</p>
      </section>
    </>
  );
}

/**
 * Что показать вместо экрана, пока аккаунт не готов: онлайн выключен, загрузка, вход, ошибка базы.
 * null — игрок вошёл через Google и коллекция загружена.
 */
function accountGate(account: AccountState, reload: () => void, authError: boolean, signInText: string): ReactNode | null {
  if (!onlineAvailable) return <p className="doc__lead">Онлайн выключен в этой сборке игры.</p>;
  if (account.status === 'loading' || (account.status === 'signedIn' && account.asyks === null))
    return (
      <p className="doc__lead" role="status">
        Загрузка…
      </p>
    );
  if (account.status === 'signedOut') return <SignInCard authError={authError} text={signInText} />;
  if (account.status === 'error')
    return (
      <section className="lobby-card collection-card" role="alert">
        <p className="setup__hint code-hint code-hint--error">
          {account.reason === 'setup'
            ? UNAVAILABLE
            : account.reason === 'provider'
              ? 'Матч на асыки — только со входом через Google. Выйди и войди через Google.'
              : 'Не удалось загрузить твои асыки. Проверь интернет.'}
        </p>
        {account.reason === 'network' && (
          <button className="btn" onClick={reload}>
            <Icon name="restart" /> Повторить
          </button>
        )}
      </section>
    );
  return null;
}

/** Текст ошибки с кнопкой «Вернуться в матч», если игрок уже в другом матче. */
function ErrorBox({ error, onOpenMatch, onRetry }: { error: unknown; onOpenMatch: (code: string) => void; onRetry?: () => void }) {
  const joinCode = error instanceof CompError ? error.joinCode : null;
  const retry = error instanceof CompError ? ['network', 'timeout', 'server', 'busy', 'bad_response'].includes(error.code) : true;
  return (
    <div className="comp-error" role="alert">
      <p className="setup__hint code-hint code-hint--error">{compText(error)}</p>
      <div className="share-row">
        {joinCode && (
          <button className="btn btn--primary" onClick={() => onOpenMatch(joinCode)}>
            <Icon name="play" /> Вернуться в матч
          </button>
        )}
        {retry && onRetry && (
          <button className="btn" onClick={onRetry}>
            <Icon name="restart" /> Повторить
          </button>
        )}
      </div>
    </div>
  );
}

/** Матчи, где стоят асыки игрока: по id узнаём код, чтобы дать ссылку «Вернуться в матч». */
function useMatchCodes(ids: string[]): { id: string; code: string; status: CompState['match']['status'] }[] {
  const key = ids.slice(0, 3).join(',');
  const [found, setFound] = useState<{ id: string; code: string; status: CompState['match']['status'] }[]>([]);
  useEffect(() => {
    if (!key) {
      setFound([]);
      return;
    }
    let alive = true;
    void Promise.all(
      key.split(',').map((id) =>
        compState(id)
          .then((st) => ({ id, code: st.match.joinCode, status: st.match.status }))
          .catch(() => null),
      ),
    ).then((list) => {
      if (alive) setFound(list.filter((x): x is NonNullable<typeof x> => !!x && !isCompOver(x.status)));
    });
    return () => {
      alive = false;
    };
  }, [key]);
  return found;
}

/** Выбор кона матча на асыки: три раскладки, вид для двоих. */
function StakeLayoutPicker({ value, onChange }: { value: StakeLayoutId; onChange: (id: StakeLayoutId) => void }) {
  return (
    <div className="layout-picker" role="radiogroup" aria-label="Кон матча">
      {STAKE_LAYOUTS.map((l) => (
        <label key={l.id} className={`layout-option${value === l.id ? ' layout-option--on' : ''}`}>
          <input type="radio" name="comp-layout" value={l.id} checked={value === l.id} onChange={() => onChange(l.id as StakeLayoutId)} className="sr-only" />
          <span className="layout-option__preview">
            <LevelPreview level={l} />
          </span>
          <span className="layout-option__body">
            <b>
              {l.name} <small>{l.kazName}</small>
            </b>
            <span>{l.description}</span>
            <span className="layout-option__size">{asyks(l.asyks.length)}: по {STAKE_SIZE} от каждого</span>
          </span>
        </label>
      ))}
    </div>
  );
}

/** Пока вводят сам код, показываем его как ABCDE-FGHJK; ссылку или фразу не трогаем. */
function formatTyped(raw: string): string {
  if (raw.length > 12 || /[/:]/.test(raw)) return raw;
  const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length > 10) return raw;
  return clean.length > 5 ? `${clean.slice(0, 5)}-${clean.slice(5)}` : clean;
}

// ——— #/comp: создать матч или войти по коду ———

interface SetupProps {
  defaultName: string;
  /** Google вернул игрока с ошибкой. */
  authError: boolean;
  onRememberName: (name: string) => void;
  /** Открыть лобби матча по коду. */
  onOpenMatch: (code: string) => void;
  onCollection: () => void;
  onBack: () => void;
}

export function CompetitiveSetupScreen({ defaultName, authError, onRememberName, onOpenMatch, onCollection, onBack }: SetupProps) {
  const { state: account, reload } = useAccount();
  const [action, setAction] = useState<'create' | 'join'>('create');
  const [name, setName] = useState(defaultName);
  const [layoutId, setLayoutId] = useState<StakeLayoutId>('stake-line');
  const [codeInput, setCodeInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const asykList = account.status === 'signedIn' ? account.asyks : null;
  const matches = useMatchCodes(asykList ? lockedMatches(asykList) : []);

  const gate = accountGate(account, reload, authError, 'Матч на асыки: каждый ставит в кон 5 своих асыков и забирает всё, что выбил. Играть можно только со входом через Google.');
  if (gate || !asykList)
    return (
      <Page kicker="Онлайн игра" title="Матч на асыки" onBack={onBack}>
        {gate}
      </Page>
    );

  const free = freeCount(asykList);
  const enough = free >= STAKE_SIZE;
  const joining = action === 'join';
  const code = parseCompCodeInput(codeInput);

  const submit = async () => {
    const clean = cleanName(name, joining ? 'Гость' : 'Хозяин');
    setError(null);
    onRememberName(clean);
    if (joining) {
      if (code) onOpenMatch(code);
      return;
    }
    setBusy(true);
    try {
      const r = await compOpen({ layoutId, name: clean });
      onOpenMatch(r.joinCode);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  return (
    <Page kicker="Онлайн игра" title="Матч на асыки" onBack={onBack}>
      <p className="doc__lead">Двое ставят в кон по {STAKE_SIZE} асыков. Что выбьешь — твоё, невыбитые вернутся хозяину. Бросок считает сервер.</p>

      {matches.map((m) => (
        <section key={m.id} className="lobby-card comp-active" aria-label="Матч, где стоят твои асыки">
          <p>
            <b>Твои асыки в коне матча {fmtCode(m.code)}.</b> {m.status === 'active' ? 'Матч идёт.' : 'Матч ещё не начался.'}
          </p>
          <button className="btn btn--primary" onClick={() => onOpenMatch(m.code)}>
            <Icon name="play" /> Вернуться в матч
          </button>
        </section>
      ))}

      <section className="lobby-card comp-wallet">
        <AsykIcon size={34} />
        <p>
          Свободно <b>{free}</b> из {asykList.length}.{' '}
          {enough ? `На ставку нужно ${STAKE_SIZE}.` : `У тебя ${free}, нужно ${STAKE_SIZE}.`}
        </p>
        <button type="button" className="link-btn" onClick={onCollection}>
          Коллекция
        </button>
      </section>

      <div className="mode-switch mode-switch--sub" role="radiogroup" aria-label="Создать матч или войти по коду">
        {(
          [
            ['create', 'Создать матч'],
            ['join', 'Войти по коду'],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className={`mode-switch__option${action === value ? ' mode-switch__option--on' : ''}`}>
            <input type="radio" name="comp-action" value={value} checked={action === value} onChange={() => setAction(value)} className="sr-only" />
            {label}
          </label>
        ))}
      </div>

      <form
        className="setup"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <fieldset className="setup__group">
          <legend>Твоё имя</legend>
          <label className="name-field" style={{ '--player': PLAYER_STYLE[0].color } as React.CSSProperties}>
            <AsykIcon palette={PLAYER_STYLE[0].palette} size={30} />
            <span className="sr-only">Твоё имя</span>
            <input type="text" value={name} maxLength={NAME_MAX} placeholder="Твоё имя" autoComplete="nickname" onChange={(e) => setName(e.target.value)} />
          </label>
          <p className="setup__hint">Это имя увидит соперник.</p>
        </fieldset>

        {joining ? (
          <fieldset className="setup__group">
            <legend>Код матча</legend>
            <label className="name-field code-field" style={{ '--player': '#8b5cf6' } as React.CSSProperties}>
              <Icon name="globe" size={24} />
              <span className="sr-only">Код матча</span>
              <input
                type="text"
                value={codeInput}
                maxLength={300}
                placeholder="ABCDE-FGHJK"
                autoComplete="off"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="go"
                onChange={(e) => setCodeInput(formatTyped(e.target.value))}
              />
            </label>
            <p className={`setup__hint code-hint code-hint--${code ? 'ok' : 'idle'}`} role="status">
              {code ? `Матч ${fmtCode(code)}` : 'Код — 10 символов, его покажет друг. Можно вставить всю ссылку.'}
            </p>
          </fieldset>
        ) : (
          <fieldset className="setup__group">
            <legend>Кон</legend>
            <StakeLayoutPicker value={layoutId} onChange={setLayoutId} />
          </fieldset>
        )}

        {error !== null && <ErrorBox error={error} onOpenMatch={onOpenMatch} onRetry={() => void submit()} />}

        <button type="submit" className="btn btn--primary btn--xl btn--block" disabled={busy || !enough || (joining && !code)}>
          {joining ? (
            <>
              <Icon name="globe" /> Войти в матч
            </>
          ) : (
            <>
              <Icon name="globe" /> {busy ? 'Создаём…' : 'Создать матч'}
            </>
          )}
        </button>
        {!enough && <p className="setup__hint code-hint code-hint--error">{`У тебя ${free}, нужно ${STAKE_SIZE}. Асыки в коне вернутся после матча.`}</p>}
      </form>
    </Page>
  );
}

// ——— #/comp/<код>: вход, лобби, проверка готовности, матч ———

interface LobbyProps {
  code: string;
  defaultName: string;
  authError: boolean;
  muted: boolean;
  reducedMotion: boolean;
  onToggleMute: () => void;
  onRememberName: (name: string) => void;
  onOpenMatch: (code: string) => void;
  /** К созданию матча (#/comp). */
  onSetup: () => void;
  onCollection: () => void;
  onMenu: () => void;
}

export function CompetitiveLobbyScreen(props: LobbyProps) {
  const { code, defaultName, authError, onMenu } = props;
  // пришли сюда кнопкой «Реванш» — ставка и жребий сами (см. rematchIntent.ts)
  const [autoRematch] = useState(() => takeRematchIntent(code));
  const { state: account, reload } = useAccount();
  const [matchId, setMatchId] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<unknown>(null);
  const [joining, setJoining] = useState(false);
  // имя ещё не вводилось — спрашиваем; иначе входим сразу (участнику база и так вернёт его место)
  const [askName, setAskName] = useState(!defaultName.trim());
  const [name, setName] = useState(defaultName);
  const tried = useRef(false);
  const ready = account.status === 'signedIn' && account.asyks !== null;

  const join = async (who: string) => {
    setJoining(true);
    setJoinError(null);
    try {
      const r = await compJoin({ code, name: cleanName(who, 'Гость') });
      setMatchId(r.matchId);
    } catch (e) {
      setJoinError(e);
    } finally {
      setJoining(false);
    }
  };

  useEffect(() => {
    if (!ready || askName || tried.current) return;
    tried.current = true;
    void join(defaultName);
  }, [ready, askName]);

  const gate = accountGate(account, reload, authError, `Тебя позвали на матч на асыки ${fmtCode(code)}. Чтобы войти, нужен вход через Google и ${STAKE_SIZE} свободных асыков.`);
  if (gate)
    return (
      <Page kicker="Матч на асыки" title={`Матч ${fmtCode(code)}`} onBack={onMenu} backLabel="В меню">
        {gate}
      </Page>
    );

  if (matchId)
    return (
      <CompMatchRoom
        {...props}
        matchId={matchId}
        autoRematch={autoRematch}
        freeAsyks={account.status === 'signedIn' && account.asyks ? freeCount(account.asyks) : null}
        onReloadAccount={reload}
      />
    );

  if (askName && !joining && joinError === null)
    return (
      <Page kicker="Тебя позвали сыграть" title={`Матч ${fmtCode(code)}`} onBack={onMenu} backLabel="В меню">
        <p className="doc__lead">Матч на асыки: каждый ставит в кон {STAKE_SIZE} асыков, выбитые забирает тот, кто выбил.</p>
        <form
          className="setup"
          onSubmit={(e) => {
            e.preventDefault();
            const clean = cleanName(name, 'Гость');
            props.onRememberName(clean);
            setAskName(false);
            tried.current = true;
            void join(clean);
          }}
        >
          <label className="name-field" style={{ '--player': '#8b5cf6' } as React.CSSProperties}>
            <span className="sr-only">Твоё имя</span>
            <input type="text" value={name} maxLength={NAME_MAX} placeholder="Твоё имя" autoComplete="nickname" autoFocus onChange={(e) => setName(e.target.value)} />
          </label>
          <button type="submit" className="btn btn--primary btn--xl btn--block">
            <Icon name="play" /> Войти в матч
          </button>
        </form>
      </Page>
    );

  if (joinError !== null) {
    const c = joinError instanceof CompError ? joinError.code : null;
    const title = c === 'not_found' || c === 'bad_code' ? 'Матч не найден' : c === 'full' ? 'Мест нет' : c === 'not_forming' ? 'Матч уже идёт' : 'Войти не получилось';
    const hint =
      c === 'not_found' || c === 'bad_code'
        ? 'Проверь код: возможно, матч уже закончился или его отменили.'
        : c === 'full'
          ? 'В этом матче уже двое игроков.'
          : c === 'not_forming'
            ? 'Матч начался без тебя. Попроси друга создать новый.'
            : null;
    return (
      <Page kicker="Матч на асыки" title={title} onBack={onMenu} backLabel="В меню">
        {hint && <p className="doc__lead">{hint}</p>}
        <section className="lobby-card">
          <ErrorBox error={joinError} onOpenMatch={props.onOpenMatch} onRetry={() => void join(name || defaultName)} />
        </section>
        <div className="doc__actions">
          <button className="btn btn--primary" onClick={props.onSetup}>
            <Icon name="globe" /> Создать свой матч
          </button>
          <button className="btn btn--ghost" onClick={onMenu}>
            <Icon name="home" /> В меню
          </button>
        </div>
      </Page>
    );
  }

  return (
    <Page kicker="Матч на асыки" title={`Матч ${fmtCode(code)}`} onBack={onMenu} backLabel="В меню">
      <p className="doc__lead" role="status">
        Входим в матч…
      </p>
    </Page>
  );
}

/** Код матча крупно, с кнопками «Копировать» и «Поделиться». */
function CompCodeCard({ code }: { code: string }) {
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);
  const shown = fmtCode(code);
  const link = `${window.location.origin}${window.location.pathname}#/comp/${code}`;
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const copy = async (what: 'code' | 'link') => {
    try {
      await navigator.clipboard.writeText(what === 'code' ? shown : link);
      setCopied(what);
      window.setTimeout(() => setCopied((c) => (c === what ? null : c)), 2000);
    } catch {
      // буфер обмена недоступен — код можно выделить вручную
    }
  };
  const share = async () => {
    try {
      await navigator.share({ title: 'Асық ату — на асыки?', text: `Сыграем в асық ату на асыки! Код матча: ${shown}`, url: link });
    } catch {
      // окно «Поделиться» закрыли
    }
  };
  return (
    <section className="lobby-card code-card" aria-label="Код матча">
      <p className="code-card__label">Код матча</p>
      <p className="code-card__code" aria-label={`Код матча: ${shown.split('').join(' ')}`}>
        {shown}
      </p>
      <p className="doc__muted code-card__how">Друг открывает ссылку или вводит код: «Онлайн игра → Соревновательная → Войти по коду».</p>
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

/** Места в лобби: двое, у каждого — имя, ставка, готовность. */
function CompSlots({ state, stage, onKick, kicking }: { state: CompState; stage: 'forming' | 'ready'; onKick?: (slot: number) => void; kicking: number | null }) {
  const max = state.match.maxPlayers;
  const rows: (CompPlayer | null)[] = Array.from({ length: max }, (_, i) => state.players.find((p) => p.lobbySlot === i) ?? null);
  return (
    <ul className="lobby-slots comp-slots" aria-label="Игроки матча">
      {rows.map((p, i) => {
        const color = PLAYER_STYLE[i]?.color ?? '#9aa0a6';
        const note = !p ? null : stage === 'ready' ? (p.ready ? 'на месте ✓' : 'ждём «Я здесь»…') : p.staked ? `ставка: ${STAKE_SIZE} ✓` : 'без ставки';
        return (
          <li key={i} className={`lobby-slot${p ? ' lobby-slot--on' : ' lobby-slot--empty'}`} style={{ '--player': color } as React.CSSProperties}>
            <AsykIcon palette={p ? PLAYER_STYLE[i].palette : 'saka'} size={28} ghost={!p} />
            <span className="lobby-slot__name">
              {p ? p.name : 'Ждём соперника'}
              {note && <small className={`lobby-slot__note${(stage === 'ready' ? p?.ready : p?.staked) ? ' lobby-slot__note--ok' : ''}`}>{note}</small>}
            </span>
            {p?.isHost && <span className="lobby-slot__tag">хозяин</span>}
            {p?.isMe && <span className="lobby-slot__tag lobby-slot__tag--you">ты</span>}
            {p && !p.isMe && onKick && (
              <button className="btn btn--ghost comp-kick" onClick={() => onKick(p.lobbySlot)} disabled={kicking !== null} aria-label={`Убрать игрока ${p.name}`}>
                {kicking === p.lobbySlot ? '…' : 'Убрать'}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function CompMatchRoom(props: LobbyProps & { matchId: string; autoRematch: boolean; freeAsyks: number | null; onReloadAccount: () => void }) {
  const match = useCompMatch(props.matchId);
  const { state, error } = match;
  const st = state?.match.status;
  // с начала матча (и после его конца) — экран игры; отменённый до старта матч — карточка в лобби
  const inGame = !!state && (st === 'active' || (isCompOver(state.match.status) && state.match.startedAt !== null && state.slots.length > 0));

  if (error)
    return (
      <Page kicker="Матч на асыки" title={error.code === 'not_member' ? 'Тебя нет в этом матче' : error.code === 'not_found' ? 'Матч не найден' : 'Матч не открыть'} onBack={props.onMenu} backLabel="В меню">
        <p className="doc__lead">{error.code === 'not_member' ? 'Ты вышел из матча, или хозяин тебя убрал. Ставка вернулась в коллекцию.' : compText(error)}</p>
        <div className="doc__actions">
          <button className="btn btn--primary" onClick={props.onSetup}>
            <Icon name="globe" /> Новый матч
          </button>
          <button className="btn btn--ghost" onClick={props.onMenu}>
            <Icon name="home" /> В меню
          </button>
        </div>
      </Page>
    );

  if (!state)
    return (
      <Page kicker="Матч на асыки" title={`Матч ${fmtCode(props.code)}`} onBack={props.onMenu} backLabel="В меню">
        <p className="doc__lead" role="status">
          Подключаемся к матчу…
        </p>
        {match.warning && <p className="setup__hint code-hint code-hint--error">{compText(match.warning)}</p>}
      </Page>
    );

  if (match.outdated)
    return (
      <Page kicker="Матч на асыки" title="Игра обновилась" onBack={props.onMenu} backLabel="В меню">
        <p className="doc__lead">Этот матч создан новой версией игры. Обнови страницу — матч продолжится.</p>
        <div className="doc__actions">
          <button className="btn btn--primary" onClick={() => window.location.reload()}>
            <Icon name="restart" /> Обновить
          </button>
        </div>
      </Page>
    );

  if (inGame)
    return (
      <CompetitiveMatchScreen
        state={state}
        match={match}
        muted={props.muted}
        reducedMotion={props.reducedMotion}
        onToggleMute={props.onToggleMute}
        onCollection={props.onCollection}
        onMenu={props.onMenu}
        onOpenMatch={props.onOpenMatch}
      />
    );

  if (st === 'forming') return <FormingView {...props} state={state} match={match} />;
  if (st === 'ready') return <ReadyView {...props} state={state} match={match} />;

  // отменён до старта
  return (
    <Page kicker="Матч на асыки" title="Матч отменён" onBack={props.onMenu} backLabel="В меню">
      <p className="doc__lead">
        {compEndText(state.match.endReason, true)} Ставки вернулись в коллекцию.
      </p>
      <div className="doc__actions">
        <button className="btn btn--primary" onClick={props.onSetup}>
          <Icon name="globe" /> Новый матч
        </button>
        <button className="btn" onClick={props.onCollection}>
          В коллекцию
        </button>
        <button className="btn btn--ghost" onClick={props.onMenu}>
          <Icon name="home" /> В меню
        </button>
      </div>
    </Page>
  );
}

type RoomProps = LobbyProps & { matchId: string; autoRematch: boolean; freeAsyks: number | null; onReloadAccount: () => void; state: CompState; match: CompMatchView };

/** Выйти из лобби: хозяину — с подтверждением (матч отменится). */
function useLeave(props: RoomProps) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const leave = async () => {
    sound.uiClick();
    setBusy(true);
    setError(null);
    try {
      await props.match.actions.leave();
      props.onSetup();
    } catch (e) {
      setError(compText(e));
      setBusy(false);
    }
  };
  return { confirm, setConfirm, busy, error, leave };
}

function LeaveModal({ text, busy, onLeave, onClose }: { text: string; busy: boolean; onLeave: () => void; onClose: () => void }) {
  return (
    <Modal labelledBy="comp-leave-title" onClose={busy ? undefined : onClose} className="modal--pause">
      <h2 id="comp-leave-title" className="modal__title">
        Выйти из матча?
      </h2>
      <p className="modal__text">{text}</p>
      <div className="stack">
        <button className="btn btn--primary btn--block" onClick={onClose} disabled={busy} data-autofocus>
          Остаться
        </button>
        <button className="btn btn--block btn--danger-solid" onClick={onLeave} disabled={busy}>
          {busy ? 'Выходим…' : 'Выйти'}
        </button>
      </div>
    </Modal>
  );
}

function FormingView(props: RoomProps) {
  const { state, match } = props;
  const [stakeOpen, setStakeOpen] = useState(false);
  const [busy, setBusy] = useState<'stake' | 'unstake' | 'start' | 'layout' | null>(null);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const autoStaked = useRef(false);
  const autoStarted = useRef(false);
  const [kicking, setKicking] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stakeError, setStakeError] = useState<string | null>(null);
  const leave = useLeave(props);
  const me = state.me;
  const others = state.players.filter((p) => !p.isMe);
  const layout = getStakeLayout(state.match.layoutId, Math.max(2, state.players.length));
  const allStaked = state.players.length >= 2 && state.players.every((p) => p.staked);

  const run = async (kind: 'unstake' | 'start', fn: () => Promise<unknown>) => {
    sound.uiClick();
    setBusy(kind);
    setError(null);
    try {
      await fn();
      if (kind === 'unstake') props.onReloadAccount();
    } catch (e) {
      setError(compText(e));
    } finally {
      setBusy(null);
    }
  };

  const stake = async () => {
    setBusy('stake');
    setStakeError(null);
    try {
      await match.actions.stake();
      setStakeOpen(false);
      props.onReloadAccount();
    } catch (e) {
      setStakeError(compText(e));
    } finally {
      setBusy(null);
    }
  };

  const changeLayout = async (id: StakeLayoutId) => {
    if (id === state.match.layoutId) return setLayoutOpen(false);
    sound.uiClick();
    setBusy('layout');
    setError(null);
    try {
      await match.actions.setLayout(id);
      setLayoutOpen(false);
    } catch (e) {
      setError(compText(e));
    } finally {
      setBusy(null);
    }
  };

  // «Реванш»: своя ставка — сразу, без окна правил (их уже видели); не вышло — открываем окно с причиной
  useEffect(() => {
    if (!props.autoRematch || me.staked || autoStaked.current || busy !== null) return;
    autoStaked.current = true;
    void (async () => {
      setBusy('stake');
      try {
        await match.actions.stake();
        props.onReloadAccount();
      } catch (e) {
        setStakeError(compText(e));
        setStakeOpen(true);
      } finally {
        setBusy(null);
      }
    })();
  }, [props.autoRematch, me.staked, busy]);

  // «Реванш» у хозяина: оба поставили — жребий сам
  useEffect(() => {
    if (!props.autoRematch || !me.isHost || !allStaked || autoStarted.current || busy !== null) return;
    autoStarted.current = true;
    void run('start', () => match.actions.start());
  }, [props.autoRematch, me.isHost, allStaked, busy]);

  const kick = async (slot: number) => {
    setKicking(slot);
    setError(null);
    try {
      await match.actions.kick(slot);
    } catch (e) {
      setError(compText(e));
    } finally {
      setKicking(null);
    }
  };

  let status: ReactNode;
  if (me.isHost) {
    if (others.length === 0) status = <p className="lobby-status">Ждём соперника: отправь ему код или ссылку<span className="dots" aria-hidden="true" /></p>;
    else if (!me.staked) status = <p className="lobby-status">Поставь {STAKE_SIZE} асыков, чтобы начать.</p>;
    else if (!allStaked) status = <p className="lobby-status">Ждём ставку: {others.filter((p) => !p.staked).map((p) => p.name).join(', ')}<span className="dots" aria-hidden="true" /></p>;
    else status = <p className="lobby-status lobby-status--ready">Ставки сделаны — можно бросать жребий!</p>;
  } else if (props.autoRematch && me.staked) {
    status = <p className="lobby-status">Реванш! Ждём соперника<span className="dots" aria-hidden="true" /></p>;
  } else {
    status = me.staked ? (
      <p className="lobby-status">Ждём, пока хозяин бросит жребий<span className="dots" aria-hidden="true" /></p>
    ) : (
      <p className="lobby-status">Поставь {STAKE_SIZE} асыков — без ставки матч не начнётся.</p>
    );
  }

  return (
    <Page kicker="Матч на асыки" title="Лобби матча" onBack={() => (me.isHost ? leave.setConfirm(true) : void leave.leave())} backLabel="Выйти">
      <CompCodeCard code={state.match.joinCode} />

      <section className="lobby-card lobby-card--status" aria-live="polite">
        <CompSlots state={state} stage="forming" onKick={me.isHost ? kick : undefined} kicking={kicking} />
        {status}
        {match.warning && <p className="setup__hint code-hint code-hint--error">{compText(match.warning)}</p>}
        {(error || leave.error) && (
          <p className="setup__hint code-hint code-hint--error" role="alert">
            {error ?? leave.error}
          </p>
        )}
        <div className="comp-actions">
          {me.staked ? (
            <button className="btn" onClick={() => run('unstake', () => match.actions.unstake())} disabled={busy !== null}>
              {busy === 'unstake' ? 'Забираем…' : 'Забрать ставку'}
            </button>
          ) : (
            <button
              className="btn btn--sun btn--xl btn--block"
              onClick={() => {
                sound.uiClick();
                setStakeError(null);
                setStakeOpen(true);
              }}
              disabled={busy !== null}
            >
              <AsykIcon size={26} /> Поставить {STAKE_SIZE}
            </button>
          )}
          {me.isHost && (
            <button className="btn btn--primary btn--xl btn--block" onClick={() => run('start', () => match.actions.start())} disabled={busy !== null || !allStaked}>
              <Icon name="dice" /> {busy === 'start' ? 'Бросаем…' : 'Бросить жребий'}
            </button>
          )}
        </div>
        {me.staked && <p className="doc__muted comp-note">Твои {STAKE_SIZE} асыков уже в коне. До старта ставку можно забрать.</p>}
      </section>

      <section className="lobby-card lobby-layout">
        <span className="layout-option__preview">
          <LevelPreview level={layout} />
        </span>
        <div>
          <b>
            {layout.name} <small>{layout.kazName}</small>
          </b>
          {me.isHost ? (
            <button
              className="btn comp-layout-change"
              onClick={() => {
                sound.uiClick();
                setLayoutOpen(true);
              }}
              disabled={busy !== null}
            >
              <Icon name="grid" /> Сменить кон
            </button>
          ) : (
            <p className="doc__muted">Кон выбирает хозяин.</p>
          )}
          <p className="doc__muted">
            {asyks(layout.asyks.length)}: по {STAKE_SIZE} от каждого. По {state.match.throwsPerPlayer} бросков, на ход — {state.match.turnSeconds} с. Кто бросает первым и где
            чей асык, решит жребий сервера.
          </p>
        </div>
      </section>

      {layoutOpen && (
        <Modal labelledBy="comp-layout-title" onClose={busy === 'layout' ? undefined : () => setLayoutOpen(false)} className="modal--layouts">
          <h2 id="comp-layout-title" className="modal__title">
            Выбери кон
          </h2>
          <p className="modal__text">Ставки остаются: в любом коне по {STAKE_SIZE} асыков от каждого.</p>
          <StakeLayoutPicker value={state.match.layoutId} onChange={(id) => void changeLayout(id)} />
          <button className="btn btn--ghost btn--block" onClick={() => setLayoutOpen(false)} disabled={busy === 'layout'}>
            Закрыть
          </button>
        </Modal>
      )}
      {stakeOpen && <StakeModal free={props.freeAsyks} busy={busy === 'stake'} error={stakeError} onConfirm={() => void stake()} onClose={() => setStakeOpen(false)} />}
      {leave.confirm && (
        <LeaveModal
          text="Ты хозяин: если выйдешь, матч отменится, а ставки вернутся всем."
          busy={leave.busy}
          onLeave={() => void leave.leave()}
          onClose={() => leave.setConfirm(false)}
        />
      )}
    </Page>
  );
}

function ReadyView(props: RoomProps) {
  const { state, match } = props;
  const [, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const leave = useLeave(props);
  useEffect(() => {
    const t = window.setInterval(() => setTick((x) => x + 1), 500);
    return () => window.clearInterval(t);
  }, []);
  const deadline = state.match.readyDeadline === null ? null : toLocalTime(state, state.match.readyDeadline);
  const left = deadline === null ? null : Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  const waiting = state.players.filter((p) => !p.ready);

  const ready = async () => {
    sound.uiClick();
    setBusy(true);
    setError(null);
    try {
      await match.actions.ready();
    } catch (e) {
      setError(compText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page kicker="Матч на асыки" title="Все на месте?" onBack={() => leave.setConfirm(true)} backLabel="Выйти">
      <p className="doc__lead">
        Каждый подтверждает, что он здесь: пока вкладка открыта, экран отвечает сам. Потом сервер бросит жребий — кто ходит
        первым и где чей асык.
      </p>
      <section className="lobby-card lobby-card--status" aria-live="polite">
        {left !== null && (
          <p className={`comp-countdown${left <= 10 ? ' comp-countdown--low' : ''}`} aria-label={`Осталось ${left} секунд`}>
            {left} с
          </p>
        )}
        <CompSlots state={state} stage="ready" kicking={null} />
        {state.me.ready ? (
          <p className={`lobby-status${waiting.length ? '' : ' lobby-status--ready'}`}>
            {waiting.length ? (
              <>
                Ты на месте ✓ Ждём: {waiting.map((p) => p.name).join(', ')}
                <span className="dots" aria-hidden="true" />
              </>
            ) : (
              'Все на месте — начинаем!'
            )}
          </p>
        ) : (
          <button className="btn btn--primary btn--xl btn--block" onClick={() => void ready()} disabled={busy} data-autofocus>
            {busy ? 'Отмечаем…' : 'Я здесь'}
          </button>
        )}
        {left === 0 && <p className="lobby-status">Время вышло. Если не все на месте, матч отменится и ставки вернутся.</p>}
        {match.warning && <p className="setup__hint code-hint code-hint--error">{compText(match.warning)}</p>}
        {(error || leave.error) && (
          <p className="setup__hint code-hint code-hint--error" role="alert">
            {error ?? leave.error}
          </p>
        )}
      </section>
      {leave.confirm && (
        <LeaveModal text="Матч отменится, ставки вернутся всем." busy={leave.busy} onLeave={() => void leave.leave()} onClose={() => leave.setConfirm(false)} />
      )}
    </Page>
  );
}
