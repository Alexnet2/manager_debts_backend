interface SegmentState {
  top: boolean;
  topRight: boolean;
  bottomRight: boolean;
  bottom: boolean;
  bottomLeft: boolean;
  topLeft: boolean;
  middle: boolean;
}

interface SegmentMap {
  [key: string]: number;
}

export class SevenSegmentDetector {
  // Pattern order: top, topRight, bottomRight, bottom, bottomLeft, topLeft, middle
  private readonly segmentMap: SegmentMap = {
    '1111110': 0,
    '0110000': 1,
    '1101101': 2,
    '1111001': 3,
    '0110011': 4,
    '1011011': 5,
    '1011111': 6,
    '1110000': 7,
    '1111111': 8,
    '1111011': 9,
  };

  private readonly thresholdValue = 127;

  // Sync path: caller already has raw grayscale data with known dimensions.
  // Avoids a Sharp invocation per digit (previously broken — Sharp can't auto-detect raw format).
  detectDigitFromRaw(data: Buffer, width: number, height: number): { digit: number | null; confidence: number } {
    const segments = this.extractSegments(data, width, height);
    const pattern = this.segmentStateToPattern(segments);
    if (!this.isValidSegmentPattern(segments)) return { digit: null, confidence: 0 };
    const digit = this.recognizeDigit(segments);
    return { digit, confidence: digit !== null ? 80 : 0 };
  }

  async detectDigitFromBuffer(buffer: Buffer, width: number, height: number): Promise<{ digit: number | null; confidence: number }> {
    return this.detectDigitFromRaw(buffer, width, height);
  }

  // Normalise each row independently so horizontal scan-line artefacts (alternating
  // bright/dark bands from LCD refresh × rolling shutter) are cancelled before
  // zone analysis. After per-row normalisation the darkest pixels in each row map
  // to 0 and the brightest to 255, making active segment strokes consistently dark
  // regardless of whether the row is a "bright" or "scan-line" row.
  private perRowNormalize(imageData: Buffer, width: number, height: number): Buffer {
    const out = Buffer.allocUnsafe(width * height);
    for (let y = 0; y < height; y++) {
      const off = y * width;
      let mn = 255, mx = 0;
      for (let x = 0; x < width; x++) {
        const v = imageData[off + x];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      const range = mx - mn;
      for (let x = 0; x < width; x++) {
        // If row is nearly uniform (no segment content), treat all pixels as bright.
        out[off + x] = range < 8 ? 255 : Math.round(((imageData[off + x] - mn) / range) * 255);
      }
    }
    return out;
  }

  private extractSegments(imageData: Buffer, width: number, height: number): SegmentState {
    imageData = this.perRowNormalize(imageData, width, height);
    // Proportional zones matched to typical 7-segment geometry.
    // Key insight: topRight and bottomRight must NOT overlap — split at 50% height.
    // The old 2/3-height zones let the bottomRight bar bleed into topRight (false active).
    //
    // Horizontal bars: narrow bands (top 18%, mid 42-58%, bot 82-100%) × inner 15-85% width.
    // Vertical bars:   left or right 35% of width × upper (18-50%) or lower (50-82%) half.
    const hTop   = Math.round(height * 0.18);
    const hMidLo = Math.round(height * 0.42);
    const hMidHi = Math.round(height * 0.58);
    const hBot   = Math.round(height * 0.82);
    const hHalf  = Math.round(height * 0.50);

    const wL  = Math.round(width * 0.15);   // horizontal bar inset
    const wR  = Math.round(width * 0.85);
    const wVL = Math.round(width * 0.35);   // left-column right boundary
    const wVR = Math.round(width * 0.65);   // right-column left boundary

    return {
      top:         this.isBarActive(imageData, 0,      hTop,   wL,  wR,    width),
      middle:      this.isBarActive(imageData, hMidLo, hMidHi, wL,  wR,    width),
      bottom:      this.isBarActive(imageData, hBot,   height, wL,  wR,    width),
      topLeft:     this.isStrokeActive(imageData, hTop,   hHalf,  0,   wVL,   width),
      bottomLeft:  this.isStrokeActive(imageData, hHalf,  hBot,   0,   wVL,   width),
      topRight:    this.isStrokeActive(imageData, hTop,   hHalf,  wVR, width, width),
      bottomRight: this.isStrokeActive(imageData, hHalf,  hBot,   wVR, width, width),
    };
  }

  // Horizontal bar zones (top/middle/bottom) span the full digit width, but a
  // vertical stroke (e.g. "7"'s descender, "1") also passes through their row
  // range at one narrow x position, and two *different* strokes (e.g. "4"'s
  // topLeft and topRight converging near the top) can together cover half the
  // zone's columns without forming a real bar. A real bar is one CONTIGUOUS
  // span of dark columns; require the longest such run to cover most of the
  // zone's width, not just the total scattered column count.
  private isBarActive(
    imageData: Buffer,
    startRow: number,
    endRow: number,
    startCol: number,
    endCol: number,
    width: number,
  ): boolean {
    const colCount = endCol - startCol;
    const threshold = this.thresholdValue;
    let longestRun = 0;
    let curRun = 0;
    for (let x = 0; x < colCount; x++) {
      let dark = false;
      for (let y = startRow; y < endRow; y++) {
        if (imageData[y * width + startCol + x] < threshold) { dark = true; break; }
      }
      curRun = dark ? curRun + 1 : 0;
      if (curRun > longestRun) longestRun = curRun;
    }
    return longestRun >= colCount * 0.5;
  }

  // Vertical stroke zones (the four corner columns): same reasoning as
  // isBarActive but along the row axis — require dark pixels spread across
  // most of the zone's rows, not just a thin horizontal bar's worth.
  private isStrokeActive(
    imageData: Buffer,
    startRow: number,
    endRow: number,
    startCol: number,
    endCol: number,
    width: number,
  ): boolean {
    const rowCount = endRow - startRow;
    const threshold = this.thresholdValue;
    let darkRows = 0;
    for (let y = startRow; y < endRow; y++) {
      const rowStart = y * width + startCol;
      for (let x = startCol; x < endCol; x++) {
        if (imageData[rowStart + (x - startCol)] < threshold) {
          darkRows++;
          break;
        }
      }
    }
    return darkRows >= rowCount * 0.5;
  }

  private recognizeDigit(segments: SegmentState): number | null {
    const pattern = this.segmentStateToPattern(segments);
    return this.segmentMap[pattern] ?? null;
  }

  private segmentStateToPattern(segments: SegmentState): string {
    return [
      segments.top ? '1' : '0',
      segments.topRight ? '1' : '0',
      segments.bottomRight ? '1' : '0',
      segments.bottom ? '1' : '0',
      segments.bottomLeft ? '1' : '0',
      segments.topLeft ? '1' : '0',
      segments.middle ? '1' : '0',
    ].join('');
  }

  private isValidSegmentPattern(segments: SegmentState): boolean {
    const activeCount = Object.values(segments).filter(Boolean).length;
    // Digit "1" uses only 2 segments (topRight + bottomRight)
    return activeCount >= 2 && activeCount <= 7;
  }
}
