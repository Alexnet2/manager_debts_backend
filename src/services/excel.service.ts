import ExcelJS from 'exceljs';
import { ProcessingResult } from '../types';

export class ExcelService {
  async export(result: ProcessingResult, outputPath: string): Promise<void> {
    const workbook = new ExcelJS.Workbook();

    this.createReadingsSheet(workbook, result);
    this.createSummarySheet(workbook, result);

    await workbook.xlsx.writeFile(outputPath);
  }

  private createReadingsSheet(workbook: ExcelJS.Workbook, result: ProcessingResult): void {
    const sheet = workbook.addWorksheet('Readings');

    sheet.columns = [
      { header: 'Tempo', key: 'time', width: 12 },
      { header: 'Frame', key: 'frame', width: 10 },
      { header: 'dB', key: 'db', width: 10 },
    ];

    for (const reading of result.readings) {
      sheet.addRow({
        time: reading.time.toFixed(2),
        frame: reading.frame,
        db: reading.db?.toFixed(1) || 'N/A',
      });
    }

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
  }

  private createSummarySheet(workbook: ExcelJS.Workbook, result: ProcessingResult): void {
    const sheet = workbook.addWorksheet('Summary');

    const stats = result.statistics;
    const duration = result.metadata.duration;

    const data = [
      ['Metric', 'Value'],
      ['Video Duration (s)', duration.toFixed(2)],
      ['Frame Rate (fps)', result.metadata.fps.toFixed(2)],
      ['Resolution', `${result.metadata.width}x${result.metadata.height}`],
      ['Total Frames', result.metadata.totalFrames],
      ['Valid Readings', stats.validReadings],
      ['', ''],
      ['dB Statistics', ''],
      ['Minimum', stats.min.toFixed(1)],
      ['Maximum', stats.max.toFixed(1)],
      ['Mean', stats.mean.toFixed(1)],
      ['Median', stats.median.toFixed(1)],
      ['Std Dev', stats.stdDev.toFixed(1)],
      ['', ''],
      ['Processed At', result.processedAt.toISOString()],
    ];

    for (const [i, row] of data.entries()) {
      const sheetRow = sheet.addRow(row);

      if (i === 0) {
        sheetRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        sheetRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
      } else if (row[0] === 'dB Statistics') {
        const cell = sheetRow.getCell(1);
        cell.font = { bold: true };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7E6E6' } };
      }
    }

    sheet.columns = [{ width: 30 }, { width: 20 }];
  }
}
