import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sound } from './game/audio/sound';
import { LEVELS } from './game/levels/levels';
import type { RoundResult } from './game/types';
import { applyRoundResult, emptySave, isLevelUnlocked, loadSave, writeSave, type RecordOutcome, type SaveData } from './storage/progress';
import { hashToRoute, routeToHash, type Route } from './ui/routes';
import { AboutScreen } from './ui/screens/AboutScreen';
import { GameScreen } from './ui/screens/GameScreen';
import { HowToScreen } from './ui/screens/HowToScreen';
import { LevelSelectScreen } from './ui/screens/LevelSelectScreen';
import { MenuScreen } from './ui/screens/MenuScreen';
import { RecordsScreen } from './ui/screens/RecordsScreen';

const LEVEL_IDS = LEVELS.map((l) => l.id);

const TITLES: Record<Route['name'], string> = {
  MENU: 'Асық ату — прицелься, брось, выбей асық',
  HOW_TO: 'Как играть · Асық ату',
  LEVEL_SELECT: 'Испытания · Асық ату',
  PLAYING: 'Игра · Асық ату',
  RECORDS: 'Рекорды · Асық ату',
  ABOUT: 'Об игре · Асық ату',
};

export function App() {
  const [route, setRoute] = useState<Route>(() => hashToRoute(window.location.hash));
  const [save, setSave] = useState<SaveData>(() => loadSave());
  const saveRef = useRef(save);
  saveRef.current = save;
  const depth = useRef(0);

  const reducedMotion = useMemo(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false, []);

  useEffect(() => sound.setMuted(save.settings.muted), [save.settings.muted]);

  useEffect(() => {
    const onHash = () => setRoute(hashToRoute(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    document.title = TITLES[route.name];
    if (route.name !== 'PLAYING') window.scrollTo(0, 0);
  }, [route]);

  const updateSave = useCallback((fn: (s: SaveData) => SaveData) => {
    const next = fn(saveRef.current);
    saveRef.current = next;
    writeSave(next);
    setSave(next);
  }, []);

  const navigate = useCallback((r: Route) => {
    const hash = routeToHash(r);
    if (window.location.hash !== hash) {
      depth.current += 1;
      window.location.hash = hash;
    } else {
      setRoute(r);
    }
  }, []);

  const back = useCallback(() => {
    if (depth.current > 0) {
      depth.current -= 1;
      window.history.back();
    } else {
      navigate({ name: 'MENU' });
    }
  }, [navigate]);

  const toggleMute = useCallback(() => {
    sound.unlock();
    updateSave((s) => ({ ...s, settings: { ...s.settings, muted: !s.settings.muted } }));
  }, [updateSave]);

  const onRoundComplete = useCallback(
    (r: RoundResult): RecordOutcome => {
      const outcome = applyRoundResult(saveRef.current, r);
      updateSave(() => outcome.save);
      return outcome;
    },
    [updateSave],
  );

  const onTutorialDone = useCallback(() => {
    updateSave((s) => ({ ...s, settings: { ...s.settings, tutorialDone: true } }));
  }, [updateSave]);

  const resetProgress = useCallback(() => {
    updateSave((s) => ({ ...emptySave(), settings: { ...s.settings, tutorialDone: false } }));
  }, [updateSave]);

  const isUnlocked = useCallback((id: string) => isLevelUnlocked(saveRef.current, LEVEL_IDS, id), []);

  // закрытое или несуществующее испытание в адресе → экран выбора
  const playLevel = route.name === 'PLAYING' ? LEVELS.find((l) => l.id === route.levelId) : undefined;
  const invalidPlay = route.name === 'PLAYING' && (!playLevel || !isLevelUnlocked(save, LEVEL_IDS, route.levelId));
  useEffect(() => {
    if (invalidPlay) window.location.replace(routeToHash({ name: 'LEVEL_SELECT' }));
  }, [invalidPlay]);

  // первый звук разблокируем по первому жесту на любом экране
  useEffect(() => {
    const unlock = () => sound.unlock();
    window.addEventListener('pointerdown', unlock, { once: true });
    return () => window.removeEventListener('pointerdown', unlock);
  }, []);

  switch (route.name) {
    case 'MENU':
      return <MenuScreen save={save} muted={save.settings.muted} onToggleMute={toggleMute} onNavigate={navigate} />;
    case 'HOW_TO':
      return <HowToScreen onNavigate={navigate} onBack={back} />;
    case 'LEVEL_SELECT':
      return <LevelSelectScreen save={save} onNavigate={navigate} onBack={() => navigate({ name: 'MENU' })} />;
    case 'RECORDS':
      return <RecordsScreen save={save} onReset={resetProgress} onNavigate={navigate} onBack={back} />;
    case 'ABOUT':
      return <AboutScreen onNavigate={navigate} onBack={back} />;
    case 'PLAYING':
      if (!playLevel || invalidPlay) return null;
      return (
        <GameScreen
          key={playLevel.id}
          level={playLevel}
          tutorial={!save.settings.tutorialDone}
          muted={save.settings.muted}
          reducedMotion={reducedMotion}
          isUnlocked={isUnlocked}
          onToggleMute={toggleMute}
          onRoundComplete={onRoundComplete}
          onTutorialDone={onTutorialDone}
          onNavigate={navigate}
        />
      );
  }
}
