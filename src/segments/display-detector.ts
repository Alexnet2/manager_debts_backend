import sharp from 'sharp';
import { DisplayRegion } from '../types';

// Optional: @u4/opencv4nodejs for superior edge-based detection.
// If not installed the pure-JS flood-fill fallback is used transparently.
let cv: any = null;
try {
  cv = require('@u4/opencv4nodejs');
} catch {
  // OpenCV not installed — pure-JS mode
}

export class DisplayDetector {
  private readonly MIN_ASPECT = 0.2;
  private readonly MAX_ASPECT = 5.0;
  // Close-up videos where the display fills most of the frame need higher limits.
  private readonly MAX_AREA_RATIO = 0.85;

  async detectDisplayFromBuffer(
    buffer: Buffer,
    calibrationRegion?: DisplayRegion,
  ): Promise<DisplayRegion | null> {
    if (calibrationRegion) return calibrationRegion;

    try {
      if (cv) {
        return await this.detectWithOpenCV(buffer);
      }
      return await this.detectWithSharp(buffer);
    } catch (error) {
      console.error('[DisplayDetector] error:', error);
      return null;
    }
  }

  // ── OpenCV path ────────────────────────────────────────────────────────────

  private async detectWithOpenCV(buffer: Buffer): Promise<DisplayRegion | null> {
    const mat = cv.imdecode(buffer);
    const { rows: height, cols: width } = mat;

    // Correct small rotation before locating the display
    const corrected = await this.correctRotation(mat, width, height);

    const gray = corrected.cvtColor(cv.COLOR_BGR2GRAY);
    const blurred = gray.gaussianBlur(new cv.Size(5, 5), 0);
    const edges = blurred.canny(50, 150);

    // Dilate to bridge small gaps in the display border
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    const dilated = edges.dilate(kernel, new cv.Point2(-1, -1), 2);

    const contours = dilated.findContours(cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    return this.bestContourRegion(contours, width, height);
  }

  /**
   * Detect near-horizontal lines via Hough transform and rotate the image to
   * level them. Corrections larger than 10° are ignored (probably wrong lines).
   */
  private async correctRotation(mat: any, width: number, height: number): Promise<any> {
    try {
      const gray = mat.cvtColor(cv.COLOR_BGR2GRAY);
      const edges = gray.canny(50, 150);
      // minLineLength = 20% of width; maxLineGap = 2% of width
      const minLen = Math.round(width * 0.20);
      const maxGap = Math.round(width * 0.02);
      const lines = edges.houghLinesP(1, Math.PI / 180, 50, minLen, maxGap);

      if (!lines || lines.length === 0) return mat;

      let angleSum = 0;
      let count = 0;
      for (const line of lines) {
        const [x1, y1, x2, y2] = line;
        const angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
        if (Math.abs(angle) < 10) {
          angleSum += angle;
          count++;
        }
      }

      if (count === 0) return mat;
      const avgAngle = angleSum / count;
      if (Math.abs(avgAngle) < 0.5) return mat;

      const center = new cv.Point2(width / 2, height / 2);
      const rotMat = cv.getRotationMatrix2D(center, avgAngle, 1.0);
      return mat.warpAffine(rotMat, new cv.Size(width, height));
    } catch {
      return mat;
    }
  }

  private bestContourRegion(
    contours: any[],
    width: number,
    height: number,
  ): DisplayRegion | null {
    const frameArea = width * height;
    const minArea = Math.max(100, frameArea * 0.003);
    const maxArea = frameArea * this.MAX_AREA_RATIO;

    let bestRect: any = null;
    let bestScore = 0;

    for (const contour of contours) {
      const rect = contour.boundingRect();
      const area = rect.width * rect.height;

      if (area < minArea || area > maxArea) continue;

      const aspect = rect.width / rect.height;
      if (aspect < this.MIN_ASPECT || aspect > this.MAX_ASPECT) continue;

      // Use center-distance as tiebreaker so centered displays score higher,
      // but do NOT reject edge-touching regions (close-up shots hit frame borders).
      const edgeDist = Math.min(
        rect.x,
        rect.y,
        width - (rect.x + rect.width),
        height - (rect.y + rect.height),
      );
      const score = area * (1 + edgeDist / width);
      if (score > bestScore) {
        bestScore = score;
        bestRect = rect;
      }
    }

    if (!bestRect) return null;

    return this.padRegion(
      { x: bestRect.x, y: bestRect.y, width: bestRect.width, height: bestRect.height },
      width,
      height,
    );
  }

  // ── Pure-JS fallback path ──────────────────────────────────────────────────

  private async detectWithSharp(buffer: Buffer): Promise<DisplayRegion | null> {
    const meta = await sharp(buffer).metadata();
    if (!meta.width || !meta.height) return null;

    const { data, info } = await sharp(buffer)
      .grayscale()
      .blur(2)
      .normalize()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Try several thresholds and keep the largest valid blob. A single fixed
    // threshold (e.g. 200) can under-crop: a bright reflection/glare on one side
    // of the LCD skews normalize()'s contrast stretch, leaving the rest of the
    // same white background just a few units under the cutoff — cropping off
    // whole digits even though a region was "found".
    let best: DisplayRegion | null = null;
    let bestArea = 0;
    for (const threshold of [200, 180, 160, 140, 127]) {
      const region = this.findBlobRegion(data, info.width, info.height, threshold);
      if (region && region.width * region.height > bestArea) {
        best = region;
        bestArea = region.width * region.height;
      }
    }
    return best;
  }

  private findBlobRegion(
    imageData: Buffer,
    width: number,
    height: number,
    threshold = 127,
  ): DisplayRegion | null {
    const frameArea = width * height;
    const minArea = Math.max(100, frameArea * 0.003);
    const maxArea = frameArea * this.MAX_AREA_RATIO;
    const minBlobArea = Math.max(100, Math.floor(frameArea * 0.0003));

    // Dark 7-segment digit strokes inside a bright LCD background can fully bisect
    // the background's bright blob (a vertical stroke spans the whole digit height),
    // splitting one display into several flood-fill islands so only the largest
    // fragment gets cropped — cutting off whole digits. Dilating the bright mask
    // bridges digit-stroke-width gaps before connectivity is computed, so the
    // display's white background is recovered as a single blob.
    const above = new Uint8Array(width * height);
    for (let i = 0; i < above.length; i++) above[i] = imageData[i] > threshold ? 1 : 0;
    const connectivity = this.dilate(above, width, height, 12);

    const visited = new Uint8Array(width * height);
    let bestRegion: DisplayRegion | null = null;
    let bestScore = 0;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (connectivity[idx] && !visited[idx]) {
          const bounds = this.floodFill(connectivity, visited, x, y, width, height);
          const area = bounds.width * bounds.height;

          if (area < minBlobArea) continue;
          if (area < minArea || area > maxArea) continue;

          const aspect = bounds.width / bounds.height;
          if (aspect < this.MIN_ASPECT || aspect > this.MAX_ASPECT) continue;

          // Use center-distance as tiebreaker; do NOT reject edge-touching blobs
          // since close-up shots have the display touching the frame border.
          const edgeDist = Math.min(
            bounds.x,
            bounds.y,
            width - (bounds.x + bounds.width),
            height - (bounds.y + bounds.height),
          );
          const score = area * (1 + edgeDist / width);
          if (score > bestScore) {
            bestScore = score;
            bestRegion = bounds;
          }
        }
      }
    }

