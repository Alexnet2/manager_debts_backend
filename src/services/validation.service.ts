import { FrameReading } from '../types';
import { ConfigService, ValidationConfig } from './config.service';

export class ValidationService {
  private config: ValidationConfig;

  constructor(configService: ConfigService) {
    this.config = configService.getValidationConfig();
  }

  validateReadings(readings: FrameReading[]): FrameReading[] {
    const valid = this.filterInvalidReadings(readings);
    // Fix OCR/segment values that slipped through with wrong numbers before interpolating
    let result = this.filterOutliersByMedian(valid);
    result = this.filterOutliersByMedian(result);
    // Now fill nulls (from segment returning null for 2-digit reads, or failed OCR)
    result = this.temporalInterpolate(result, readings);
    result = this.correctAnomalies(result);
    result = this.removeDuplicateConsecutive(result);
    result = this.smoothReadings(result);
    return result;
  }

  // ── filter ─────────────────────────────────────────────────────────────────

  private filterInvalidReadings(readings: FrameReading[]): FrameReading[] {
    return readings.filter((r) => {
      if (r.db === null || isNaN(r.db)) return false;
      if (r.db < this.config.minValue || r.db > this.config.maxValue) return false;
      return true;
    });
  }

  // ── temporal interpolation ─────────────────────────────────────────────────

  /**
   * For every frame that has db=null (both methods failed), linearly interpolate
   * from the nearest valid neighbours when at most MAX_GAP consecutive nulls are
   * present.  Fills gaps that would otherwise silently disappear from the output.
   *
   * `allReadings` is the original (unfiltered) array so that gaps caused by
   * filtering don't accidentally bridge large null stretches.
   */
  private temporalInterpolate(
    validReadings: FrameReading[],
    allReadings: FrameReading[],
  ): FrameReading[] {
    const MAX_GAP = 60;
    const result = [...validReadings];

    // Build a frame-index → valid-value map for quick lookup
    const byFrame = new Map<number, number>();
    for (const r of validReadings) {
      if (r.db !== null) byFrame.set(r.frame, r.db);
    }

    // Walk all readings looking for null runs inside small gaps
    let gapStart = -1;
    let gapFrames: FrameReading[] = [];

    const flush = (afterFrame: FrameReading | null): void => {
      if (gapFrames.length === 0 || gapFrames.length > MAX_GAP) {
        gapStart = -1;
        gapFrames = [];
        return;
      }

      const before = allReadings
        .slice(0, allReadings.indexOf(gapFrames[0]))
        .reverse()
        .find((r) => r.db !== null);
      const after = afterFrame?.db !== null ? afterFrame : null;

      if (!before || !after) {
        gapStart = -1;
        gapFrames = [];
        return;
      }

      const dbBefore = before.db!;
      const dbAfter = after.db!;
      const tBefore = before.frame;
      const tAfter = after.frame;
      const span = tAfter - tBefore;

      for (const r of gapFrames) {
        const t = (r.frame - tBefore) / span;
        const interpolated = parseFloat((dbBefore + (dbAfter - dbBefore) * t).toFixed(1));
        result.push({
          ...r,
          db: interpolated,
          confidence: 40,
          method: r.method,
          raw: String(interpolated),
        });
      }

      gapStart = -1;
      gapFrames = [];
    };

    for (let i = 0; i < allReadings.length; i++) {
      const r = allReadings[i];
      if (r.db === null) {
        gapFrames.push(r);
      } else {
        flush(r);
      }
    }
    flush(null);

    // Re-sort by frame after insertions
    result.sort((a, b) => a.frame - b.frame);
    return result;
  }

  // ── gross outlier filter ───────────────────────────────────────────────────

