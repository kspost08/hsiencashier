/**
 * 弦弦收銀機 - v8.2 (多攤位升級版)
 * 修正重點:支援多地點庫存獨立計算、BOM移至M欄、Records增加地點欄位
 */

const DB_ID = ""; 
const COPYRIGHT_TEXT = "Design by Chiahsien © 高雄郵局企劃行銷科";

function getDB() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('🟢 收銀系統報表')
    .addItem('📦 生成【品項】熱銷矩陣', 'generateProductAnalysis')
    .addToUi();
}

function doGet(e) {
  if (e && e.parameter && e.parameter.view === 'customer') {
    const template = HtmlService.createTemplateFromFile('Customer');
    template.targetBranch = e.parameter.branch || ""; 
    return template.evaluate()
      .setTitle("顧客顯示螢幕")
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no');
  }

  let sysTitle = "弦弦收銀機 v8.2"; 
  let sysVersion = "v8.2";
  let sysNotice = "尚無公告事項。"; 
  let activityUrl = ""; 
  
  try {
    const ss = getDB();
    const settingsSheet = ss.getSheetByName("Settings");
    if (settingsSheet) {
      sysTitle = settingsSheet.getRange("B1").getValue() || sysTitle;
      sysVersion = settingsSheet.getRange("B2").getValue() || sysVersion;
      sysNotice = settingsSheet.getRange("B3").getValue() || sysNotice; 
      activityUrl = settingsSheet.getRange("B4").getValue() || "";      
    }
  } catch (e) { console.log("讀取 Settings 失敗: " + e); }

  const html = HtmlService.createTemplateFromFile('index');
  html.sysTitle = sysTitle; 
  html.sysVersion = sysVersion;
  html.sysNotice = sysNotice;
  html.activityUrl = activityUrl;
  html.copyright = COPYRIGHT_TEXT;
  
  return html.evaluate()
    .setTitle(sysTitle) 
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL) 
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no');
}

function include(filename) { return HtmlService.createHtmlOutputFromFile(filename).getContent(); }

function syncToCloud(branchName, data) {
  if (!branchName) return;
  CacheService.getScriptCache().put('DISPLAY_' + branchName, JSON.stringify(data), 1200); 
}

function fetchFromCloud(branchName) {
  if (!branchName) return null;
  const json = CacheService.getScriptCache().get('DISPLAY_' + branchName);
  return json ? JSON.parse(json) : null;
}

// 🔥 新增:動態尋找該地點對應的庫存欄位 (預設為 G 欄 [索引6])
function getLocationColumnIndex(sheet, locationName) {
  if (!locationName) return 6; 
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  for (let i = 6; i < headers.length; i++) {
    if (headers[i].toString().includes(locationName)) return i;
  }
  return 6; // 找不到對應標題就預設扣 G 欄
}

// 🔥 修正:登入時順便抓取地點清單
function loginVerify(acc, pwd) {
  try {
    const ss = getDB();
    const sheet = ss.getSheetByName("Users");
    const data = sheet.getDataRange().getDisplayValues(); 
    
    // 抓取 Settings 的地點清單
    let locations = [];
    const settingsSheet = ss.getSheetByName("Settings");
    if (settingsSheet) {
        const locData = settingsSheet.getRange("B6:B").getValues();
        locations = locData.filter(r => r[0].toString().trim() !== "").map(r => r[0].toString().trim());
    }

    for (let i = 1; i < data.length; i++) {
      if (data[i][0] == acc && data[i][1] == pwd) {
        return { success: true, branchName: data[i][2], role: data[i][3], account: acc, locationList: locations };
      }
    }
    return { success: false, msg: "❌ 帳號或密碼錯誤" };
  } catch (e) { return { success: false, msg: "系統錯誤: " + e.toString() }; }
}

// 🔥 修正:根據地點抓取正確的庫存欄位
function getAllProducts(location) {
  const ss = getDB();
  const sheet = ss.getSheetByName("Products");
  const data = sheet.getDataRange().getDisplayValues();
  
  const colIdx = getLocationColumnIndex(sheet, location); // 取得對應地點的欄位索引

  let realStockMap = {};
  for (let i = 1; i < data.length; i++) {
    let id = data[i][0].toUpperCase();
    if (!id) continue;
    realStockMap[id] = parseInt(data[i][colIdx] || 0); 
  }
  
  let products = {};
  for (let i = 1; i < data.length; i++) {
    let id = data[i][0].toUpperCase();
    if (!id) continue;
    
    let bomStr = data[i][12] || ""; // BOM 已經移到 M 欄 (索引 12)
    let finalStock = 0;
    let quota = parseInt(data[i][colIdx] || 0);

    if (bomStr.trim() === "") {
      finalStock = quota;
    } else {
      let components = parseBOM(bomStr);
      let possibleByRaw = 999999;
      if (components.length > 0) {
        components.forEach(comp => {
          let compId = comp.id.toUpperCase();
          let needed = comp.qty;
          let has = realStockMap[compId] || 0;
          let canMake = Math.floor(has / needed);
          if (canMake < possibleByRaw) possibleByRaw = canMake;
        });
        finalStock = (possibleByRaw === 999999) ? 0 : Math.min(possibleByRaw, quota);
      } else {
        finalStock = 0;
      }
    }

    products[id] = {
      id: id,
      name: data[i][1],
      price: data[i][2], 
      stamp: data[i][3], 
      fee: data[i][4],   
      total: data[i][5], 
      stock: finalStock, 
      quota: quota,      
      rowOrder: i,
      isBundle: (bomStr.trim() !== ""),
      bom: bomStr
    };
  }
  return products;
}

