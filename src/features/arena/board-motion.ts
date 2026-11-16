'use client';
import { useSyncExternalStore } from 'react';

const preferenceKey = 'deepmove:board-animations';
const preferenceEvent = 'deepmove:board-animations-changed';
const reducedMotionQuery = '(prefers-reduced-motion: reduce)';
let volatilePreference = true;

function readPreference() {
  try { return localStorage.getItem(preferenceKey) !== 'off'; }
  catch { return volatilePreference; }
}
function subscribePreference(notify: () => void) {
  const onStorage = (event: StorageEvent) => { if (event.key === preferenceKey || event.key === null) notify(); };
  window.addEventListener('storage', onStorage);
  window.addEventListener(preferenceEvent, notify);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(preferenceEvent, notify);
  };
}
function setEnabled(enabled: boolean) {
  volatilePreference = enabled;
  try { localStorage.setItem(preferenceKey, enabled ? 'on' : 'off'); } catch { /* Still works when storage is unavailable. */ }
  window.dispatchEvent(new Event(preferenceEvent));
}
function subscribeReducedMotion(notify: () => void) {
  const query = matchMedia(reducedMotionQuery);
  query.addEventListener('change', notify);
  return () => query.removeEventListener('change', notify);
}
const readReducedMotion = () => matchMedia(reducedMotionQuery).matches;
const serverEnabled = () => true;
const serverReducedMotion = () => false;

export function useBoardAnimations() {
  const enabled = useSyncExternalStore(subscribePreference, readPreference, serverEnabled);
  const reduced = useSyncExternalStore(subscribeReducedMotion, readReducedMotion, serverReducedMotion);
  return { animate: enabled && !reduced, reduced, setEnabled };
}
