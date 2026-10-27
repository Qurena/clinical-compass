// Звук доступен после действия пользователя; визуальный сигнал остаётся основным.
export function createAlertSound(AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext) {
  let context = null;
  return {
    get enabled() { return !!context && context.state === 'running'; },
    get supported() { return !!AudioContextClass; },
    async enable() {
      if (!AudioContextClass) return false;
      try { context ||= new AudioContextClass(); await context.resume(); return context.state === 'running'; }
      catch { return false; }
    },
    play() {
      if (!context || context.state !== 'running') return false;
      try {
        const now = context.currentTime;
        for (let i = 0; i < 3; i++) {
          const oscillator = context.createOscillator(); const gain = context.createGain();
          oscillator.type = 'sine'; oscillator.frequency.value = 660;
          gain.gain.setValueAtTime(0.0001, now + i * 0.35);
          gain.gain.exponentialRampToValueAtTime(0.15, now + i * 0.35 + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.35 + 0.22);
          oscillator.connect(gain); gain.connect(context.destination);
          oscillator.start(now + i * 0.35); oscillator.stop(now + i * 0.35 + 0.23);
        }
        return true;
      } catch { return false; }
    }
  };
}
