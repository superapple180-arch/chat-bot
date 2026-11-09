import fs from 'node:fs';
import sharp from 'sharp';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect x="16" y="16" width="480" height="480" rx="126" fill="#2868d6"/><path d="M146 142h220a34 34 0 0 1 34 34v126a34 34 0 0 1-34 34H238l-79 54v-54h-13a34 34 0 0 1-34-34V176a34 34 0 0 1 34-34Z" fill="white"/><path d="M179 225h154m-154 47h101" stroke="#2868d6" stroke-width="20" stroke-linecap="round"/></svg>';
fs.mkdirSync('desktop-app', { recursive: true });
await sharp(Buffer.from(svg)).png().toFile('desktop-app/icon.png');
