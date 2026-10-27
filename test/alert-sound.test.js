import test from 'node:test';
import assert from 'node:assert/strict';
import {createAlertSound} from '../public/alert-sound.js';

test('без разрешённого аудио сигнал не сообщает об успешном воспроизведении', async () => {
  const sound = createAlertSound(null);
  assert.equal(sound.play(), false);
  assert.equal(await sound.enable(), false);
});

test('после включения звука красный сигнал запускает три тона', async () => {
  let count = 0;
  class MockContext {
    state = 'suspended'; currentTime = 0; destination = {};
    async resume() { this.state = 'running'; }
    createOscillator() { return {type:'',frequency:{value:0},connect(){},start(){count++;},stop(){}}; }
    createGain() { return {gain:{setValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){}}; }
  }
  const sound = createAlertSound(MockContext);
  assert.equal(sound.play(), false);
  assert.equal(await sound.enable(), true);
  assert.equal(sound.play(), true);
  assert.equal(count, 3);
});