// 🔥 修正:進貨也要指定地點
function addStock(id, qty, userAcc, location) {
  const ss = getDB();
  const sheet = ss.getSheetByName("Products");
  const logSheet = ss.getSheetByName("StockLogs");
  const data = sheet.getDataRange().getDisplayValues();
  const colIdx = getLocationColumnIndex(sheet, location);

  for (let i = 1; i < data.length; i++) {
    if (data[i][0].toUpperCase() == id) {
      let current = parseInt(data[i][colIdx] || 0);
      sheet.getRange(i + 1, colIdx + 1).setValue(current + parseInt(qty));
      if(logSheet) logSheet.appendRow([new Date(), id, data[i][1], qty, userAcc, location]); // F欄紀錄地點
      return "OK";
    }
  }
  return "找不到商品";
}

function getLastRecordInfo(branchName, userRole, location) {
  try {
    const ss = getDB();
    const sheet = ss.getSheetByName("Records");
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return null;

    const numToFetch = Math.min(100, lastRow - 1);
    const data = sheet.getRange(lastRow - numToFetch + 1, 1, numToFetch, 11).getValues();
    
    let targetTimeStr = "";
    let orderItems = [];
    
    for (let i = data.length - 1; i >= 0; i--) {
      const row = data[i];
      // 判斷支局與地點是否吻合
      const isMyBranch = (userRole === "ADMIN" || String(row[8]).trim() === String(branchName).trim());
      const isMyLocation = (!location || String(row[10]).trim() === String(location).trim());
      
      if (isMyBranch && isMyLocation) {
        const rowTimeStr = Utilities.formatDate(new Date(row[0]), "GMT+8", "yyyy/MM/dd HH:mm:ss");
        if (targetTimeStr === "") targetTimeStr = rowTimeStr; 
        
        if (rowTimeStr === targetTimeStr) {
          orderItems.push(row); 
        } else if (orderItems.length > 0) {
          break; 
        }
      }
    }

    if (orderItems.length > 0) {
      let totalAmount = 0;
      orderItems.forEach(r => totalAmount += Number(r[6])); 
      return {
        time: Utilities.formatDate(new Date(orderItems[0][0]), "GMT+8", "HH:mm:ss"),
        count: orderItems.length,
        total: totalAmount
      };
    }
    return null;
  } catch (e) { return null; }
}

// 🔥 核心修正:存檔時扣除「指定地點」庫存,並將地點寫入 Records
function saveOrder(orderList, invoiceNum, branchName, userRole, userAcc, location) {
  if (userRole === "GUEST") return "權限不足";
  
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000); 

    const ss = getDB();
    const recordSheet = ss.getSheetByName("Records");
    const productSheet = ss.getSheetByName("Products");
    const colIdx = getLocationColumnIndex(productSheet, location);

    const timestamp = new Date();
    const timeStr = Utilities.formatDate(timestamp, "GMT+8", "yyyy/MM/dd HH:mm:ss");
    
    const pData = productSheet.getDataRange().getValues();
    let stockUpdates = {}; 
    let idToRow = {};
    for (let j = 1; j < pData.length; j++) { idToRow[pData[j][0].toString().toUpperCase()] = j; }

    for (let item of orderList) {
      let itemId = item.id.toUpperCase();
      if (itemId === 'STAMPS00') continue; 

      let rowIdx = idToRow[itemId];
      if (rowIdx === undefined) return `❌ 找不到商品ID: ${itemId}`;

      let bomStr = pData[rowIdx][12] || ""; // BOM 在 M 欄
      if (bomStr.trim() !== "") {
        let components = parseBOM(bomStr);
        for (let comp of components) {
          let compRowIdx = idToRow[comp.id.toUpperCase()];
          if (compRowIdx !== undefined) {
            let currentVal = (stockUpdates[compRowIdx] !== undefined) ? stockUpdates[compRowIdx] : Number(pData[compRowIdx][colIdx]);
            stockUpdates[compRowIdx] = currentVal - comp.qty;
          }
        }
        let selfVal = (stockUpdates[rowIdx] !== undefined) ? stockUpdates[rowIdx] : Number(pData[rowIdx][colIdx]);
        stockUpdates[rowIdx] = selfVal - 1;
      } else {
        let currentVal = (stockUpdates[rowIdx] !== undefined) ? stockUpdates[rowIdx] : Number(pData[rowIdx][colIdx]);
        stockUpdates[rowIdx] = currentVal - 1;
      }
    }

    for (let rIdx in stockUpdates) {
      if (stockUpdates[rIdx] < 0) return `❌ 庫存不足:${pData[rIdx][1]}`;
    }

    // 將地點(location)加入第11個欄位
    const rows = orderList.map(item => [
      timeStr, item.id, item.name, item.price, item.stamp, item.fee, item.total, 
      invoiceNum, branchName, userAcc, location
    ]);
    recordSheet.getRange(recordSheet.getLastRow() + 1, 1, rows.length, 11).setValues(rows);
    
    for (let rIdx in stockUpdates) {
      productSheet.getRange(parseInt(rIdx) + 1, colIdx + 1).setValue(stockUpdates[rIdx]);
    }

    return "OK";
  } catch (e) { 
    return "系統繁忙或錯誤: " + e.toString(); 
  } finally {
    lock.releaseLock(); 
  }
}

// 🔥 修正:查詢時可以依據地點過濾
function getSalesRecordsOptimized(keyword, dateStr, limit, branchName, userRole, locationFilter) {
  try {
    const ss = getDB();
    const sheet = ss.getSheetByName("Records");
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { records: [] };

    const data = sheet.getRange(2, 1, lastRow - 1, 11).getValues(); // 抓取 11 欄
    
    let filtered = data.filter(row => {
      if (!row[0]) return false;
      
      if (userRole === "STAFF") {
         if (String(row[8]).trim() !== String(branchName).trim()) return false;
      }

      const rowDateStr = Utilities.formatDate(new Date(row[0]), "GMT+8", "yyyy-MM-dd");
      const matchDate = dateStr ? (rowDateStr === dateStr) : true;
      const matchLoc = locationFilter ? (String(row[10]).trim() === String(locationFilter).trim()) : true;
      const kw = keyword ? keyword.toLowerCase() : "";
      const matchKw = kw ? (row[1].toString().toLowerCase().includes(kw) || row[2].toString().toLowerCase().includes(kw)) : true;
      
      return matchDate && matchKw && matchLoc;
    });

    const formatted = filtered.reverse().slice(0, limit).map(row => {
      row[0] = Utilities.formatDate(new Date(row[0]), "GMT+8", "yyyy/MM/dd HH:mm:ss");
      return row;
    });
    return { records: formatted };
  } catch (e) { return { records: [] }; }
}

