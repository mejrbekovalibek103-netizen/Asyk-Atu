import type { RoundResult } from '../game/types';

/**
 * Локальное сохранение прогресса (localStorage).
 * Данные живут только в этом браузере на этом устройстве — глобального рейтинга нет.
 */

const KEY = 'asyk-atu:save:v1';

export interface LevelProgress {
  bestScore: number;
  bestKnocked: number;
  stars: number;
  passed: boolean;
  plays: number;
}

export interface SaveData {
  version: 1;
  levels: Record<string, LevelProgress>;
  stats: {
    roundsPlayed: number;
    throws: number;
    hitThrows: number;
    asyksKnocked: number;
    bestScore: number;
    bestKnocked: number;
    bestCombo: number;
  };
  settings: {
    muted: boolean;
    tutorialDone: boolean;
    /** Имена из последнего матча вдвоём. */
    duelNames: [string, string];
    duelLayout: string;
    /** Имя для онлайн-матчей. */
    onlineName: string;
  };
}

export function emptySave(): SaveData {
  return {
    version: 1,
    levels: {},
    stats: { roundsPlayed: 0, throws: 0, hitThrows: 0, asyksKnocked: 0, bestScore: 0, bestKnocked: 0, bestCombo: 0 },
    settings: { muted: false, tutorialDone: false, duelNames: ['', ''], duelLayout: 'ulken-kon', onlineName: '' },
  };
}

const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 32) : '');
const num = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback);

/** Безопасное чтение: повреждённые или чужие данные не ломают игру. */
export function loadSave(): SaveData {
  const base = emptySave();
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return base;
    const data = JSON.parse(raw) as Partial<SaveData>;
    if (!data || typeof data !== 'object') return base;
    const levels: Record<string, LevelProgress> = {};
    for (const [id, lp] of Object.entries(data.levels ?? {})) {
      if (!lp || typeof lp !== 'object') continue;
      levels[id] = {
        bestScore: num(lp.bestScore),
        bestKnocked: num(lp.bestKnocked),
        stars: Math.min(3, num(lp.stars)),
        passed: !!lp.passed,
        plays: num(lp.plays),
      };
    }
    const s = (data.stats ?? {}) as Partial<SaveData['stats']>;
    return {
      version: 1,
      levels,
      stats: {
        roundsPlayed: num(s.roundsPlayed),
        throws: num(s.throws),
        hitThrows: num(s.hitThrows),
        asyksKnocked: num(s.asyksKnocked),
        bestScore: num(s.bestScore),
        bestKnocked: num(s.bestKnocked),
        bestCombo: num(s.bestCombo),
      },
      settings: {
        muted: !!data.settings?.muted,
        tutorialDone: !!data.settings?.tutorialDone,
        duelNames: [str(data.settings?.duelNames?.[0]), str(data.settings?.duelNames?.[1])],
        duelLayout: str(data.settings?.duelLayout) || base.settings.duelLayout,
        onlineName: str(data.settings?.onlineName),
      },
    };
  } catch {
    return base;
  }
}

export function writeSave(data: SaveData): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(data));
  } catch {
    // приватный режим / переполнение — игра продолжает работать без сохранения
  }
}

export interface RecordOutcome {
  save: SaveData;
  isNewRecord: boolean;
  previousBest: number;
  levelBest: number;
}

/** Применяет результат раунда к сохранению (чистая функция — удобно тестировать). */
export function applyRoundResult(save: SaveData, r: RoundResult): RecordOutcome {
  const prev = save.levels[r.levelId] ?? { bestScore: 0, bestKnocked: 0, stars: 0, passed: false, plays: 0 };
  const isNewRecord = r.score > prev.bestScore && r.score > 0;
  const level: LevelProgress = {
    bestScore: Math.max(prev.bestScore, r.score),
    bestKnocked: Math.max(prev.bestKnocked, r.knocked),
    stars: Math.max(prev.stars, r.stars),
    passed: prev.passed || r.passed,
    plays: prev.plays + 1,
  };
  const st = save.stats;
  const next: SaveData = {
    ...save,
    levels: { ...save.levels, [r.levelId]: level },
    stats: {
      roundsPlayed: st.roundsPlayed + 1,
      throws: st.throws + r.throwsUsed,
      hitThrows: st.hitThrows + r.hitThrows,
      asyksKnocked: st.asyksKnocked + r.knocked,
      bestScore: Math.max(st.bestScore, r.score),
      bestKnocked: Math.max(st.bestKnocked, r.knocked),
      bestCombo: Math.max(st.bestCombo, r.bestCombo),
    },
  };
  return { save: next, isNewRecord, previousBest: prev.bestScore, levelBest: level.bestScore };
}

export function isLevelUnlocked(save: SaveData, levelIds: string[], id: string): boolean {
  const i = levelIds.indexOf(id);
  if (i <= 0) return true;
  return !!save.levels[levelIds[i - 1]]?.passed;
}
