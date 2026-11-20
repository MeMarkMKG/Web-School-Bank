/**
 * ระบบฝาก-ถอนเงินนักเรียน — Backend สำหรับ Google Apps Script
 * -----------------------------------------------------------------------
 * วิธีติดตั้ง
 * 1) เปิด Google Sheet ใหม่ แล้วไปที่เมนู Extensions > Apps Script
 * 2) ลบโค้ดเดิมทั้งหมด แล้ววางโค้ดไฟล์นี้ลงไป
 * 3) กด Deploy > New deployment > เลือกประเภท "Web app"
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 4) คัดลอก URL ที่ลงท้ายด้วย /exec ไปใส่ใน CONFIG.API_URL ของ js/app.js
 *
 * ชีต "Students" และ "Transactions" จะถูกสร้างให้อัตโนมัติเมื่อเรียกใช้ครั้งแรก
 */

var SHEET_STUDENTS = 'Students';
var SHEET_TRANSACTIONS = 'Transactions';

var SHEET_HEADERS = {
  students: ['id', 'name', 'room', 'balance', 'createdAt', 'updatedAt', 'photo'],
  transactions: ['id', 'studentId', 'studentName', 'type', 'amount', 'note', 'balanceAfter', 'createdAt'],
};

/* ---------- Web app entry points ---------------------------------------- */

function doGet() {
  return jsonOutput({ ok: true, data: { message: 'Student wallet API is running' } });
}

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var data = route(String(body.action || 'list'), body.payload || {});
    return jsonOutput({ ok: true, data: data });
  } catch (error) {
    return jsonOutput({
      ok: false,
      error: error && error.message ? error.message : String(error),
    });
  }
}

function route(action, payload) {
  switch (action) {
    case 'list':
      return listAll_();
    case 'addStudent':
      return withLock_(function () {
        return addStudent_(payload);
      });
    case 'updateStudent':
      return withLock_(function () {
        return updateStudent_(payload);
      });
    case 'deleteStudent':
      return withLock_(function () {
        return deleteStudent_(payload);
      });
    case 'transaction':
      return withLock_(function () {
        return createTransaction_(payload);
      });
    default:
      throw new Error('ไม่รู้จักคำสั่ง: ' + action);
  }
}

/* ---------- Helpers ------------------------------------------------------ */

function jsonOutput(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(
    ContentService.MimeType.JSON
  );
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) {
    throw new Error('ระบบกำลังบันทึกรายการอื่นอยู่ กรุณาลองใหม่อีกครั้ง');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function getSheet_(key) {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var sheetName = key === 'students' ? SHEET_STUDENTS : SHEET_TRANSACTIONS;
  var headers = SHEET_HEADERS[key];
  var sheet = spreadsheet.getSheetByName(sheetName);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
    writeHeaders_(sheet, headers);
  } else {
    ensureHeaders_(sheet, headers);
  }

  return sheet;
}

function writeHeaders_(sheet, headers) {
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  sheet.setFrozenRows(1);
}

// เพิ่มหัวคอลัมน์ที่ยังไม่มี (เช่น คอลัมน์ photo ของชีตเก่า) โดยไม่กระทบข้อมูลเดิม
function ensureHeaders_(sheet, headers) {
  if (sheet.getLastRow() === 0) {
    writeHeaders_(sheet, headers);
    return;
  }

  var lastColumn = Math.max(sheet.getLastColumn(), 1);
  var current = sheet
    .getRange(1, 1, 1, lastColumn)
    .getValues()[0]
    .map(function (value) {
      return String(value).trim();
    });

  var missing = headers.filter(function (header) {
    return current.indexOf(header) === -1;
  });
  if (!missing.length) return;

  sheet.getRange(1, current.length + 1, 1, missing.length).setValues([missing]);
}

function columnOf_(key, header) {
  return SHEET_HEADERS[key].indexOf(header) + 1;
}

function readRows_(key) {
  var sheet = getSheet_(key);
  var headers = SHEET_HEADERS[key];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();

  return values
    .filter(function (row) {
      return row[0] !== '' && row[0] !== null;
    })
    .map(function (row) {
      var item = {};
      headers.forEach(function (header, index) {
        var value = row[index];
        if (value instanceof Date) value = value.toISOString();
        if (header === 'balance' || header === 'amount' || header === 'balanceAfter') {
          value = Number(value) || 0;
        }
        if (header === 'id' || header === 'studentId') {
          value = Number(value) || 0;
        }
        item[header] = value;
      });
      return item;
    });
}

function findRowIndex_(sheet, id) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;

  var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2;
  }
  return -1;
}

function nextId_(key) {
  return (
    readRows_(key).reduce(function (max, row) {
      return Math.max(max, Number(row.id) || 0);
    }, 0) + 1
  );
}