// 🔥 修正:退庫時把數量還給發生交易的那個地點
function deleteSalesRecord(timeStr, ticketId, role, userBranch) {
  try {
    const ss = getDB();
    const rSheet = ss.getSheetByName("Records");
    const pSheet = ss.getSheetByName("Products");
    const data = rSheet.getDataRange().getValues();
    
    for (let i = data.length - 1; i >= 1; i--) {
      let cellDate = new Date(data[i][0]);
      let cellTimeStr = Utilities.formatDate(cellDate, "GMT+8", "yyyy/MM/dd HH:mm:ss");
      let cellTicket = data[i][1].toString().trim().toUpperCase();
      let inputTicket = ticketId.toString().trim().toUpperCase();
      let rowBranch = data[i][8];
      let rowLocation = data[i][10] || ""; // 從紀錄抓出發生地點

      if (cellTimeStr === timeStr && cellTicket === inputTicket) {
        if (role === "ADMIN" || (role === "STAFF" && rowBranch === userBranch)) {
          
          if (inputTicket === 'STAMPS00') {
             rSheet.deleteRow(i + 1);
             return "OK";
          }

          const colIdx = getLocationColumnIndex(pSheet, rowLocation); // 取得當初的地點欄位
          const pData = pSheet.getDataRange().getValues();
          let targetRowIdx = -1;
          let targetBOM = "";
          
          for (let j = 1; j < pData.length; j++) {
            if (pData[j][0].toString().toUpperCase() == inputTicket) {
              targetRowIdx = j; targetBOM = pData[j][12] || ""; break; // BOM 在 M 欄
            }
          }
          
          if (targetRowIdx !== -1) {
            if (targetBOM.toString().trim() !== "") {
              let components = parseBOM(targetBOM);
              components.forEach(comp => {
                for (let k = 1; k < pData.length; k++) {
                  if (pData[k][0].toString().toUpperCase() == comp.id.toUpperCase()) {
                    let currentRawStock = Number(pData[k][colIdx] || 0);
                    pSheet.getRange(k + 1, colIdx + 1).setValue(currentRawStock + comp.qty); break;
                  }
                }
              });
              let currentQuota = Number(pData[targetRowIdx][colIdx] || 0);
              pSheet.getRange(targetRowIdx + 1, colIdx + 1).setValue(currentQuota + 1);
            } else {
              let currentStock = Number(pData[targetRowIdx][colIdx] || 0);
              pSheet.getRange(targetRowIdx + 1, colIdx + 1).setValue(currentStock + 1);
            }
          }
          rSheet.deleteRow(i + 1);
          return "OK";
        } else { return "❌ 權限不足。"; }
      }
    }
    return "❌ 找不到資料。";
  } catch (e) { return "錯誤: " + e.toString(); }
}

