import ExcelJS from 'exceljs';
import { ProcessingResult } from '../types';

export class ExcelExporter {
  async export(result: ProcessingResult, outputPath: string): Promise<void> {
    const workbook = new ExcelJS.Workbook();

    // Aba 1: Leituras
    this.createReadingsSheet(workbook, result);

    // Aba 2: Resumo
    this.createSummarySheet(workbook, result);

    await workbook.xlsx.writeFile(outputPath);
  }

  private createReadingsSheet(workbook: ExcelJS.Workbook, result: ProcessingResult): void {
    const sheet = workbook.addWorksheet('Leituras');

    // Cabeçalhos
    sheet.columns = [
      { header: 'Tempo (s)', key: 'time', width: 12 },
      { header: 'Frame', key: 'frame', width: 10 },
      { header: 'dB', key: 'db', width: 10 },
      { header: 'Confiança (%)', key: 'confidence', width: 15 },
      { header: 'Método', key: 'method', width: 12 },
    ];

    // Adicionar dados
    for (const reading of result.readings) {
      sheet.addRow({
        time: reading.time.toFixed(2),
        frame: reading.frame,
        db: reading.db?.toFixed(1) || 'N/A',
        confidence: reading.confidence?.toFixed(1) || 'N/A',
        method: reading.method,
      });
    }

    // Formatar cabeçalhos
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
  }

  private createSummarySheet(workbook: ExcelJS.Workbook, result: ProcessingResult): void {
    const sheet = workbook.addWorksheet('Resumo');

    const stats = result.statistics;
    const duration = result.metadata.duration;

    const data = [
      ['Métrica', 'Valor'],
      ['Duração do vídeo (s)', duration.toFixed(2)],
      ['Taxa de frames (fps)', result.metadata.fps.toFixed(2)],
      ['Resolução', `${result.metadata.width}x${result.metadata.height}`],
      ['Total de frames', result.metadata.totalFrames],
      ['Leituras válidas', stats.validReadings],
      ['', ''],
      ['Estatísticas de dB', ''],
      ['Mínimo', stats.min.toFixed(1)],
      ['Máximo', stats.max.toFixed(1)],
      ['Média', stats.mean.toFixed(1)],
      ['Mediana', stats.median.toFixed(1)],
      ['Desvio Padrão', stats.stdDev.toFixed(1)],
      ['', ''],
      ['Processado em', result.processedAt.toISOString()],
    ];

    // Adicionar dados
    for (const [i, row] of data.entries()) {
      const sheetRow = sheet.addRow(row);

      if (i === 0) {
        sheetRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        sheetRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
      } else if (row[0] === 'Estatísticas de dB') {
        const cell = sheetRow.getCell(1);
        cell.font = { bold: true };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7E6E6' } };
      }
    }

    // Ajustar largura das colunas
    sheet.columns = [
      { width: 30 },
      { width: 20 },
    ];
  }
}
