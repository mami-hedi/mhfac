// Prépare un logo choisi par l'utilisateur : le redimensionne et le compresse DANS LE NAVIGATEUR pour qu'un logo réel (souvent plusieurs Mo)
// soit accepté sans que l'utilisateur ait à retoucher son fichier. Le serveur revalide tout (type réel, taille) : ceci n'est qu'une commodité.
export const LOGO_SOURCE_MAX = 8 * 1024 * 1024; // fichier d'origine
const TARGET_CHARS = 300_000; // taille maximale du texte base64 produit (le serveur accepte 400 000)
const MAX_W = 600; const MAX_H = 300;
const TYPES = ['image/png', 'image/jpeg', 'image/webp'];

const load = (file) => new Promise((resolve, reject) => {
  const url = URL.createObjectURL(file); const img = new Image();
  img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
  img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image illisible : choisissez un fichier PNG ou JPEG valide.')); };
  img.src = url;
});

function draw(img, scale, mime, quality) {
  const w = Math.max(1, Math.round(img.naturalWidth * scale)); const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (mime === 'image/jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h); } // JPEG n'a pas de transparence : fond blanc
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL(mime, quality);
}

export async function prepareLogo(file) {
  if (!TYPES.includes(file.type)) throw new Error('Format non pris en charge : utilisez une image PNG ou JPEG.');
  if (file.size > LOGO_SOURCE_MAX) throw new Error('Fichier trop volumineux (8 Mo maximum).');
  const img = await load(file);
  if (!img.naturalWidth || !img.naturalHeight) throw new Error('Image illisible.');
  let scale = Math.min(1, MAX_W / img.naturalWidth, MAX_H / img.naturalHeight); // jamais d'agrandissement
  let mime = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png'; // PNG/WebP -> PNG (transparence conservée)
  let quality = 0.92;
  for (let i = 0; i < 12; i += 1) {
    const out = draw(img, scale, mime, quality);
    if (out.length <= TARGET_CHARS) return out;
    if (mime === 'image/jpeg' && quality > 0.6) quality -= 0.1; else if (i >= 3 && mime === 'image/png') mime = 'image/jpeg'; else scale *= 0.8;
  }
  throw new Error('Impossible de réduire ce logo à une taille acceptable : choisissez une image plus simple.');
}