function sendExcelToEmail(keyword, dateStr, branchName, locationFilter) {
  try {
      const ss = getDB();
      const settingsSheet = ss.getSheetByName("Settings");
      const targetEmail = settingsSheet.getRange("B5").getValue(); 
      if (!targetEmail) return "Settings!B5 未設定 Email";
      
      const searchRes = getSalesRecordsOptimized(keyword, dateStr, 50000, branchName, "ADMIN", locationFilter);
      
      if (!searchRes.records || searchRes.records.length === 0) return "⚠️ 查無資料。";

      const tempSS = SpreadsheetApp.create("Report_" + new Date().getTime());
      const tempSheet = tempSS.getSheets()[0];
      
      tempSheet.appendRow(["時間", "票號", "品名", "單價", "郵票", "製作費", "總額", "發票", "支局", "經辦", "地點"]);
      tempSheet.getRange(2, 1, searchRes.records.length, 11).setValues(searchRes.records);
      
      SpreadsheetApp.flush(); 
      Utilities.sleep(5000); 
      
      const url = "https://docs.google.com/feeds/download/spreadsheets/Export?key=" + tempSS.getId() + "&exportFormat=xlsx";
      const options = { headers: { 'Authorization': 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true };
      const response = UrlFetchApp.fetch(url, options);
      const filename = "Sales_Report_" + (dateStr ? dateStr : "All") + ".xlsx";
      const blob = response.getBlob().setName(filename);
      
      MailApp.sendEmail({
        to: targetEmail, 
        subject: "📊 銷售報表匯出: " + (dateStr ? dateStr : "全部"), 
        body: "資料筆數:" + searchRes.records.length + " 筆",
        attachments: [blob]
      });
      
      DriveApp.getFileById(tempSS.getId()).setTrashed(true); 
      return "OK";
  } catch(e) { return "錯誤: " + e.toString(); }
}

function parseBOM(bomStr) {
  let result = [];
  if (!bomStr) return result;
  let parts = bomStr.split(",");
  parts.forEach(p => {
    let pair = p.split(":");
    if (pair.length === 2) result.push({ id: pair[0].trim(), qty: parseInt(pair[1].trim()) });
  });
  return result;
}

// 🔥 v8.2 升級版:支援「二維矩陣」與「多地點」的自動排程補貨
function applyDailySchedule() {
  const ss = getDB();
  const scheduleSheet = ss.getSheetByName("ScheduleStock");
  const productSheet = ss.getSheetByName("Products");
  if (!scheduleSheet) return;
  
  const today = new Date();
  const todayStr = Utilities.formatDate(today, "GMT+8", "yyyy/MM/dd");
  const sData = scheduleSheet.getDataRange().getValues();
  if (sData.length < 2) return; // 只有標題或沒資料就跳出
  
  // 1. 解析標題列 (從 C 欄開始),抓取真正的商品 ID
  const headers = sData[0];
  let headerProductIds = [];
  for (let c = 2; c < headers.length; c++) {
    let rawHeader = String(headers[c]).trim();
    // 利用正則表達式,把 "A001 郵票" 或 "B002(福袋)" 切割,只取前面的 ID
    let pId = rawHeader.split(/[\s((_\-]/)[0].toUpperCase(); 
    headerProductIds[c] = pId;
  }
  
  // scheduleMap 結構: { "巨蛋攤位": { "A001": 50, "B002": 30 } }
  let scheduleMap = {}; 
  
  // 2. 往下尋找符合今天的排程紀錄
  for (let i = 1; i < sData.length; i++) {
    let rowDate = sData[i][0];
    if (rowDate && Utilities.formatDate(new Date(rowDate), "GMT+8", "yyyy/MM/dd") === todayStr) {
      let loc = String(sData[i][1]).trim(); // B欄:補貨地點
      if (!loc) continue; // 如果沒寫地點就跳過
      
      if (!scheduleMap[loc]) scheduleMap[loc] = {};
      
      // 讀取該列從 C 欄開始的所有商品補貨數量
      for (let c = 2; c < headers.length; c++) {
        let pId = headerProductIds[c];
        if (!pId) continue;
        
        let qty = sData[i][c];
        if (qty !== "" && !isNaN(qty)) { // 如果格子有填數字
          scheduleMap[loc][pId] = Number(qty);
        }
      }
    }
  }
  
  if (Object.keys(scheduleMap).length === 0) return; // 今天沒有任何補貨排程
  
  // 3. 實際將數字寫入 Products 的對應地點欄位
  const pData = productSheet.getDataRange().getValues();
  
  for (let loc in scheduleMap) {
      let colIdx = getLocationColumnIndex(productSheet, loc); // 自動尋找該地點的庫存欄位 (G, H, I...)
      
      for (let j = 1; j < pData.length; j++) {
        let pId = String(pData[j][0]).toUpperCase().trim();
        
        // 如果今天的排程表裡,這個地點有指定要補這個商品
        if (scheduleMap[loc][pId] !== undefined) {
            productSheet.getRange(j + 1, colIdx + 1).setValue(scheduleMap[loc][pId]);
        }
      }
  }
}

function getWebAppUrl() { return ScriptApp.getService().getUrl(); }

// ==========================================
// ⬇️ 報表區 ⬇️
// ==========================================

function generateProductAnalysis() {
  const ss = getDB();
  const recordSheet = ss.getSheetByName("Records");
  const lastRow = recordSheet.getLastRow();
  
  if (lastRow < 2) { SpreadsheetApp.getUi().alert("❌ 無銷售資料"); return; }
  
  // 抓取 11 欄 (包含地點)
  const data = recordSheet.getRange(2, 1, lastRow - 1, 11).getValues();
  
  let productSet = new Set();
  let dateSet = new Set();
  let matrix = {}; 

  for (let i = 0; i < data.length; i++) {
    let timeVal = data[i][0];
    let pName = String(data[i][2]).trim(); 
    // let loc = String(data[i][10]).trim(); // 若日後要依地點拆分矩陣可運用此變數
    
    if (!timeVal || !pName) continue;
    
    let dateStr = Utilities.formatDate(new Date(timeVal), "GMT+8", "yyyy/MM/dd");
    
    productSet.add(pName);
    dateSet.add(dateStr);
    
    if (!matrix[dateStr]) matrix[dateStr] = {};
    if (!matrix[dateStr][pName]) matrix[dateStr][pName] = 0;
    
    matrix[dateStr][pName]++;
  }

  let sortedDates = Array.from(dateSet).sort();
  let sortedProducts = Array.from(productSet).sort();
  
  let headerRow = ["日期", ...sortedProducts, "當日總銷量"];
  let outputData = [headerRow];
  
  sortedDates.forEach(date => {
    let row = [date];
    let dayTotal = 0;
    
    sortedProducts.forEach(prod => {
      let count = (matrix[date] && matrix[date][prod]) ? matrix[date][prod] : 0;
      row.push(count === 0 ? "" : count); 
      dayTotal += count;
    });
    
    row.push(dayTotal);
    outputData.push(row);
  });

  let targetSheetName = "📦 品項熱銷矩陣";
  let targetSheet = ss.getSheetByName(targetSheetName);
  
  if (!targetSheet) {
      targetSheet = ss.insertSheet(targetSheetName);
  } else { 
      targetSheet.clear();
      targetSheet.getDataRange().clearFormat(); 
  }

  targetSheet.getRange(1, 1, outputData.length, outputData[0].length).setValues(outputData);
  
  targetSheet.setFrozenRows(1);
  targetSheet.setFrozenColumns(1);
  let headerRange = targetSheet.getRange(1, 1, 1, outputData[0].length);
  headerRange.setFontWeight("bold").setBackground("#e3f2fd").setBorder(true, true, true, true, true, true);
  
  targetSheet.autoResizeColumn(1);
  if (outputData[0].length > 1) {
      targetSheet.setColumnWidths(2, outputData[0].length - 1, 80);
  }
  
  if (outputData.length > 1) {
      targetSheet.setRowHeights(2, outputData.length - 1, 60);
  }
  
  let fullRange = targetSheet.getDataRange();
  fullRange.setHorizontalAlignment("center");
  fullRange.setVerticalAlignment("middle");   
  fullRange.setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP); 
  
  let lastCol = outputData[0].length;
  targetSheet.getRange(1, lastCol, outputData.length, 1).setBackground("#fff3e0").setFontWeight("bold");

  SpreadsheetApp.getUi().alert("✅ 品項矩陣分析完成!");
}

// ==========================================
// ⬇️ 系統後台專用 API ⬇️
// ==========================================

// 讀取 Settings 表格資料
function getAdminSettings() {
  try {
    const ss = getDB();
    const sheet = ss.getSheetByName("Settings");
    if (!sheet) return null;
    
    // 讀取 B6 以下的所有地點
    let locations = [];
    const locData = sheet.getRange("B6:B").getValues();
    locations = locData.filter(r => r[0].toString().trim() !== "").map(r => r[0].toString().trim());

    return {
      title: sheet.getRange("B1").getValue() || "",
      version: sheet.getRange("B2").getValue() || "",
      notice: sheet.getRange("B3").getValue() || "",
      activityUrl: sheet.getRange("B4").getValue() || "",
      email: sheet.getRange("B5").getValue() || "",
      locations: locations
    };
  } catch(e) { return null; }
}

// 儲存至 Settings 表格
function saveAdminSettings(data) {
  try {
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    
    const ss = getDB();
    const sheet = ss.getSheetByName("Settings");
    if (!sheet) return "找不到 Settings 工作表";
    
    sheet.getRange("B1").setValue(data.title);
    sheet.getRange("B2").setValue(data.version);
    sheet.getRange("B3").setValue(data.notice);
    sheet.getRange("B4").setValue(data.activityUrl);
    sheet.getRange("B5").setValue(data.email);
    
    // 清空舊的地點資料 (B6 以下)
    sheet.getRange("B6:B").clearContent();
    
    // 寫入新的地點資料
    if (data.locations && data.locations.length > 0) {
      const locArray = data.locations.map(loc => [loc]); // 轉為 2D 陣列
      sheet.getRange(6, 2, locArray.length, 1).setValues(locArray);
    }
    
    lock.releaseLock();
    return "OK";
  } catch(e) { return e.toString(); }
}

// 讀取所有帳號 (供系統後台使用)
function getAdminUsers() {
  try {
    const ss = getDB();
    const sheet = ss.getSheetByName("Users");
    if (!sheet) return [];
    
    const data = sheet.getDataRange().getDisplayValues();
    let users = [];
    // i=1 是因為第一列是標題
    for (let i = 1; i < data.length; i++) {
      if (data[i][0]) {
        users.push({
          account: data[i][0].toString().trim(),
          password: data[i][1].toString().trim(),
          branch: data[i][2].toString().trim(),
          role: data[i][3].toString().trim().toUpperCase()
        });
      }
    }
    return users;
  } catch(e) { return []; }
}

// 新增、修改、刪除帳號核心邏輯
function manageAdminUser(action, userData, originalAcc) {
  try {
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    
    const ss = getDB();
    const sheet = ss.getSheetByName("Users");
    if (!sheet) { lock.releaseLock(); return "❌ 找不到 Users 工作表"; }
    
    const data = sheet.getDataRange().getDisplayValues();
    
    // ==========================================
    // 動作:新增 (ADD)
    // ==========================================
    if (action === "ADD") {
      // 檢查帳號是否已經存在
      for (let i = 1; i < data.length; i++) {
        if (data[i][0].toString().trim() === userData.account) {
           lock.releaseLock();
           return "❌ 此員工編號/帳號已經存在!";
        }
      }
      // 在最後一行插入新資料
      sheet.appendRow([userData.account, userData.password, userData.branch, userData.role]);
    } 
    // ==========================================
    // 動作:編輯或刪除 (EDIT / DELETE)
    // ==========================================
    else if (action === "EDIT" || action === "DELETE") {
      let foundRowIndex = -1;
      
      // 尋找舊帳號在哪一列
      for (let i = 1; i < data.length; i++) {
        if (data[i][0].toString().trim() === originalAcc) {
          foundRowIndex = i + 1; // +1 是因為 GAS 列數從 1 開始算
          break;
        }
      }
      
      if (foundRowIndex === -1) {
         lock.releaseLock();
         return "❌ 找不到原始帳號,可能已被刪除。";
      }
      
      if (action === "DELETE") {
         sheet.deleteRow(foundRowIndex);
      } 
      else if (action === "EDIT") {
         // 如果他連「帳號(員工編號)」都改了,要檢查新改的名字有沒有跟別人撞名
         if (userData.account !== originalAcc) {
             for (let i = 1; i < data.length; i++) {
                if (data[i][0].toString().trim() === userData.account) {
                   lock.releaseLock();
                   return "❌ 新的員工編號/帳號已經被其他人使用了!";
                }
             }
         }
         // 將修改後的四個欄位覆蓋回去
         sheet.getRange(foundRowIndex, 1, 1, 4).setValues([[userData.account, userData.password, userData.branch, userData.role]]);
      }
    }
    
    lock.releaseLock();
    return "OK";
  } catch(e) { return "錯誤: " + e.toString(); }
}

// ==========================================
// ⬇️ 系統後台 - 商品管理 API ⬇️
// ==========================================

// 讀取所有商品與動態庫存欄位
function getAdminProducts() {
  try {
    const ss = getDB();
    const sheet = ss.getSheetByName("Products");
    if (!sheet) return { products: [], locations: [] };

    const data = sheet.getDataRange().getDisplayValues();
    if (data.length < 1) return { products: [], locations: [] };

    const headers = data[0];
    let locHeaders = [];
    
    // 🔥 修正 1:抓取 G 到 L 欄 (索引 6 到 11)
    for (let c = 6; c <= 11; c++) {
      if (headers[c] && headers[c].toString().trim() !== "") {
        locHeaders.push({ index: c, name: headers[c].toString().trim() });
      }
    }

    let products = [];
    for (let i = 1; i < data.length; i++) {
      if (data[i][0]) {
        let stocks = {};
        locHeaders.forEach(loc => {
          stocks[loc.name] = parseInt(data[i][loc.index] || 0);
        });
        
        products.push({
          id: data[i][0].toString().trim(),
          name: data[i][1].toString().trim(),
          price: parseInt(data[i][2] || 0),
          stamp: parseInt(data[i][3] || 0),
          fee: parseInt(data[i][4] || 0),
          total: parseInt(data[i][5] || 0),
          bom: data[i][12] ? data[i][12].toString().trim() : "",
          stocks: stocks
        });
      }
    }
    return { products: products, locations: locHeaders.map(l => l.name) };
  } catch(e) { return { products: [], locations: [] }; }
}

// 新增、修改、刪除商品
function manageAdminProduct(action, productData, originalId) {
  try {
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);

    const ss = getDB();
    const sheet = ss.getSheetByName("Products");
    if (!sheet) { lock.releaseLock(); return "❌ 找不到 Products 工作表"; }

    const data = sheet.getDataRange().getDisplayValues();
    const headers = data[0];

    // ================= 新增 =================
    if (action === "ADD") {
      for (let i = 1; i < data.length; i++) {
        if (data[i][0] && data[i][0].toString().trim().toUpperCase() === productData.id.toUpperCase()) {
           lock.releaseLock(); return "❌ 此票號已經存在!";
        }
      }
      
      let targetRow = data.length + 1;
      for (let i = 1; i < data.length; i++) {
        if (data[i][0].toString().trim() === "") {
           targetRow = i + 1;
           break;
        }
      }
      
      sheet.getRange(targetRow, 1).setValue(productData.id.toUpperCase());
      sheet.getRange(targetRow, 13).setValue(productData.bom); 

      // 🔥 修正 1:精準寫入 G~L 欄庫存
      if (productData.stocks) {
        for (let c = 6; c <= 11; c++) {
          if (headers[c] && productData.stocks[headers[c]] !== undefined) {
            sheet.getRange(targetRow, c + 1).setValue(productData.stocks[headers[c]]);
          }
        }
      }

    // ================= 編輯 / 刪除 =================
    } else if (action === "EDIT" || action === "DELETE") {
      let foundRowIndex = -1;
      for (let i = 1; i < data.length; i++) {
        if (data[i][0] && data[i][0].toString().trim().toUpperCase() === originalId.toUpperCase()) {
          foundRowIndex = i + 1; break;
        }
      }
      if (foundRowIndex === -1) { lock.releaseLock(); return "❌ 找不到原始商品。"; }

      if (action === "DELETE") {
         sheet.deleteRow(foundRowIndex);
      } else if (action === "EDIT") {
         if (productData.id.toUpperCase() !== originalId.toUpperCase()) {
             for (let i = 1; i < data.length; i++) {
                if (data[i][0] && data[i][0].toString().trim().toUpperCase() === productData.id.toUpperCase()) {
                   lock.releaseLock(); return "❌ 新的票號已被其他商品使用!";
                }
             }
         }
         
         sheet.getRange(foundRowIndex, 1).setValue(productData.id.toUpperCase());
         sheet.getRange(foundRowIndex, 13).setValue(productData.bom);

         // 🔥 修正 1:精準寫入 G~L 欄庫存
         if (productData.stocks) {
            for (let c = 6; c <= 11; c++) {
              if (headers[c] && productData.stocks[headers[c]] !== undefined) {
                sheet.getRange(foundRowIndex, c + 1).setValue(productData.stocks[headers[c]]);
              }
            }
         }
      }
    }
    
    lock.releaseLock();
    return "OK";
  } catch(e) { return "錯誤: " + e.toString(); }
}

// ==========================================
// 🔥 系統後台 - 從主檔查詢票品資訊
// ==========================================
function getProductInfoFromMaster(ticketId) {
  try {
    const ss = getDB();
    const masterSheet = ss.getSheetByName("對應票品票號");
    if (!masterSheet) return { success: false, msg: "找不到「對應票品票號」工作表。" };

    const data = masterSheet.getDataRange().getDisplayValues();
    
    // 往下尋找符合的票號
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] && data[i][0].toString().trim().toUpperCase() === ticketId.trim().toUpperCase()) {
        return {
          success: true,
          name: data[i][1] ? data[i][1].toString().trim() : "無品名",
          price: data[i][2] ? data[i][2].toString().trim() : "0",
          stamp: data[i][3] ? data[i][3].toString().trim() : "0",
          fee: data[i][4] ? data[i][4].toString().trim() : "0",
          total: data[i][5] ? data[i][5].toString().trim() : "0"
        };
      }
    }
    return { success: false, msg: "在主檔中找不到此票號。" };
  } catch(e) { return { success: false, msg: "系統錯誤: " + e.toString() }; }
}

