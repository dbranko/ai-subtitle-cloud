import type { AppNotification } from './api';

const DESKTOP_KEY = 'asc.desktopNotifications';
const SOUND_KEY = 'asc.sound';

export const desktopSupported = () => typeof window !== 'undefined' && 'Notification' in window;

/** Desktop notifications are shown only after the owner turned them on AND the browser allows them. */
export const desktopEnabled = () =>
  desktopSupported() &&
  localStorage.getItem(DESKTOP_KEY) === 'on' &&
  Notification.permission === 'granted';

/** Ask the browser for permission. Must be called from a click. */
export async function enableDesktop(): Promise<boolean> {
  if (!desktopSupported()) return false;
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return false;
  localStorage.setItem(DESKTOP_KEY, 'on');
  return true;
}
export const disableDesktop = () => localStorage.setItem(DESKTOP_KEY, 'off');

/** Sound is off unless the owner switched it on. */
export const soundEnabled = () => localStorage.getItem(SOUND_KEY) === 'on';
export const setSound = (on: boolean) => localStorage.setItem(SOUND_KEY, on ? 'on' : 'off');

function beep(success: boolean): void {
  try {
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = success ? 880 : 330;
    gain.gain.setValueAtTime(0.08, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.4);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.4);
  } catch {
    // Audio is optional; ignore browsers that block it.
  }
}

/** Alert the owner about one notification. The caller guarantees it is called once per notification. */
export function alertUser(notification: AppNotification): void {
  if (desktopEnabled()) {
    try {
      // `tag` makes the browser itself collapse a repeated notification for the same event.
      new Notification(notification.title, { body: notification.message, tag: notification.id });
    } catch {
      // Some browsers only allow notifications from a service worker; the in-app list still shows it.
    }
  }
  if (soundEnabled()) beep(notification.kind === 'completed');
}