    return bestRegion ? this.padRegion(bestRegion, width, height) : null;
  }

  // Separable binary dilation (max-filter) with the given radius.
  private dilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
    const horiz = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const x1 = Math.max(0, x - radius);
        const x2 = Math.min(width - 1, x + radius);
        let v = 0;
        for (let xx = x1; xx <= x2 && !v; xx++) v = mask[row + xx];
        horiz[row + x] = v;
      }
    }

    const result = new Uint8Array(width * height);
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        const y1 = Math.max(0, y - radius);
        const y2 = Math.min(height - 1, y + radius);
        let v = 0;
        for (let yy = y1; yy <= y2 && !v; yy++) v = horiz[yy * width + x];
        result[y * width + x] = v;
      }
    }
    return result;
  }

  private floodFill(
    mask: Uint8Array,
    visited: Uint8Array,
    startX: number,
    startY: number,
    width: number,
    height: number,
  ): DisplayRegion {
    let minX = startX, minY = startY, maxX = startX, maxY = startY;
    const stack = [[startX, startY]];

    while (stack.length > 0) {
      const [cx, cy] = stack.pop()!;
      const idx = cy * width + cx;

      if (cx < 0 || cx >= width || cy < 0 || cy >= height || visited[idx]) continue;

      visited[idx] = 1;
      if (cx < minX) minX = cx;
      if (cy < minY) minY = cy;
      if (cx > maxX) maxX = cx;
      if (cy > maxY) maxY = cy;

      if (mask[idx]) {
        stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
      }
    }

    return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  }

  // ── utilities ──────────────────────────────────────────────────────────────

  private padRegion(region: DisplayRegion, imgW: number, imgH: number): DisplayRegion {
    const PAD = 5;
    const x = Math.max(0, region.x - PAD);
    const y = Math.max(0, region.y - PAD);
    const w = Math.min(imgW - x, region.width + PAD * 2);
    const h = Math.min(imgH - y, region.height + PAD * 2);

    const minDim = 50;
    const finalW = Math.max(w, minDim);
    const finalH = Math.max(h, minDim);

    return {
      x: Math.max(0, x - Math.max(0, finalW - w) / 2),
      y: Math.max(0, y - Math.max(0, finalH - h) / 2),
      width: Math.min(imgW, finalW),
      height: Math.min(imgH, finalH),
    };
  }
}