// ==========================================
// 🔥 系統後台 - 戰情室報表 (PDF對齊版,含BOM拆解)
// ==========================================
function getAdminReportData(startDate, endDate, locationFilter) {
  try {
    const ss = getDB();
    const recordsSheet = ss.getSheetByName("Records");
    const productsSheet = ss.getSheetByName("Products");
    const setSheet = ss.getSheetByName("Settings");
    
    if (!recordsSheet || !productsSheet) return { success: false, msg: "找不到資料表" };

    // 1. 取得商品主檔 (用來辨識 BOM 與排序)
    const pData = productsSheet.getDataRange().getDisplayValues();
    let pMap = {};
    for(let i = 1; i < pData.length; i++) {
      if(!pData[i][0]) continue;
      let id = pData[i][0].toString().trim().toUpperCase();
      pMap[id] = {
        id: id,
        name: pData[i][1].toString().trim(),
        bom: pData[i][12] ? pData[i][12].toString().trim() : "",
        rowOrder: i // 紀錄在試算表的順序
      };
    }

    // 2. 取得攤位清單 (給前端下拉選單用)
    let locs = [];
    if (setSheet) {
      const locData = setSheet.getRange("B6:B").getValues();
      locs = locData.map(r => r[0].toString().trim()).filter(r => r !== "");
    }

    // 3. 處理銷售紀錄
    const lastRow = recordsSheet.getLastRow();
    if (lastRow < 2) return { success: true, data: { sumT:0, sumP:0, sumS:0, sumF:0, orders:0, salesList:[], deductList:[], locations: locs } };

    const rData = recordsSheet.getRange(2, 1, lastRow - 1, 11).getValues();
    
    let sumT = 0, sumP = 0, sumS = 0, sumF = 0;
    let orderSet = new Set();
    let salesMap = {};
    let deductMap = {};

    let startNum = startDate ? parseInt(startDate.replace(/-/g, "")) : 0;
    let endNum = endDate ? parseInt(endDate.replace(/-/g, "")) : 99999999;

    rData.forEach(row => {
      if (!row[0]) return;
      let rowDate = new Date(row[0]);
      let dateNum = parseInt(Utilities.formatDate(rowDate, "GMT+8", "yyyyMMdd"));
      let loc = row[10] ? row[10].toString().trim() : "";

      // 檢查日期與地點篩選
      if (dateNum >= startNum && dateNum <= endNum) {
        if (locationFilter && locationFilter !== "" && loc !== locationFilter) return;

        let timeStr = Utilities.formatDate(rowDate, "GMT+8", "yyyy/MM/dd HH:mm:ss");
        let pId = row[1] ? row[1].toString().trim().toUpperCase() : "";
        let pName = row[2] ? row[2].toString().trim() : "";
        let price = Number(row[3]) || 0;
        let stamp = Number(row[4]) || 0;
        let fee = Number(row[5]) || 0;
        let total = Number(row[6]) || 0;

        sumP += price; sumS += stamp; sumF += fee; sumT += total;
        orderSet.add(timeStr + "_" + loc); // 獨一無二的訂單編號

        // 📦 左側:銷售品項統計
        let key = pId === 'STAMPS00' ? pId + '_' + pName : pId;
        if (!salesMap[key]) salesMap[key] = { id: pId, name: pName, qty: 0 };
        salesMap[key].qty++;

        // 🏭 右側:實際庫存扣除 (BOM展開)
        let prod = pMap[pId];
        if (prod && prod.bom) {
          // 如果是組合包,拆解 BOM 內容 (例如 A001:2,B002:1)
          let parts = prod.bom.split(',');
          parts.forEach(part => {
            let pair = part.split(':');
            if (pair.length === 2) {
              let subId = pair[0].trim().toUpperCase();
              let subQty = parseInt(pair[1].trim()) || 1;
              if (!deductMap[subId]) deductMap[subId] = { id: subId, name: pMap[subId] ? pMap[subId].name : subId, qty: 0 };
              deductMap[subId].qty += subQty;
            }
          });
        } else {
          // 一般單品 (非郵票才扣庫存)
          if (pId !== 'STAMPS00') {
            if (!deductMap[pId]) deductMap[pId] = { id: pId, name: pName, qty: 0 };
            deductMap[pId].qty++;
          }
        }
      }
    });

    // 依據商品主檔的順序排序
    let salesList = Object.values(salesMap).sort((a,b) => (pMap[a.id] ? pMap[a.id].rowOrder : 9999) - (pMap[b.id] ? pMap[b.id].rowOrder : 9999));
    let deductList = Object.values(deductMap).sort((a,b) => (pMap[a.id] ? pMap[a.id].rowOrder : 9999) - (pMap[b.id] ? pMap[b.id].rowOrder : 9999));

    return {
      success: true,
      data: {
        sumT: sumT, sumP: sumP, sumS: sumS, sumF: sumF,
        orders: orderSet.size,
        salesList: salesList,
        deductList: deductList,
        locations: locs
      }
    };
  } catch(e) { return { success: false, msg: "報表計算錯誤: " + e.toString() }; }
}

