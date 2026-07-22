import sharp, { type Sharp } from 'sharp';

/**
 * ═══════════════════════════════════════════════════════════════
 *  KYC IMAGE QUALITY — Open-source image quality checks
 * ═══════════════════════════════════════════════════════════════
 *
 *  Uses sharp to compute basic stats: dimensions, brightness, blur,
 *  and file size. These are lightweight signals that protect against
 *  obviously bad submissions before we spend MiniMax tokens.
 */

export interface ImageQualityResult {
  width: number;
  height: number;
  format: string;
  sizeBytes: number;
  brightness: number; // 0-255 average
  blurScore: number; // higher = sharper
  acceptable: boolean;
  reasons: string[];
}

async function computeLaplacianVariance(image: Sharp): Promise<number> {
  // Convert to grayscale and resize to a fixed small size for speed
  const { data, info } = await image
    .clone()
    .greyscale()
    .resize(512, 512, { fit: 'inside' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;
  let sum = 0;
  let sumSq = 0;
  const count = (height - 2) * (width - 2);
  if (count <= 0) return 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      const val =
        4 * data[idx] -
        data[idx - 1] -
        data[idx + 1] -
        data[idx - width] -
        data[idx + width];
      sum += val;
      sumSq += val * val;
    }
  }

  const mean = sum / count;
  return sumSq / count - mean * mean;
}

export async function checkImageQuality(
  imageBase64: string,
  label: 'document' | 'selfie',
): Promise<ImageQualityResult> {
  const buffer = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  if (buffer.length === 0) {
    return {
      width: 0,
      height: 0,
      format: 'unknown',
      sizeBytes: 0,
      brightness: 0,
      blurScore: 0,
      acceptable: false,
      reasons: ['Empty image buffer'],
    };
  }

  const image = sharp(buffer);
  const metadata = await image.metadata();
  const stats = await image.stats();
  const brightness = stats.channels[0]?.mean ?? 0;
  const blurScore = await computeLaplacianVariance(image);

  const width = metadata.width || 0;
  const height = metadata.height || 0;
  const format = metadata.format || 'unknown';
  const reasons: string[] = [];

  if (width < 300 || height < 300) reasons.push(`${label} resolution too low`);
  if (buffer.length > 10 * 1024 * 1024) reasons.push(`${label} file too large`);
  if (brightness < 30 || brightness > 240) reasons.push(`${label} poor lighting`);
  if (blurScore < 100) reasons.push(`${label} too blurry`);

  return {
    width,
    height,
    format,
    sizeBytes: buffer.length,
    brightness,
    blurScore,
    acceptable: reasons.length === 0,
    reasons,
  };
}

export async function normalizeImage(imageBase64: string, maxDimension = 1500): Promise<string> {
  const buffer = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  const processed = await sharp(buffer)
    .rotate() // auto-orient from EXIF
    .resize(maxDimension, maxDimension, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85, progressive: true })
    .toBuffer();
  return `data:image/jpeg;base64,${processed.toString('base64')}`;
}
