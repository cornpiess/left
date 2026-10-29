import { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { learnExperience, nextExperienceHint } from './experienceHints.mjs';
const KEY = 'vibe-experience-hints-v1';
export default function useExperienceHints() {
  const [state, setState] = useState(null);
  const [display, setDisplay] = useState({ ready: false, browsingCount: 0 });
  const stateRef = useRef(null);
  const early = useRef({});
  const writes = useRef(Promise.resolve());
  const lastDisplayed = useRef(null);
  useEffect(() => {
    let alive = true;
    Promise.all([AsyncStorage.getItem(KEY), AsyncStorage.getItem('vibe-swipe-coach-done')]).then(([raw, legacy]) => {
      if (!alive) return;
      let saved = {};
      try { saved = raw ? JSON.parse(raw) || {} : legacy === '1' ? { dismissed: true } : {}; } catch {}
      stateRef.current = { ...saved, ...early.current };
      setState(stateRef.current);
      const data = JSON.stringify(stateRef.current);
      writes.current = writes.current.catch(() => {}).then(() => AsyncStorage.setItem(KEY, data));
    }).catch(() => { if (alive) { stateRef.current = { dismissed: true }; setState(stateRef.current); } });
    return () => { alive = false; };
  }, []);
  const learn = useCallback(event => {
    if (!stateRef.current) { early.current = learnExperience(early.current, event); return; }
    const next = learnExperience(stateRef.current, event);
    if (JSON.stringify(next) === JSON.stringify(stateRef.current)) return;
    stateRef.current = next;
    setState(next);
    const data = JSON.stringify(next);
    writes.current = writes.current.catch(() => {}).then(() => AsyncStorage.setItem(KEY, data));
  }, []);
  const shown = useCallback((item, moved) => {
    if (moved) learn('browse');
    if (lastDisplayed.current === item.id) return;
    lastDisplayed.current = item.id;
    setDisplay(prev => ({ ready: true, browsingCount: Math.min(3, prev.browsingCount + 1) }));
  }, [learn]);
  return { hint: nextExperienceHint(state, display), learn, shown };
}
