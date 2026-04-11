const ExcelJS = require('exceljs');

function excelSerialToDate(serial) {
  if (typeof serial !== 'number' || !Number.isFinite(serial)) return null;

  const wholeDays = Math.floor(serial);
  const fractionalDay = serial - wholeDays;
  const date = new Date(Date.UTC(1899, 11, 30));

  date.setUTCDate(date.getUTCDate() + wholeDays);
  if (fractionalDay) {
    date.setTime(date.getTime() + Math.round(fractionalDay * 24 * 60 * 60 * 1000));
  }

  return date;
}

function normalizeCellValue(value) {
  if (value == null) return null;
  if (value instanceof Date) return value;
  if (Array.isArray(value?.richText)) {
    return value.richText.map(part => part.text || '').join('');
  }
  if (typeof value === 'object') {
    if (value.text != null) return String(value.text);
    if (value.hyperlink && value.text != null) return String(value.text);
    if (value.result != null) return normalizeCellValue(value.result);
    if (value.formula && value.result == null) return String(value.formula);
    if (value.error) return null;
  }
  return value;
}

async function loadWorkbookFromFile(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  return workbook;
}

async function loadWorkbookFromBuffer(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return workbook;
}

function getWorksheetByName(workbook, sheetName) {
  return workbook.getWorksheet(sheetName) || null;
}

function worksheetToMatrix(worksheet) {
  if (!worksheet) return [];

  const rows = [];
  const maxColumns = worksheet.actualColumnCount || worksheet.columnCount || 0;

  for (let rowIndex = 1; rowIndex <= worksheet.rowCount; rowIndex++) {
    const row = worksheet.getRow(rowIndex);
    if (!row.hasValues) continue;

    const width = Math.max(maxColumns, row.cellCount || 0);
    const values = [];
    for (let columnIndex = 1; columnIndex <= width; columnIndex++) {
      values.push(normalizeCellValue(row.getCell(columnIndex).value));
    }
    rows.push(values);
  }

  return rows;
}

function worksheetToObjects(worksheet) {
  const matrix = worksheetToMatrix(worksheet);
  if (!matrix.length) return [];

  const headers = matrix[0].map(value => String(value || '').trim());
  return matrix
    .slice(1)
    .filter(row => row.some(value => value != null && String(value).trim() !== ''))
    .map(row => {
      const record = {};
      headers.forEach((header, index) => {
        if (!header) return;
        const value = row[index];
        record[header] = value == null ? '' : value;
      });
      return record;
    });
}

module.exports = {
  excelSerialToDate,
  getWorksheetByName,
  loadWorkbookFromBuffer,
  loadWorkbookFromFile,
  worksheetToMatrix,
  worksheetToObjects,
};