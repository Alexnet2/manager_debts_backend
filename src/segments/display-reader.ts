import sharp from 'sharp';
import { SevenSegmentDetector } from './seven-segment-detector';
import { DisplayRegion } from '../types';

export interface DigitRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  buffer: Buffer;
}

export class DisplayReader {
  private segmentDetector: SevenSegmentDetector;

  constructor() {
    this.segmentDetector = new SevenSegmentDetector();
  }

  // Fast path: accepts a pre-processed raw grayscale buffer of the display region.
  // No Sharp calls — digit extraction and segment detection run entirely in JS.
  readFromRaw(data: Buffer, width: number, height: number): { value: number | null; confidence: number } {
    if (width < 30 || height < 30) return { value: null, confidence: 0 };
    const { digits, decimalX } = this.findDigitRegions(data, width, height);
    return this.recognizeDigitsFromRaw(data, width, digits, decimalX);
  }

  async readDisplayFromBuffer(
    buffer: Buffer,
    displayRegion: DisplayRegion,
  ): Promise<{ value: number | null; confidence: number }> {
    const minWidth = 30;
    const minHeight = 30;

    if (displayRegion.width < minWidth || displayRegion.height < minHeight) {
      console.warn(`Display region too small: ${displayRegion.width}x${displayRegion.height}, minimum required: ${minWidth}x${minHeight}`);
      return { value: null, confidence: 0 };
    }

    try {
      const processed = await this.preprocessImage(buffer, displayRegion);
      const { data, info } = await sharp(processed).raw().toBuffer({ resolveWithObject: true });
      return this.readFromRaw(data, info.width, info.height);
    } catch (error) {
      console.error('Error reading display:', error);
      return { value: null, confidence: 0 };
    }
  }

  private async preprocessImage(buffer: Buffer, displayRegion: DisplayRegion): Promise<Buffer> {
    return sharp(buffer)
      .extract({
        left: displayRegion.x,
        top: displayRegion.y,
        width: displayRegion.width,
        height: displayRegion.height,
      })
      .grayscale()
      .normalize()
      .resize({
        width: Math.round(displayRegion.width * 2),
        height: Math.round(displayRegion.height * 2),
        fit: 'fill',
      })
      .png()
      .toBuffer();
  }

