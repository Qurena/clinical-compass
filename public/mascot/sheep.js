// Овечка — лёгкий маскот: только картинки (WebP + PNG-запас), без 3D и без запросов к API.
// Чистая функция разметки: не использует клинические данные, баллы и награды.
export const BASE = '/mascot/sheep/';
export const V = '1';
// Размеры 1x-спрайтов (px), нужны для width/height и отсутствия сдвига вёрстки.
export const SIZES = Object.freeze({
  wave: [430, 480], happy: [480, 480], cheer: [448, 480], care: [445, 480],
});
export const POSES = Object.freeze(Object.keys(SIZES));
export const poseOf = (pose) => (typeof pose === 'string' && Object.hasOwn(SIZES, pose) ? pose : 'wave');
export const srcOf = (pose, ext = 'webp', retina = false) => `${BASE}${poseOf(pose)}-sm${retina ? '@2x' : ''}.${ext}?v=${V}`;
const SIZE_CLASSES = new Set(['sm', 'lg']);
const classOf = (cls) => String(cls || '').split(/\s+/).filter((c) => SIZE_CLASSES.has(c)).join(' ');

export function sheepHTML(pose, cls = '') {
  const p = poseOf(pose), [w, h] = SIZES[p], c = classOf(cls);
  // care — спокойная поза: без покачивания (data-calm).
  return `<span class="sheep ${c}" data-pose="${p}"${p === 'care' ? ' data-calm' : ''} role="img" aria-label="Добрая овечка"><picture>`
    + `<source type="image/webp" srcset="${srcOf(p)} 1x, ${srcOf(p, 'webp', true)} 2x">`
    + `<img src="${srcOf(p, 'png')}" srcset="${srcOf(p, 'png')} 1x, ${srcOf(p, 'png', true)} 2x" alt="" width="${w}" height="${h}" decoding="async"${p === 'care' ? '' : ' loading="lazy"'}>`
    + `</picture></span>`;
}