  /**
   * Replaces readings that deviate by more than 6× the smoothing threshold from
   * the local window median. Uses frames on BOTH sides of the current reading so
   * even the very first frame can be caught as an outlier.
   *
   * A 30 dB deviation from neighbors (6 × 5 dB default) is unambiguously a
   * misread — real meters cannot jump that far in under 0.3 s.
   * WINDOW=45 covers ±1.5 s at 30 fps so even a ~1.3 s run of bad reads is
   * outvoted by correct frames on both sides.
   */
  private filterOutliersByMedian(readings: FrameReading[]): FrameReading[] {
    if (readings.length < 5) return readings;

    const WINDOW = 45;
    const extremeThreshold = this.config.smoothingThreshold * 6;

    return readings.map((curr, i) => {
      if (curr.db === null) return curr;
      // Trust high-confidence segment readings: they come from a deterministic
      // pixel-level algorithm, not OCR guessing — real sound peaks reaching 100+ dBA
      // against a quieter background would otherwise be wrongly discarded as outliers.
      if (curr.confidence >= 70 && curr.method === 'segments') return curr;

      const lo = Math.max(0, i - WINDOW);
      const hi = Math.min(readings.length - 1, i + WINDOW);
      const neighbours: number[] = [];

      for (let j = lo; j <= hi; j++) {
        if (j !== i && readings[j].db !== null) neighbours.push(readings[j].db!);
      }

      if (neighbours.length < 4) return curr;

      const sorted = [...neighbours].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];

      if (Math.abs(curr.db - median) <= extremeThreshold) return curr;

      const corrected = parseFloat(median.toFixed(1));
      return { ...curr, db: corrected, confidence: 30, raw: String(corrected) };
    });
  }

  // ── anomaly correction ─────────────────────────────────────────────────────

  /**
   * If a low-confidence reading deviates more than 2× the smoothing threshold
   * from the local rolling median, snap it to that median.
   *
   * This handles cases like "7?.5" → 73.5 where OCR returned a plausible but
   * wrong number because of a single mis-recognised character.
   */
  private correctAnomalies(readings: FrameReading[]): FrameReading[] {
    const WINDOW = 5;
    const CONFIDENCE_GATE = 70;
    const threshold = this.config.smoothingThreshold * 2;

    return readings.map((curr, i) => {
      if (curr.db === null) return curr;
      if (curr.confidence >= CONFIDENCE_GATE) return curr;

      const lo = Math.max(0, i - WINDOW);
      const hi = Math.min(readings.length - 1, i + WINDOW);
      const neighbours: number[] = [];

      for (let j = lo; j <= hi; j++) {
        if (j !== i && readings[j].db !== null && readings[j].confidence >= CONFIDENCE_GATE) {
          neighbours.push(readings[j].db!);
        }
      }

      if (neighbours.length < 3) return curr;

      const sorted = [...neighbours].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];

      if (Math.abs(curr.db - median) <= threshold) return curr;

      const corrected = parseFloat(median.toFixed(1));
      return { ...curr, db: corrected, confidence: 50, raw: String(corrected) };
    });
  }

  // ── dedup ──────────────────────────────────────────────────────────────────

  private removeDuplicateConsecutive(readings: FrameReading[]): FrameReading[] {
    if (!this.config.removeDuplicates || readings.length === 0) return readings;

    const out: FrameReading[] = [readings[0]];
    for (let i = 1; i < readings.length; i++) {
      if (readings[i].db !== readings[i - 1].db) out.push(readings[i]);
    }
    return out;
  }

  // ── smoothing ──────────────────────────────────────────────────────────────

  /**
   * Drop a single-frame spike: a reading that jumps by more than `threshold`
   * from its predecessor is only kept if the next two readings confirm the jump.
   */
  private smoothReadings(readings: FrameReading[]): FrameReading[] {
    const threshold = this.config.smoothingThreshold;
    const out: FrameReading[] = [];

    for (let i = 0; i < readings.length; i++) {
      const curr = readings[i];

      if (i === 0) {
        // Keep first reading only if it's close to the next two, or if there's no context yet
        const firstIsOutlier =
          readings.length >= 3 &&
          Math.abs(readings[1].db! - readings[2].db!) < threshold / 2 &&
          Math.abs(curr.db! - readings[1].db!) > threshold;
        if (!firstIsOutlier) out.push(curr);
        continue;
      }

      const diff = Math.abs(curr.db! - readings[i - 1].db!);
      if (diff <= threshold) {
        out.push(curr);
        continue;
      }

      // Large jump — confirm with the next frame before accepting.
      // Requiring 2 frames would silently drop brief real peaks (e.g. a loud
      // impact lasting only 1-2 sampled frames at 5 fps).
      if (
        i + 1 < readings.length &&
        Math.abs(readings[i + 1].db! - curr.db!) < threshold / 2
      ) {
        out.push(curr);
      }
    }

    return out;
  }

  updateConfig(config: Partial<ValidationConfig>): void {
    this.config = { ...this.config, ...config };
  }
}