function getStudent_(id) {
  var students = readRows_('students');
  for (var i = 0; i < students.length; i++) {
    if (String(students[i].id) === String(id)) return students[i];
  }
  throw new Error('ไม่พบนักเรียนคนนี้');
}

/* ---------- Actions ----------------------------------------------------- */

function listAll_() {
  return {
    students: readRows_('students'),
    transactions: readRows_('transactions'),
  };
}

function addStudent_(payload) {
  var name = String(payload.name || '').trim();
  var room = String(payload.room || '').trim();
  if (!name) throw new Error('กรุณากรอกชื่อนักเรียน');

  var sheet = getSheet_('students');
  var now = new Date();
  var id = nextId_('students');
  sheet.appendRow([id, name, room, 0, now, now, String(payload.photo || '')]);

  return { student: getStudent_(id) };
}

function updateStudent_(payload) {
  var name = String(payload.name || '').trim();
  var room = String(payload.room || '').trim();
  if (!name) throw new Error('กรุณากรอกชื่อนักเรียน');

  var sheet = getSheet_('students');
  var rowIndex = findRowIndex_(sheet, payload.id);
  if (rowIndex < 0) throw new Error('ไม่พบนักเรียนคนนี้');

  sheet.getRange(rowIndex, 2, 1, 2).setValues([[name, room]]);
  if (payload.photo !== undefined) {
    sheet.getRange(rowIndex, columnOf_('students', 'photo')).setValue(String(payload.photo || ''));
  }
  sheet.getRange(rowIndex, columnOf_('students', 'updatedAt')).setValue(new Date());

  updateTransactionNames_(payload.id, name);

  return { student: getStudent_(payload.id) };
}

function updateTransactionNames_(studentId, name) {
  var sheet = getSheet_('transactions');
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  var names = sheet.getRange(2, 3, lastRow - 1, 1).getValues();
  var ids = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
  var changed = false;

  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(studentId)) {
      names[i][0] = name;
      changed = true;
    }
  }

  if (changed) sheet.getRange(2, 3, names.length, 1).setValues(names);
}

function deleteStudent_(payload) {
  var studentsSheet = getSheet_('students');
  var rowIndex = findRowIndex_(studentsSheet, payload.id);
  if (rowIndex < 0) throw new Error('ไม่พบนักเรียนคนนี้');

  studentsSheet.deleteRow(rowIndex);

  var txSheet = getSheet_('transactions');
  var width = SHEET_HEADERS.transactions.length;
  var lastRow = txSheet.getLastRow();
  if (lastRow < 2) return { id: payload.id };

  var values = txSheet.getRange(2, 1, lastRow - 1, width).getValues();
  var kept = values.filter(function (row) {
    return String(row[1]) !== String(payload.id);
  });

  txSheet.getRange(2, 1, lastRow - 1, width).clearContent();
  if (kept.length) {
    txSheet.getRange(2, 1, kept.length, width).setValues(kept);
  }

  return { id: payload.id };
}

function createTransaction_(payload) {
  var type = String(payload.type || '');
  var amount = Math.round((Number(payload.amount) || 0) * 100) / 100;
  var note = String(payload.note || '').trim();

  if (type !== 'deposit' && type !== 'withdraw') {
    throw new Error('ประเภทการทำรายการไม่ถูกต้อง');
  }
  if (!(amount > 0)) throw new Error('จำนวนเงินต้องมากกว่า 0');

  var studentsSheet = getSheet_('students');
  var rowIndex = findRowIndex_(studentsSheet, payload.studentId);
  if (rowIndex < 0) throw new Error('ไม่พบนักเรียนคนนี้');

  var name = studentsSheet.getRange(rowIndex, 2).getValue();
  var room = studentsSheet.getRange(rowIndex, 3).getValue();
  var balance = Number(studentsSheet.getRange(rowIndex, 4).getValue()) || 0;

  var newBalance =
    Math.round((type === 'deposit' ? balance + amount : balance - amount) * 100) / 100;
  var now = new Date();

  studentsSheet.getRange(rowIndex, 4).setValue(newBalance);
  studentsSheet.getRange(rowIndex, 6).setValue(now);

  var txSheet = getSheet_('transactions');
  var transactionId = nextId_('transactions');
  txSheet.appendRow([transactionId, Number(payload.studentId), name, type, amount, note, newBalance, now]);

  return {
    student: {
      id: Number(payload.studentId),
      name: name,
      room: room,
      balance: newBalance,
      updatedAt: now.toISOString(),
    },
    transaction: {
      id: transactionId,
      studentId: Number(payload.studentId),
      studentName: name,
      type: type,
      amount: amount,
      note: note,
      balanceAfter: newBalance,
      createdAt: now.toISOString(),
    },
  };
}
