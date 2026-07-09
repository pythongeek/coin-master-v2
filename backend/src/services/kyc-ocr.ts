import { createWorker, PSM } from 'tesseract.js';
import path from 'path';

/**
 * ═══════════════════════════════════════════════════════════════
 *  KYC OCR — Open-source OCR using tesseract.js
 * ═══════════════════════════════════════════════════════════════
 *
 *  Uses a locally cached English traineddata file so the first
 *  production KYC call doesn't fail waiting for a CDN download.
 */

let workerPromise: Promise<Tesseract.Worker> | null = null;

export async function getOcrWorker(): Promise<Tesseract.Worker> {
  if (!workerPromise) {
    workerPromise = createWorker('eng', 1, {
      logger: () => {}, // silent in production
      langPath: path.resolve(__dirname, '../../tesseract-lang'),
      errorHandler: () => {},
    });
  }
  return workerPromise;
}

export interface OcrResult {
  text: string;
  confidence: number;
}

export async function runOcr(imageBase64: string): Promise<OcrResult> {
  const worker = await getOcrWorker();
  const {
    data: { text, confidence },
  } = await worker.recognize(imageBase64);
  return { text: text.trim(), confidence };
}

export async function terminateOcrWorker(): Promise<void> {
  if (workerPromise) {
    const worker = await workerPromise;
    await worker.terminate();
    workerPromise = null;
  }
}