// ==========================================
// 🔥 系統後台 - 排程補貨 (跨庫轉檔神器與防呆機制)
// ==========================================
const SOURCE_ALLOCATION_ID = '1UbMMJHehrWy5Zvadyw1v3MlJIMmyqXfTtxKHale9xOg'; // 票券股配票總庫

// 1. 讀取最新配票動態與目前的排程預覽
function getScheduleDashboardData() {
  try {
    let sourceSS = SpreadsheetApp.openById(SOURCE_ALLOCATION_ID);
    let allocSheet = sourceSS.getSheetByName("Allocation_Master");
    let targetSS = getDB();
    let scheduleSheet = targetSS.getSheetByName("ScheduleStock");
    
    if (!allocSheet || !scheduleSheet) return { success: false, msg: "找不到對應的工作表" };

    // --- 抓取已轉入的單號 (防呆比對用) ---
    let importedOrders = [];
    let sMaxCol = scheduleSheet.getLastColumn();
    let sMaxRow = scheduleSheet.getLastRow();
    let scheduleHeaders = sMaxCol > 0 ? scheduleSheet.getRange(1, 1, 1, sMaxCol).getValues()[0] : [];
    let orderColIdx = scheduleHeaders.indexOf("配票單號");
    
    if (orderColIdx !== -1 && sMaxRow > 1) {
      // 取得該直欄的所有資料
      let orderData = scheduleSheet.getRange(2, orderColIdx + 1, sMaxRow - 1, 1).getValues();
      importedOrders = orderData.map(r => r[0].toString().trim());
    }

    // --- 抓取票券股最新配票單號 ---
    let allocData = allocSheet.getDataRange().getValues();
    let recentOrdersMap = {};
    let recentOrdersList = [];
    
    // 從下往上掃描 (抓最新的)
    for (let i = allocData.length - 1; i >= 1; i--) {
      let row = allocData[i];
      let orderId = String(row[0]).trim();
      if (!orderId) continue;
      
      if (!recentOrdersMap[orderId]) {
        let rawDate = row[1];
        let eDate = (Object.prototype.toString.call(rawDate) === '[object Date]') 
                    ? Utilities.formatDate(rawDate, "GMT+8", "yyyy/MM/dd") 
                    : String(rawDate).trim();
        
        recentOrdersMap[orderId] = {
          orderId: orderId,
          date: eDate,
          location: String(row[2]).trim(),
          isImported: importedOrders.includes(orderId) // 🔥 防呆:標記是否已轉入
        };
        recentOrdersList.push(recentOrdersMap[orderId]);
      }
      if (recentOrdersList.length >= 10) break; // 只取最新 10 筆
    }

    // --- 抓取排程預覽表資料 (讓前端顯示) ---
    let previewData = { headers: [], rows: [] };
    if (sMaxCol > 0 && sMaxRow > 0) {
      previewData.headers = scheduleHeaders;
      // 只抓最後 20 筆顯示,避免網頁卡頓
      let startRow = Math.max(2, sMaxRow - 19);
      previewData.rows = scheduleSheet.getRange(startRow, 1, sMaxRow - startRow + 1, sMaxCol).getDisplayValues();
    }

    return { 
      success: true, 
      data: { recentOrders: recentOrdersList, preview: previewData } 
    };

  } catch(e) { return { success: false, msg: "讀取錯誤:" + e.toString() }; }
}