  // Column-projection digit finder with vertical-averaging scan-line removal.
  //
  // LCD rolling-shutter artefacts create horizontal stripes at a ~40-60px period
  // (in the 2x image), making every column have ~35 % dark pixels regardless of
  // digit content. A vertical box-filter (W=15, 31-row window) averages over one
  // full stripe cycle, collapsing the stripes:
  //   - LCD background columns: average → ~178 (bright, >128) → darkCount = 0
  //   - LCD segment columns:    average → ~91  (dark,  <128) → darkCount > 0
  //   - Solid dark border bars:  average → ~0                → darkCount = height (excluded)
  private findDigitRegions(
    imageData: Buffer,
    width: number,
    height: number,
  ): { digits: Omit<DigitRegion, 'buffer'>[]; decimalX: number | null } {

    // Step 1 — Vertical box-filter using column prefix sums (O(width × height) total).
    // W = half-window size; the full window spans 2W+1 rows.
    const W = 15;
    const colPfx = new Int32Array((height + 1) * width);
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        colPfx[(y + 1) * width + x] = colPfx[y * width + x] + imageData[row + x];
      }
    }
    const vAvg = Buffer.allocUnsafe(width * height);
    for (let y = 0; y < height; y++) {
      const y1 = Math.max(0, y - W);
      const y2 = Math.min(height, y + W + 1);
      const n  = y2 - y1;
      const row = y * width;
      for (let x = 0; x < width; x++) {
        vAvg[row + x] = Math.round(
          (colPfx[y2 * width + x] - colPfx[y1 * width + x]) / n,
        );
      }
    }

    // Step 1.5 — Locate the digit row-band. The display crop now includes the
    // battery icon above and the unit label below the digits, so projecting dark
    // pixels over the *full* crop height picks up those unrelated marks too —
    // every column ends up with some dark content, erasing the gaps between
    // digits. Digits are wide and tall, so their rows have far more dark pixels
    // than icon/label rows; find the tallest contiguous run of rows whose dark
    // count clears a baseline (the 30th percentile of all rows) and restrict the
    // column projection below to just that band.
    // Uses the raw (pre-blur) image, not vAvg: the W=15 vertical box-filter
    // smooths row-darkness transitions enough to truncate the detected band early.
    const rowDark = new Int32Array(height);
    for (let y = 0; y < height; y++) {
      const off = y * width;
      let c = 0;
      for (let x = 0; x < width; x++) if (imageData[off + x] < 128) c++;
      rowDark[y] = c;
    }
    const sortedRowDark = Array.from(rowDark).sort((a, b) => a - b);
    const rowBaseline = sortedRowDark[Math.floor(height * 0.3)];
    const rowThreshold = rowBaseline * 1.6;

    let bandStart = 0, bandEnd = height, bestBandLen = 0;
    let curStart = -1;
    for (let y = 0; y <= height; y++) {
      const above = y < height && rowDark[y] > rowThreshold;
      if (above) {
        if (curStart < 0) curStart = y;
      } else if (curStart >= 0) {
        if (y - curStart > bestBandLen) {
          bestBandLen = y - curStart;
          bandStart = curStart;
          bandEnd = y;
        }
        curStart = -1;
      }
    }

    // Step 2 — Column projection restricted to the digit band only.
    const darkCount = new Int32Array(width);
    const colMinY   = new Int32Array(width).fill(height);
    const colMaxY   = new Int32Array(width);

    for (let y = bandStart; y < bandEnd; y++) {
      const off = y * width;
      for (let x = 0; x < width; x++) {
        if (vAvg[off + x] < 128) {
          darkCount[x]++;
          if (y < colMinY[x]) colMinY[x] = y;
          if (y > colMaxY[x]) colMaxY[x] = y;
        }
      }
    }

    // Step 3 — Classify columns.
    //   dotExcludeMax: the decimal dot is a tiny isolated mark — it sits right at the
    //                 edge of the adjacent digit's column run, so without explicit
    //                 exclusion the run detection merges it into that digit. When
    //                 extractSegments then zones that widened region, the dot lands in
    //                 the bottom zone and flips it active, producing a pattern that
    //                 doesn't exist in the segment map → digit=null → whole reading
    //                 fails → OCR fallback. Any column whose dark-row count is ≤8% of
    //                 the band height can only be a decimal dot or small artifact, not a
    //                 real stroke (even the shortest real stroke — a middle bar — spans
    //                 ~16% of band height). Dots are then re-detected in the GAP that
    //                 the exclusion opens up between the digit and the following region.
    //   maxSegDark:   reject solid bars/dividers (dark across almost the whole band).
    const bandHeight    = bandEnd - bandStart;
    const dotExcludeMax = Math.floor(bandHeight * 0.08);
    const maxSegDark   = Math.floor(bandHeight * 0.92);

    const isDigitZone = new Uint8Array(width);
    for (let x = 0; x < width; x++) {
      isDigitZone[x] = (darkCount[x] > dotExcludeMax && darkCount[x] <= maxSegDark) ? 1 : 0;
    }

    // Step 4 — find contiguous digit-zone column runs.
    const MIN_GAP        = 4;
    const MIN_COL_WIDTH  = Math.max(8, Math.floor(width * 0.02));
    const MIN_COL_HEIGHT = Math.floor(height * 0.25);

    const digits: Omit<DigitRegion, 'buffer'>[] = [];
    let runStart = -1;
    let zeros    = 0;
    let runMinY  = height;
    let runMaxY  = 0;

    const flush = (endX: number) => {
      const runEnd = endX - zeros;
      const colW = runEnd - runStart;
      const colH = runMaxY - runMinY + 1;
      if (colW >= MIN_COL_WIDTH && colH >= MIN_COL_HEIGHT) {
        digits.push({ x: runStart, y: runMinY, width: colW, height: colH });
      }
      runStart = -1;
      zeros    = 0;
      runMinY  = height;
      runMaxY  = 0;
    };

    for (let x = 0; x <= width; x++) {
      if (x < width && isDigitZone[x]) {
        if (runStart < 0) runStart = x;
        zeros = 0;
        if (colMinY[x] < runMinY) runMinY = colMinY[x];
        if (colMaxY[x] > runMaxY) runMaxY = colMaxY[x];
      } else {
        if (runStart >= 0) {
          zeros++;
          if (zeros >= MIN_GAP || x === width) flush(x);
        }
      }
    }

    // Decimal point: look for a tiny isolated dark dot between the last two digit columns.
    let decimalX: number | null = null;
    const maxDotDark = Math.floor(height * 0.04);
    const minDotDark = Math.max(2, Math.floor(height * 0.001));
    if (digits.length >= 2) {
      const lastTwo = digits.slice(-2);
      const gapStart = lastTwo[0].x + lastTwo[0].width;
      const gapEnd   = lastTwo[1].x;
      for (let x = gapStart; x < gapEnd; x++) {
        if (darkCount[x] >= minDotDark && darkCount[x] <= maxDotDark) {
          decimalX = x;
          break;
        }
      }
    }

    // Log vAvg value at row height/2 for 12 evenly-spaced columns to diagnose
    const step = Math.max(1, Math.floor(width / 12));
    const midRow = Math.floor(height / 2) * width;
    const dcSamples = [];
    for (let x = 0; x < width; x += step) {
      dcSamples.push(`x${x}:dc${darkCount[x]}/va${vAvg[midRow + x]}`);
    }
    console.log(
      `[DisplayReader] projection: cols=${digits.length}` +
      ` widths=[${digits.map(d => d.width).join(',')}]` +
      ` heights=[${digits.map(d => d.height).join(',')}]` +
      ` | maxSegDark=${maxSegDark}` +
      ` | samples=[${dcSamples.join(' ')}]`,
    );

    return { digits, decimalX };
  }

  // Groups segment strokes into digit bounding boxes using X-projection.
  // Builds a binary coverage array from blob X-extents, then finds runs of
  // covered columns separated by gaps of at least MIN_GAP empty columns.
  // This is scale-independent: it uses real pixel gaps rather than a % of
  // image width, which fails for close-up videos where inter-digit gaps are small.
  private mergeSegmentsIntoDigits(
    segments: Omit<DigitRegion, 'buffer'>[],
    imageWidth: number,
  ): Omit<DigitRegion, 'buffer'>[] {
    if (segments.length === 0) return [];

    // Build binary X projection from blob extents
    const proj = new Uint8Array(imageWidth);
    for (const seg of segments) {
      const right = Math.min(seg.x + seg.width, imageWidth);
      for (let x = seg.x; x < right; x++) proj[x] = 1;
    }

    // Find covered runs, bridging zero-gaps narrower than MIN_GAP
    const MIN_GAP = 6;
    const MIN_COL_WIDTH = 8;
    const runs: { start: number; end: number }[] = [];
    let runStart = -1;
    let zeros = 0;

    for (let x = 0; x <= imageWidth; x++) {
      const covered = x < imageWidth && proj[x] === 1;
      if (covered) {
        if (runStart < 0) runStart = x;
        zeros = 0;
      } else {
        if (runStart >= 0) {
          zeros++;
          if (zeros >= MIN_GAP || x === imageWidth) {
            const runEnd = x - zeros;
            if (runEnd - runStart >= MIN_COL_WIDTH) {
              runs.push({ start: runStart, end: runEnd });
            }
            runStart = -1;
            zeros = 0;
          }
        }
      }
    }

    // Map each run back to a bounding box over the blobs that fall within it
    return runs.map(run => {
      const inRun = segments.filter(s => s.x < run.end && s.x + s.width > run.start);
      if (inRun.length === 0) return null;
      const x = Math.min(...inRun.map(s => s.x));
      const y = Math.min(...inRun.map(s => s.y));
      const right = Math.max(...inRun.map(s => s.x + s.width));
      const bottom = Math.max(...inRun.map(s => s.y + s.height));
      return { x, y, width: right - x, height: bottom - y };
    }).filter((r): r is Omit<DigitRegion, 'buffer'> => r !== null);
  }

  private floodFillAndGetBounds(
    imageData: Buffer,
    visited: Uint8Array,
    startX: number,
    startY: number,
    width: number,
    height: number,
    threshold: number,
    stackBuf: Int32Array,
  ): { minX: number; minY: number; maxX: number; maxY: number; area: number } {
    let minX = startX, minY = startY, maxX = startX, maxY = startY, area = 0;
    let top = 0;

    stackBuf[top++] = startX;
    stackBuf[top++] = startY;

    while (top > 0) {
      const cy = stackBuf[--top];
      const cx = stackBuf[--top];
      const idx = cy * width + cx;

      if (cx < 0 || cx >= width || cy < 0 || cy >= height || visited[idx]) continue;

      visited[idx] = 1;
      area++;
      if (cx < minX) minX = cx;
      if (cy < minY) minY = cy;
      if (cx > maxX) maxX = cx;
      if (cy > maxY) maxY = cy;

      if (imageData[idx] < threshold) {
        if (cx + 1 < width)  { stackBuf[top++] = cx + 1; stackBuf[top++] = cy; }
        if (cx - 1 >= 0)     { stackBuf[top++] = cx - 1; stackBuf[top++] = cy; }
        if (cy + 1 < height) { stackBuf[top++] = cx; stackBuf[top++] = cy + 1; }
        if (cy - 1 >= 0)     { stackBuf[top++] = cx; stackBuf[top++] = cy - 1; }
      }
    }

    return { minX, minY, maxX, maxY, area };
  }

  // Copy a rectangular region from a flat grayscale buffer into a new Buffer — no Sharp needed.
  private extractDigitBuffer(data: Buffer, fullWidth: number, region: Omit<DigitRegion, 'buffer'>): Buffer {
    const result = Buffer.allocUnsafe(region.width * region.height);
    for (let row = 0; row < region.height; row++) {
      const srcStart = (region.y + row) * fullWidth + region.x;
      data.copy(result, row * region.width, srcStart, srcStart + region.width);
    }
    return result;
  }

  private recognizeDigitsFromRaw(
    data: Buffer,
    fullWidth: number,
    regions: Omit<DigitRegion, 'buffer'>[],
    decimalX: number | null,
  ): { value: number | null; confidence: number } {
    if (regions.length === 0) return { value: null, confidence: 0 };

    const sorted = [...regions].sort((a, b) => a.x - b.x);

    // When more than 4 regions are found, the display is likely showing two simultaneous
    // readings (e.g. live level on the left + max-hold on the right). Find the largest
    // horizontal gap between consecutive regions, split there, and use the left group
    // (the primary live reading). Supports XX.X (3 regions) and XXX.X (4 regions) formats.
    let activeRegions = sorted;
    if (sorted.length > 4) {
      let maxGap = 0;
      let splitAfter = -1;
      for (let i = 0; i < sorted.length - 1; i++) {
        const gap = sorted[i + 1].x - (sorted[i].x + sorted[i].width);
        if (gap > maxGap) { maxGap = gap; splitAfter = i; }
      }
      if (splitAfter >= 0) {
        const leftGroup = sorted.slice(0, splitAfter + 1);
        if (leftGroup.length >= 3 && leftGroup.length <= 4) {
          activeRegions = leftGroup;
        }
      }
    }

    const recognizedDigits: number[] = [];
    let totalConfidence = 0;

    for (const region of activeRegions) {
      const digitData = this.extractDigitBuffer(data, fullWidth, region);
      const recognized = this.segmentDetector.detectDigitFromRaw(digitData, region.width, region.height);
      if (recognized.digit !== null) {
        recognizedDigits.push(recognized.digit);
        totalConfidence += recognized.confidence;
      } else {
        // Can't build a valid reading with an unrecognized digit
        return { value: null, confidence: 0 };
      }
    }

    if (recognizedDigits.length === 0) return { value: null, confidence: 0 };

    // Determine decimal insert position from detected dot, or default to before last digit.
    // dB meters show XX.X (3 digits) or XXX.X (4 digits, for readings 100–140).
    let decimalPos = recognizedDigits.length - 1;
    if (decimalX !== null) {
      for (let i = 0; i < activeRegions.length - 1; i++) {
        if (decimalX >= activeRegions[i].x + activeRegions[i].width && decimalX <= activeRegions[i + 1].x) {
          decimalPos = i + 1;
          break;
        }
      }
    }

    // Mid-multiplex drop: fewer than 3 blobs means a digit was in its off-phase.
    if (recognizedDigits.length < 3) {
      return { value: null, confidence: 0 };
    }

    const joined = recognizedDigits.join('');
    const valueStr = joined.slice(0, decimalPos) + '.' + joined.slice(decimalPos);

    const value = parseFloat(valueStr);
    const confidence = totalConfidence / recognizedDigits.length;

    return { value: isNaN(value) ? null : value, confidence };
  }
}
