import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

const inner = (file) => {
  const s = readFileSync(new URL(file, import.meta.url), 'utf8');
  return s.replace(/<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
};

const card = (cx, cy, w, h, r, deg, fill) =>
  `<g transform="translate(${cx} ${cy}) rotate(${deg})"><rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="${r}" fill="${fill}"/></g>`;

const standard = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240">
<rect width="240" height="240" rx="54" fill="#0a0a0a"/>
${card(131.09, 93.445, 120, 96, 22, -9, '#66b6ff')}
${card(109.77, 134.6, 124, 100, 22, 7, '#438bee')}
${card(125.1, 149.19, 126, 104, 22, -2, '#fafafa')}
<g transform="translate(97.32 125.42)">${inner('ast-240.svg')}</g>
</svg>`;

const maskable = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">
<rect width="120" height="120" fill="#0a0a0a"/>
${card(65.545, 46.72, 60, 48, 11, -9, '#66b6ff')}
${card(54.886, 67.3, 62, 50, 11, 7, '#438bee')}
${card(62.548, 74.59, 63, 52, 11, -2, '#fafafa')}
<g transform="translate(48.66 62.71)">${inner('ast-120.svg')}</g>
</svg>`;

writeFileSync(new URL('../public/favicon.svg', import.meta.url), standard);
await sharp(Buffer.from(standard), { density: 384 }).resize(192, 192).png().toFile(new URL('../public/icon-192.png', import.meta.url).pathname.slice(1));
await sharp(Buffer.from(standard), { density: 384 }).resize(512, 512).png().toFile(new URL('../public/icon-512.png', import.meta.url).pathname.slice(1));
await sharp(Buffer.from(maskable), { density: 768 }).resize(512, 512).png().toFile(new URL('../public/icon-maskable-512.png', import.meta.url).pathname.slice(1));
console.log('icons written');
