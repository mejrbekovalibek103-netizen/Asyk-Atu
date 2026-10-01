import { AsykIcon } from '../components/AsykIcon';
import { Icon } from '../components/Icon';
import { Ornament } from '../components/Ornament';
import type { Route } from '../routes';

const SIDES = ['Алшы', 'Тәйкі', 'Бүк', 'Шік'];

export function AboutScreen({ onNavigate, onBack }: { onNavigate: (r: Route) => void; onBack: () => void }) {
  return (
    <main className="page page--doc">
      <article className="doc">
        <button className="back-btn" onClick={onBack}>
          <Icon name="back" /> Назад
        </button>
        <h1 className="doc__title">Об игре</h1>
        <p className="doc__lead">Асық ату — традиционная казахская игра на меткость с асыками, косточками из бараньего сустава.</p>

        <section className="doc__section">
          <h2>Как играют во дворе</h2>
          <p>
            Асыки выставляют в ряд — это <b>кон</b>. Игроки по очереди с расстояния бросают свой <b>сақа</b> — особый асык, обычно
            крупнее и тяжелее остальных, — и стараются выбить асыки из ряда. Выбитые асыки забирает игрок. Правила в разных
            дворах и регионах отличаются: меняются расстояние, расстановка и очерёдность.
          </p>
          <p>
            Сақа часто красили, а внутрь заливали свинец — такой сақа называют <b>«құйма сақа»</b>. В нашей версии он тоже красный и
            с металлической вставкой, а в физике — тяжелее обычного асыка.
          </p>
        </section>

        <section className="doc__section">
          <h2>Четыре стороны асыка</h2>
          <ul className="sides">
            {SIDES.map((name, i) => (
              <li key={name}>
                <AsykIcon size={44} rotate={i * 12 - 18} />
                <b>{name}</b>
              </li>
            ))}
          </ul>
          <p>
            Так называют четыре положения, в которых асык может оказаться после броска. Во многих дворовых играх от выпавшей
            стороны зависит очерёдность или выигрыш.
          </p>
          <p className="doc__muted">В нашей версии у каждого асыка свой «рисунок» стороны — только для красоты, на физику он не влияет.</p>
        </section>

        <section className="doc__section">
          <h2>Зачем цифровая версия</h2>
          <p>
            Игра тренирует глазомер, терпение и честность — и собирает детей со всего двора. Традиционные игры с асыками внесены в
            список нематериального культурного наследия ЮНЕСКО (2016). Эта версия — попытка показать асық ату новому поколению: тем,
            кто играл в детстве, тем, кто только слышал о нём от родителей, и тем, кто знакомится с казахской культурой впервые.
          </p>
        </section>

        <Ornament className="doc__ornament doc__ornament--center" />

        <div className="doc__actions">
          <button className="btn btn--primary btn--xl" onClick={() => onNavigate({ name: 'LEVEL_SELECT' })}>
            <Icon name="play" /> Сыграть
          </button>
        </div>
      </article>
    </main>
  );
}