// 2. 執行跨庫轉檔 (附帶嚴格防呆)
function runAllocationTransfer(targetOrderId) {
  try {
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);

    let sourceSS = SpreadsheetApp.openById(SOURCE_ALLOCATION_ID);
    const allocSheet = sourceSS.getSheetByName("Allocation_Master");
    if (!allocSheet) { lock.releaseLock(); return { success: false, msg: "配票總庫找不到 Allocation_Master" }; }

    let targetSS = getDB();
    let scheduleSheet = targetSS.getSheetByName("ScheduleStock"); 
    if (!scheduleSheet) { lock.releaseLock(); return { success: false, msg: "收銀機找不到 ScheduleStock" }; }

    let maxCol = scheduleSheet.getLastColumn();
    if (maxCol < 2) maxCol = 2; 
    let headers = scheduleSheet.getRange(1, 1, 1, maxCol).getValues()[0];

    // 🔥 防呆第一關:檢查是否已存在
    let orderColIdx = headers.indexOf("配票單號");
    if (orderColIdx !== -1 && scheduleSheet.getLastRow() > 1) {
      let existingOrders = scheduleSheet.getRange(2, orderColIdx + 1, scheduleSheet.getLastRow() - 1, 1).getValues().map(r => r[0].toString().trim());
      if (existingOrders.includes(targetOrderId)) {
        lock.releaseLock(); return { success: false, msg: `⚠️ 攔截!單號 [${targetOrderId}] 已經被轉入過了!` };
      }
    }

    // 打撈資料
    const allocData = allocSheet.getDataRange().getValues();
    let foundItems = [];
    let eventDate = "";
    let eventLoc = "";

    for (let i = 1; i < allocData.length; i++) {
      let row = allocData[i];
      if (String(row[0]).trim() === targetOrderId) {
        if (!eventDate) {
           let d = row[1];
           eventDate = (Object.prototype.toString.call(d) === '[object Date]') ? Utilities.formatDate(d, "GMT+8", "yyyy/MM/dd") : String(d).trim();
           eventLoc = String(row[2]).trim(); 
        }
        let cat = String(row[4]).trim();
        let prod = String(row[5]).trim();
        let no = String(row[6]).trim();
        let name = String(row[7]).trim();
        let headerName = cat + prod + no + " " + name;

        foundItems.push({ header: headerName, qty: Number(row[9]) || 0 });
      }
    }

    if (foundItems.length === 0) { lock.releaseLock(); return { success: false, msg: `找不到單號 [${targetOrderId}] 的配票紀錄!` }; }

    // 準備寫入
    if (headers.length === 0 || !headers[0]) {
       headers[0] = "預定日期";
       headers[1] = "補貨地點";
    }

    let newRowData = new Array(headers.length).fill("");
    newRowData[0] = eventDate; 
    newRowData[1] = eventLoc;

    let newHeadersToAppend = [];

    // 🔥 確保「配票單號」欄位存在
    if (orderColIdx === -1) {
      orderColIdx = headers.length + newHeadersToAppend.length;
      newHeadersToAppend.push("配票單號");
    }
    newRowData[orderColIdx] = targetOrderId; // 寫入單號留底

    // 填入商品數量
    foundItems.forEach(item => {
       let colIndex = headers.indexOf(item.header);
       if (colIndex !== -1) {
          newRowData[colIndex] = item.qty;
       } else {
          let newColIndex = headers.length + newHeadersToAppend.length;
          newHeadersToAppend.push(item.header);
          newRowData[newColIndex] = item.qty;
       }
    });

    // 擴充新標題
    if (newHeadersToAppend.length > 0) {
       scheduleSheet.getRange(1, maxCol + 1, 1, newHeadersToAppend.length).setValues([newHeadersToAppend]);
    }

    // 補齊陣列長度
    let finalTotalCols = headers.length + newHeadersToAppend.length;
    while(newRowData.length < finalTotalCols) { newRowData.push(""); }

    scheduleSheet.appendRow(newRowData);
    
    lock.releaseLock();
    return { success: true, msg: `✅ 成功載入單號 [${targetOrderId}]!共寫入 ${foundItems.length} 項商品。` };

  } catch(e) { 
    return { success: false, msg: "轉檔發生錯誤:" + e.toString() }; 
  }
}
