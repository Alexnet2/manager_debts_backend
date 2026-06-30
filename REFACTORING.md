# Backend Refactoring: Removing OpenCV, Using FFmpeg + Sharp + Tesseract

## Overview

This refactoring removes the OpenCV dependency and replaces it with a modular architecture using:
- **FFmpeg**: Video frame extraction
- **Sharp**: Image processing
- **Tesseract.js**: OCR for fallback recognition
- **ExcelJS**: Result export

## Architecture

### Service Structure

```
src/services/
├── config.service.ts          # Configuration management
├── frame.service.ts           # Frame extraction using FFmpeg
├── image.service.ts           # Image processing using Sharp
├── ocr.service.ts             # OCR using Tesseract.js
├── validation.service.ts      # Data validation and smoothing
├── excel.service.ts           # Excel export
└── video-processor.ts         # Main orchestrator
```

### Segment Detection

```
src/segments/
├── seven-segment-detector.ts  # 7-segment digit detection
├── display-detector.ts        # Display region detection
└── display-reader.ts          # Display content reading
```

## Key Changes

### 1. Configuration Service (config.service.ts)

All parameters are now configurable via environment variables:

```env
# Video settings
VIDEO_FPS=30
VIDEO_FRAME_INTERVAL=1
VIDEO_MAX_FRAMES=

# Image processing
IMAGE_CROP_X=0
IMAGE_CROP_Y=0
IMAGE_CROP_WIDTH=640
IMAGE_CROP_HEIGHT=480
IMAGE_GRAYSCALE=true
IMAGE_CONTRAST=1.2
IMAGE_BRIGHTNESS=0
IMAGE_SHARPEN=true
IMAGE_THRESHOLD=128
IMAGE_RESIZE_SCALE=2

# OCR
OCR_LANGUAGE=eng
OCR_WORKER_COUNT=1

# Validation
VALIDATION_MIN_VALUE=0
VALIDATION_MAX_VALUE=140
VALIDATION_SMOOTHING_THRESHOLD=5
VALIDATION_REMOVE_DUPLICATES=true
```

### 2. Frame Service (frame.service.ts)

Handles video frame extraction using FFmpeg:
- Extracts frames at configurable intervals
- Returns frame metadata (fps, width, height, total frames)
- Automatic cleanup of temporary files

**Usage:**
```typescript
const frameService = new FrameService(configService);
const { frames, metadata } = await frameService.extractFrames(videoPath, outputDir);
await frameService.cleanupFrames(outputDir);
```

### 3. Image Service (image.service.ts)

Processes images using Sharp:
- Crop display region
- Grayscale conversion
- Contrast enhancement
- Sharpening
- Resizing for OCR
- Adaptive threshold

**Usage:**
```typescript
const imageService = new ImageService(configService);
const processed = await imageService.processFrame(imagePath);
```

### 4. OCR Service (ocr.service.ts)

Tesseract.js wrapper for text recognition:
- Configurable language
- Worker thread management
- Automatic number extraction
- Confidence scoring

**Usage:**
```typescript
const ocrService = new OcrService(configService);
await ocrService.initialize();
const result = await ocrService.readNumber(imageBuffer);
await ocrService.terminate();
```

### 5. Validation Service (validation.service.ts)

Data validation and smoothing:
- Filter invalid readings
- Remove consecutive duplicates
- Smooth outliers
- Configurable thresholds

**Usage:**
```typescript
const validationService = new ValidationService(configService);
const validated = validationService.validateReadings(readings);
```

### 6. Display Detection (display-detector.ts)

Detects display region in image:
- Connected component analysis
- Aspect ratio validation
- Bounding box extraction
- Uses Sharp for image processing

**Usage:**
```typescript
const detector = new DisplayDetector();
const region = await detector.detectDisplayFromBuffer(imageBuffer);
```

### 7. Display Reader (display-reader.ts)

Reads display values:
- 7-segment digit detection (primary)
- OCR fallback
- Configurable preprocessing

**Usage:**
```typescript
const reader = new DisplayReader();
const result = await reader.readDisplayFromBuffer(imageBuffer, displayRegion);
```

## Pipeline Flow

```
Upload Video
    ↓
Extract Frames (FFmpeg)
    ↓
For each frame:
    ├→ Detect Display Region
    ├→ Process Image (Sharp)
    ├→ Try 7-Segment Recognition
    └→ Fallback to OCR (Tesseract)
    ↓
Validate & Smooth Readings
    ↓
Calculate Statistics
    ↓
Export to Excel
    ↓
Download
```

## Environment Setup

### 1. Install Dependencies

```bash
cd backend
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

### 3. Run Development Server

```bash
npm run dev
```

### 4. Build for Production

```bash
npm run build
npm start
```

## Dependencies

### Removed
- `opencv4nodejs` - Replaced by Sharp + Tesseract
- `opencv-build` - No longer needed

### Maintained
- `fluent-ffmpeg` - FFmpeg wrapper
- `tesseract.js` - OCR engine
- `sharp` - Image processing (NEW)
- `exceljs` - Excel export

## API Endpoints

### Upload and Process

```
POST /api/video/upload
```

**Request:** Multipart form data with `video` file
**Response:**
```json
{
  "videoId": "uuid",
  "message": "Processing started"
}
```

### Get Progress

```
GET /api/video/progress/:videoId
```

**Response:**
```json
{
  "videoId": "uuid",
  "currentFrame": 100,
  "totalFrames": 1000,
  "percentage": 10,
  "status": "processing"
}
```

### Get Results

```
GET /api/video/results/:videoId
```

**Response:**
```json
{
  "videoId": "uuid",
  "metadata": { ... },
  "readings": [ ... ],
  "statistics": { ... },
  "processedAt": "2024-01-01T12:00:00Z"
}
```

### Export to Excel

```
GET /api/video/export/:videoId
```

**Response:** Binary Excel file

## Testing

### Run Tests

```bash
npm run test
```

### Run Tests in Watch Mode

```bash
npm run test:watch
```

## Troubleshooting

### FFmpeg Not Found

Install FFmpeg:
- **macOS**: `brew install ffmpeg`
- **Ubuntu/Debian**: `apt-get install ffmpeg`
- **Windows**: Download from [ffmpeg.org](https://ffmpeg.org/download.html)

### Tesseract Issues

Tesseract.js automatically downloads language data on first use. For offline use:

```env
TESSERACT_PATH=/path/to/tesseract/data
```

### Performance Optimization

1. Adjust `VIDEO_FRAME_INTERVAL` to skip frames
2. Increase `IMAGE_RESIZE_SCALE` for faster processing
3. Reduce `VIDEO_MAX_FRAMES` for testing
4. Use multi-worker OCR with `OCR_WORKER_COUNT`

## Migration from Old Code

If upgrading from OpenCV version:

1. Update imports:
   ```typescript
   // Old
   import cv from 'opencv4nodejs';
   
   // New
   import { VideoProcessor } from '@/services/video-processor';
   ```

2. Update initialization:
   ```typescript
   // Old
   const processor = new VideoProcessor();
   
   // New
   const processor = new VideoProcessor();
   // No changes - same interface
   ```

3. Update configuration (if needed):
   ```typescript
   configService.updateImageConfig({
     contrast: 1.5,
     brightness: 0.1,
   });
   ```

## Future Enhancements

- [ ] Batch processing
- [ ] WebSocket progress updates
- [ ] Caching layer for processed frames
- [ ] GPU acceleration with TensorFlow
- [ ] Custom 7-segment templates
- [ ] ONNX model support

## License

Same as main project.
