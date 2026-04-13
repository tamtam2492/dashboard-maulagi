function doGet() {
  return HtmlService.createTemplateFromFile('Index')
      .evaluate()
      .setTitle('Dashboard Rekap Transfer')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// Fitur Pengecek Perubahan Baris (Sangat Ringan)
function checkDataChange() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sourceSheet = ss.getSheetByName("Form Responses 1") || ss.getSheetByName("Form Responses") || ss.getSheets()[0];
  return sourceSheet.getLastRow();
}

function getDashboardData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sourceSheet = ss.getSheetByName("Form Responses 1") || ss.getSheetByName("Form Responses") || ss.getSheets()[0];
  
  const lastRow = sourceSheet.getLastRow();
  const lastCol = sourceSheet.getLastColumn();
  
  if (lastRow < 2) return { error: "Belum ada data transfer." };
  
  const data = sourceSheet.getRange(1, 1, lastRow, lastCol).getValues();
  const header = data[0];
  
  const idxCabang = header.indexOf("NAMA CABANG");
  const idxBank = header.indexOf("NAMA BANK");
  const idxNominal = header.indexOf("NOMINAL TRANSFER");
  const idxKet = header.indexOf("KET");
  const idxTanggal = header.indexOf("TANGGAL INPUTAN");
  const idxBukti = header.indexOf("BUKTI TRANSFER");

  let rekapCabang = {};
  let totalNominal = 0;

  for (let i = 1; i < data.length; i++) {
    let row = data[i];
    let nominal = parseFloat(row[idxNominal]) || 0;
    
    if (nominal > 0) {
      let cabang = row[idxCabang] ? row[idxCabang].toString().trim() : "Lainnya";
      let bank = row[idxBank] ? row[idxBank].toString().trim() : "Lainnya";
      let tgl = row[idxTanggal] ? Utilities.formatDate(new Date(row[idxTanggal]), "GMT+7", "dd/MM/yy") : "-";
      
      let buktiUrl = row[idxBukti] || "";
      if (buktiUrl.indexOf("id=") !== -1) {
         const fileId = buktiUrl.split("id=")[1].split("&")[0];
         // Link Thumbnail High-Res
         buktiUrl = "https://drive.google.com/thumbnail?authuser=0&sz=w1000&id=" + fileId;
      }

      totalNominal += nominal;
      if (!rekapCabang[cabang]) {
        rekapCabang[cabang] = { total: 0, list: [] };
      }
      rekapCabang[cabang].total += nominal;
      rekapCabang[cabang].list.push({
        bank: bank,
        nominal: nominal,
        tgl: tgl,
        ket: row[idxKet] || "-",
        bukti: buktiUrl
      });
    }
  }

  return {
    total: totalNominal,
    transaksi: lastRow,
    byCabang: rekapCabang,
    lastUpdate: Utilities.formatDate(new Date(), "GMT+7", "dd-MM-yyyy HH:mm")
  };
}