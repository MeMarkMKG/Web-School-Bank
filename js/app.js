'use strict';

/* ==========================================================================
   ระบบฝาก-ถอนเงินนักเรียน — app.js
   --------------------------------------------------------------------------
   วิธีเชื่อมต่อ Google Sheet
   1) วางโค้ดใน google-apps-script/Code.gs ลงใน Apps Script ของ Google Sheet
   2) Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone)
   3) นำ URL ที่ลงท้ายด้วย /exec มาใส่ใน CONFIG.API_URL ด้านล่าง
   ถ้าเว้นว่างไว้ ระบบจะทำงานใน "โหมดทดลอง" โดยเก็บข้อมูลในเบราว์เซอร์เครื่องนี้
   ========================================================================== */

const CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbywNYk1Pq36OC4IV085xFxucq_tzR2zjgotegehU_xx7s_CqNNcxdT_wQxgkRRnQd41/exec',
};

const STORAGE_KEY = 'student-wallet-demo-v1';

const state = {
  students: [],
  transactions: [],
  search: '',
  historySearch: '',
  historyType: 'all',
};

const els = {};

/* ---------- ตัวช่วยจัดรูปแบบ --------------------------------------------- */

const moneyFormatter = new Intl.NumberFormat('th-TH', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const dateFormatter = new Intl.DateTimeFormat('th-TH', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function formatMoney(value) {
  return moneyFormatter.format(Number(value) || 0);
}

function formatDate(value) {
  const date = new Date(value);
  if (isNaN(date.getTime())) return '-';
  return dateFormatter.format(date);
}

function dayKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) return '';
  return date.getFullYear() + '-' + date.getMonth() + '-' + date.getDate();
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function initials(name) {
  const text = String(name || '').trim();
  return text ? text.charAt(0).toUpperCase() : '?';
}

/* ---------- รูปภาพนักเรียน ---------------------------------------------- */

const PHOTO_SIZE = 160;
const PHOTO_MAX_BYTES = 8 * 1024 * 1024;

function isPhoto(value) {
  return typeof value === 'string' && value.indexOf('data:image/') === 0;
}

function avatarMarkup(student) {
  if (isPhoto(student.photo)) {
    return '<img class="avatar" src="' + escapeHtml(student.photo) + '" alt="" loading="lazy" />';
  }
  return '<span class="avatar" aria-hidden="true">' + escapeHtml(initials(student.name)) + '</span>';
}

function setPhotoPreview(dataUrl, name) {
  const photo = isPhoto(dataUrl) ? dataUrl : '';
  els.studentPhotoData.value = photo;

  if (photo) {
    els.studentPhotoImg.src = photo;
    els.studentPhotoImg.hidden = false;
    els.studentPhotoInitials.hidden = true;
    els.btnClearPhoto.hidden = false;
  } else {
    els.studentPhotoImg.removeAttribute('src');
    els.studentPhotoImg.hidden = true;
    els.studentPhotoInitials.hidden = false;
    els.studentPhotoInitials.textContent = initials(name);
    els.btnClearPhoto.hidden = true;
  }
}

async function handlePhotoChange(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  try {
    const image = await loadPhoto(file);
    setPhotoPreview(resizePhoto(image), els.studentName.value);
  } catch (error) {
    event.target.value = '';
    showToast(error.message, 'error');
  }
}

function loadPhoto(file) {
  return new Promise(function (resolve, reject) {
    if (!file.type || file.type.indexOf('image/') !== 0) {
      reject(new Error('ไฟล์ที่เลือกไม่ใช่รูปภาพ'));
      return;
    }
    if (file.size > PHOTO_MAX_BYTES) {
      reject(new Error('รูปภาพมีขนาดใหญ่เกิน 8 MB'));
      return;
    }

    const reader = new FileReader();
    reader.onerror = function () {
      reject(new Error('อ่านไฟล์รูปภาพไม่สำเร็จ'));
    };
    reader.onload = function () {
      const image = new Image();
      image.onerror = function () {
        reject(new Error('เปิดรูปภาพไม่สำเร็จ ลองใช้ไฟล์อื่น'));
      };
      image.onload = function () {
        resolve(image);
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function resizePhoto(image) {
  const canvas = document.createElement('canvas');
  canvas.width = PHOTO_SIZE;
  canvas.height = PHOTO_SIZE;

  const context = canvas.getContext('2d');
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const side = Math.min(width, height);

  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, PHOTO_SIZE, PHOTO_SIZE);
  context.drawImage(
    image,
    (width - side) / 2,
    (height - side) / 2,
    side,
    side,
    0,
    0,
    PHOTO_SIZE,
    PHOTO_SIZE
  );

  return canvas.toDataURL('image/jpeg', 0.82);
}

/* ---------- โหมดทดลอง (เก็บข้อมูลในเบราว์เซอร์) ------------------------- */

const LocalBackend = {
  read() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.students) && Array.isArray(parsed.transactions)) {
          return parsed;
        }
      }
    } catch (error) {
      console.warn('อ่านข้อมูลในเบราว์เซอร์ไม่สำเร็จ', error);
    }
    return { students: [], transactions: [] };
  },

  write(data) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  },

  async handle(action, payload) {
    const data = this.read();

    switch (action) {
      case 'list':
        return { students: data.students, transactions: data.transactions };

      case 'addStudent': {
        const name = String(payload.name || '').trim();
        if (!name) throw new Error('กรุณากรอกชื่อนักเรียน');
        const now = new Date().toISOString();
        const student = {
          id: nextId(data.students),
          name: name,
          room: String(payload.room || '').trim(),
          photo: String(payload.photo || ''),
          balance: 0,
          createdAt: now,
          updatedAt: now,
        };
        data.students.push(student);
        this.write(data);
        return { student: student };
      }

      case 'updateStudent': {
        const student = findStudent(data, payload.id);
        const name = String(payload.name || '').trim();
        if (!name) throw new Error('กรุณากรอกชื่อนักเรียน');
        student.name = name;
        student.room = String(payload.room || '').trim();
        if (payload.photo !== undefined) student.photo = String(payload.photo || '');
        student.updatedAt = new Date().toISOString();
        data.transactions.forEach(function (tx) {
          if (String(tx.studentId) === String(student.id)) tx.studentName = name;
        });
        this.write(data);
        return { student: student };
      }

      case 'deleteStudent': {
        const student = findStudent(data, payload.id);
        data.students = data.students.filter(function (item) {
          return String(item.id) !== String(student.id);
        });
        data.transactions = data.transactions.filter(function (tx) {
          return String(tx.studentId) !== String(student.id);
        });
        this.write(data);
        return { id: student.id };
      }

      case 'transaction': {
        const student = findStudent(data, payload.studentId);
        const type = payload.type;
        const amount = Math.round((Number(payload.amount) || 0) * 100) / 100;
        if (type !== 'deposit' && type !== 'withdraw') throw new Error('ประเภทการทำรายการไม่ถูกต้อง');
        if (!(amount > 0)) throw new Error('จำนวนเงินต้องมากกว่า 0');
        const balance = type === 'deposit' ? student.balance + amount : student.balance - amount;
        student.balance = Math.round(balance * 100) / 100;
        student.updatedAt = new Date().toISOString();
        const transaction = {
          id: nextId(data.transactions),
          studentId: student.id,
          studentName: student.name,
          type: type,
          amount: amount,
          note: String(payload.note || '').trim(),
          balanceAfter: student.balance,
          createdAt: student.updatedAt,
        };
        data.transactions.push(transaction);
        this.write(data);
        return { student: student, transaction: transaction };
      }

      default:
        throw new Error('ไม่รู้จักคำสั่ง: ' + action);
    }
  },
};

function nextId(rows) {
  return rows.reduce(function (max, row) {
    return Math.max(max, Number(row.id) || 0);
  }, 0) + 1;
}

function findStudent(data, id) {
  const student = data.students.find(function (item) {
    return String(item.id) === String(id);
  });
  if (!student) throw new Error('ไม่พบนักเรียนคนนี้');
  return student;
}

/* ---------- เรียก API ---------------------------------------------------- */

async function callApi(action, payload) {
  const body = payload || {};

  if (!CONFIG.API_URL) {
    return LocalBackend.handle(action, body);
  }

  let response;
  try {
    response = await fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: action, payload: body }),
      redirect: 'follow',
    });
  } catch (error) {
    throw new Error('เชื่อมต่อ Google Sheet ไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตหรือ URL ของ Apps Script');
  }

  if (!response.ok) {
    throw new Error('เซิร์ฟเวอร์ตอบกลับผิดพลาด (' + response.status + ')');
  }

  let result;
  try {
    result = await response.json();
  } catch (error) {
    throw new Error('รูปแบบข้อมูลที่ได้จากเซิร์ฟเวอร์ไม่ถูกต้อง');
  }

  if (!result || !result.ok) {
    throw new Error((result && result.error) || 'เกิดข้อผิดพลาดจากเซิร์ฟเวอร์');
  }

  return result.data;
}

/* ---------- เริ่มต้นระบบ ------------------------------------------------- */

document.addEventListener('DOMContentLoaded', init);

function init() {
  cacheElements();
  bindEvents();
  updateModeBadge();
  refresh();
}

function cacheElements() {
  const ids = [
    'modeBadge',
    'statStudents',
    'statBalance',
    'statDepositToday',
    'statWithdrawToday',
    'studentsCount',
    'studentSearch',
    'btnAddStudent',
    'studentsTableBody',
    'historyCount',
    'historySearch',
    'historyType',
    'historyTableBody',
    'studentDialog',
    'studentForm',
    'studentDialogTitle',
    'studentId',
    'studentPhoto',
    'studentPhotoData',
    'studentPhotoImg',
    'studentPhotoInitials',
    'studentPhotoPreview',
    'btnChoosePhoto',
    'btnClearPhoto',
    'studentName',
    'studentRoom',
    'txDialog',
    'txForm',
    'txDialogTitle',
    'txStudentName',
    'txBalance',
    'txTypeBadge',
    'txStudentId',
    'txType',
    'txAmount',
    'txNote',
    'txSubmit',
    'confirmDialog',
    'confirmMessage',
    'toasts',
  ];

  ids.forEach(function (id) {
    els[id] = document.getElementById(id);
  });
}

function bindEvents() {
  els.btnAddStudent.addEventListener('click', function () {
    openStudentDialog(null);
  });

  els.studentSearch.addEventListener('input', function (event) {
    state.search = event.target.value;
    renderStudents();
  });

  els.studentsTableBody.addEventListener('click', handleStudentTableClick);

  els.studentForm.addEventListener('submit', handleStudentSubmit);

  els.btnChoosePhoto.addEventListener('click', function () {
    els.studentPhoto.click();
  });

  els.studentPhoto.addEventListener('change', handlePhotoChange);

  els.btnClearPhoto.addEventListener('click', function () {
    els.studentPhoto.value = '';
    setPhotoPreview('', els.studentName.value);
  });

  els.studentName.addEventListener('input', function () {
    if (!els.studentPhotoData.value) {
      els.studentPhotoInitials.textContent = initials(els.studentName.value);
    }
  });

  els.historySearch.addEventListener('input', function (event) {
    state.historySearch = event.target.value;
    renderHistory();
  });

  els.historyType.addEventListener('change', function (event) {
    state.historyType = event.target.value;
    renderHistory();
  });

  els.txForm.addEventListener('submit', handleTransactionSubmit);

  document.querySelectorAll('[data-close]').forEach(function (button) {
    button.addEventListener('click', function () {
      const dialog = button.closest('dialog');
      if (dialog) dialog.close();
    });
  });
}

function updateModeBadge() {
  if (CONFIG.API_URL) {
    els.modeBadge.textContent = 'เชื่อมต่อ Google Sheet';
    els.modeBadge.className = 'badge badge--live';
    els.modeBadge.removeAttribute('title');
  } else {
    els.modeBadge.textContent = 'โหมดทดลอง (บันทึกในเครื่อง)';
    els.modeBadge.className = 'badge badge--demo';
    els.modeBadge.title = 'ยังไม่ได้ตั้งค่า CONFIG.API_URL ใน js/app.js ข้อมูลจะถูกเก็บในเบราว์เซอร์นี้เท่านั้น';
  }
}

/* ---------- โหลด / แสดงผล ----------------------------------------------- */

async function refresh() {
  try {
    const data = await callApi('list');
    state.students = (data && data.students) || [];
    state.transactions = (data && data.transactions) || [];
    render();
  } catch (error) {
    showToast(error.message, 'error');
    els.studentsCount.textContent = 'โหลดข้อมูลไม่สำเร็จ';
    els.historyCount.textContent = 'โหลดข้อมูลไม่สำเร็จ';
    els.studentsTableBody.innerHTML =
      '<tr class="empty-row"><td colspan="4">ไม่สามารถโหลดรายชื่อนักเรียนได้</td></tr>';
    els.historyTableBody.innerHTML =
      '<tr class="empty-row"><td colspan="6">ไม่สามารถโหลดประวัติการทำรายการได้</td></tr>';
  }
}

function render() {
  renderStats();
  renderStudents();
  renderHistory();
}

function renderStats() {
  const totalBalance = state.students.reduce(function (sum, student) {
    return sum + (Number(student.balance) || 0);
  }, 0);

  const today = dayKey(new Date());
  let depositToday = 0;
  let withdrawToday = 0;

  state.transactions.forEach(function (tx) {
    if (dayKey(tx.createdAt) !== today) return;
    if (tx.type === 'deposit') depositToday += Number(tx.amount) || 0;
    else withdrawToday += Number(tx.amount) || 0;
  });

  els.statStudents.textContent = String(state.students.length);
  els.statBalance.textContent = formatMoney(totalBalance);
  els.statDepositToday.textContent = formatMoney(depositToday);
  els.statWithdrawToday.textContent = formatMoney(withdrawToday);
}

function renderStudents() {
  const keyword = state.search.trim().toLowerCase();
  const filtered = state.students.filter(function (student) {
    if (!keyword) return true;
    const name = String(student.name || '').toLowerCase();
    const room = String(student.room || '').toLowerCase();
    return name.indexOf(keyword) !== -1 || room.indexOf(keyword) !== -1;
  });

  els.studentsCount.textContent = keyword
    ? 'พบ ' + filtered.length + ' จาก ' + state.students.length + ' คน'
    : 'ทั้งหมด ' + state.students.length + ' คน';

  if (!filtered.length) {
    const message = state.students.length
      ? 'ไม่พบนักเรียนที่ค้นหา'
      : 'ยังไม่มีรายชื่อนักเรียน กดปุ่ม “เพิ่มนักเรียน” เพื่อเริ่มต้น';
    els.studentsTableBody.innerHTML =
      '<tr class="empty-row"><td colspan="4">' + escapeHtml(message) + '</td></tr>';
    return;
  }

  els.studentsTableBody.innerHTML = filtered
    .map(function (student) {
      const id = escapeHtml(student.id);
      return (
        '<tr>' +
        '<td><div class="student-name">' +
        avatarMarkup(student) +
        '<span>' + escapeHtml(student.name) + '</span>' +
        '</div></td>' +
        '<td>' + (student.room ? escapeHtml(student.room) : '<span class="muted">—</span>') + '</td>' +
        '<td class="amount">' + formatMoney(student.balance) + '</td>' +
        '<td><div class="row-actions">' +
        '<button type="button" class="btn btn--sm btn--success" data-action="deposit" data-id="' + id + '">ฝาก</button>' +
        '<button type="button" class="btn btn--sm btn--danger-soft" data-action="withdraw" data-id="' + id + '">ถอน</button>' +
        '<button type="button" class="btn btn--sm btn--ghost" data-action="edit" data-id="' + id + '">แก้ไข</button>' +
        '<button type="button" class="btn btn--sm btn--ghost-danger" data-action="delete" data-id="' + id + '">ลบ</button>' +
        '</div></td>' +
        '</tr>'
      );
    })
    .join('');
}

function renderHistory() {
  const keyword = state.historySearch.trim().toLowerCase();
  const type = state.historyType;

  const all = state.transactions.slice().sort(function (a, b) {
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  const filtered = all.filter(function (tx) {
    if (type !== 'all' && tx.type !== type) return false;
    if (!keyword) return true;
    const name = String(tx.studentName || '').toLowerCase();
    const note = String(tx.note || '').toLowerCase();
    return name.indexOf(keyword) !== -1 || note.indexOf(keyword) !== -1;
  });

  els.historyCount.textContent = 'แสดง ' + filtered.length + ' จาก ' + all.length + ' รายการ';

  if (!filtered.length) {
    const message = all.length
      ? 'ไม่พบรายการที่ค้นหา'
      : 'ยังไม่มีประวัติการทำรายการ';
    els.historyTableBody.innerHTML =
      '<tr class="empty-row"><td colspan="6">' + escapeHtml(message) + '</td></tr>';
    return;
  }

  els.historyTableBody.innerHTML = filtered
    .map(function (tx) {
      const isDeposit = tx.type === 'deposit';
      return (
        '<tr>' +
        '<td class="nowrap">' + escapeHtml(formatDate(tx.createdAt)) + '</td>' +
        '<td>' + escapeHtml(tx.studentName || '-') + '</td>' +
        '<td><span class="badge ' + (isDeposit ? 'badge--success' : 'badge--danger') + '">' +
        (isDeposit ? 'ฝาก' : 'ถอน') + '</span></td>' +
        '<td class="amount ' + (isDeposit ? 'amount--in' : 'amount--out') + '">' +
        (isDeposit ? '+' : '−') + formatMoney(tx.amount) + '</td>' +
        '<td class="amount">' + formatMoney(tx.balanceAfter) + '</td>' +
        '<td class="note">' + (tx.note ? escapeHtml(tx.note) : '<span class="muted">—</span>') + '</td>' +
        '</tr>'
      );
    })
    .join('');
}

/* ---------- จัดการนักเรียน ---------------------------------------------- */

function handleStudentTableClick(event) {
  const button = event.target.closest('button[data-action]');
  if (!button) return;

  const student = state.students.find(function (item) {
    return String(item.id) === button.dataset.id;
  });
  if (!student) return;

  switch (button.dataset.action) {
    case 'deposit':
      openTransactionDialog(student, 'deposit');
      break;
    case 'withdraw':
      openTransactionDialog(student, 'withdraw');
      break;
    case 'edit':
      openStudentDialog(student);
      break;
    case 'delete':
      handleDeleteStudent(student);
      break;
  }
}

function openStudentDialog(student) {
  els.studentDialogTitle.textContent = student ? 'แก้ไขข้อมูลนักเรียน' : 'เพิ่มนักเรียนใหม่';
  els.studentId.value = student ? student.id : '';
  els.studentName.value = student ? student.name : '';
  els.studentRoom.value = student ? student.room || '' : '';
  els.studentPhoto.value = '';
  setPhotoPreview(student ? student.photo : '', student ? student.name : '');
  openDialog(els.studentDialog);
  els.studentName.focus();
  els.studentName.select();
}

async function handleStudentSubmit(event) {
  event.preventDefault();

  const id = els.studentId.value;
  const name = els.studentName.value.trim();
  const room = els.studentRoom.value.trim();

  if (!name) {
    showToast('กรุณากรอกชื่อนักเรียน', 'error');
    els.studentName.focus();
    return;
  }

  const payload = { name: name, room: room, photo: els.studentPhotoData.value };
  const action = id ? 'updateStudent' : 'addStudent';
  if (id) payload.id = id;

  const message = id ? 'บันทึกการแก้ไขชื่อนักเรียนแล้ว' : 'เพิ่มนักเรียนใหม่แล้ว';
  const success = await submitAction(els.studentForm, action, payload, message);
  if (success) els.studentDialog.close();
}

async function handleDeleteStudent(student) {
  const confirmed = await confirmDialog(
    'ต้องการลบ “' + student.name + '” ใช่หรือไม่?\n' +
      'ประวัติฝาก-ถอนทั้งหมดของนักเรียนคนนี้จะถูกลบไปด้วย และไม่สามารถกู้คืนได้'
  );
  if (!confirmed) return;

  try {
    await callApi('deleteStudent', { id: student.id });
    await refresh();
    showToast('ลบรายชื่อนักเรียนแล้ว', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

/* ---------- ฝาก / ถอน ---------------------------------------------------- */

function openTransactionDialog(student, type) {
  const isDeposit = type === 'deposit';

  els.txDialogTitle.textContent = isDeposit ? 'รับฝากเงิน' : 'ถอนเงิน';
  els.txStudentId.value = student.id;
  els.txType.value = type;
  els.txStudentName.textContent =
    student.name + (student.room ? ' (' + student.room + ')' : '');
  els.txBalance.textContent = formatMoney(student.balance) + ' บาท';
  els.txTypeBadge.textContent = isDeposit ? 'ฝาก' : 'ถอน';
  els.txTypeBadge.className = 'badge ' + (isDeposit ? 'badge--success' : 'badge--danger');
  els.txSubmit.textContent = isDeposit ? 'ยืนยันการฝาก' : 'ยืนยันการถอน';
  els.txSubmit.className = 'btn ' + (isDeposit ? 'btn--success' : 'btn--danger');
  els.txAmount.value = '';
  els.txNote.value = '';

  openDialog(els.txDialog);
  els.txAmount.focus();
}

async function handleTransactionSubmit(event) {
  event.preventDefault();

  const type = els.txType.value;
  const amount = Number(els.txAmount.value);
  const isDeposit = type === 'deposit';

  if (!Number.isFinite(amount) || amount <= 0) {
    showToast('กรุณากรอกจำนวนเงินให้มากกว่า 0', 'error');
    els.txAmount.focus();
    return;
  }

  const success = await submitAction(
    els.txForm,
    'transaction',
    {
      studentId: els.txStudentId.value,
      type: type,
      amount: amount,
      note: els.txNote.value.trim(),
    },
    isDeposit ? 'บันทึกการฝากเงินแล้ว' : 'บันทึกการถอนเงินแล้ว'
  );

  if (success) els.txDialog.close();
}

/* ---------- ตัวช่วยฟอร์ม / ไดอะล็อก ------------------------------------- */

async function submitAction(form, action, payload, successMessage) {
  const button = form.querySelector('button[type="submit"]');
  if (button) button.disabled = true;

  try {
    await callApi(action, payload);
    await refresh();
    showToast(successMessage, 'success');
    return true;
  } catch (error) {
    showToast(error.message, 'error');
    return false;
  } finally {
    if (button) button.disabled = false;
  }
}

function openDialog(dialog) {
  if (!dialog || dialog.open) return;
  dialog.showModal();
}

function confirmDialog(message) {
  return new Promise(function (resolve) {
    els.confirmMessage.textContent = message;
    els.confirmDialog.returnValue = 'cancel';

    function onClose() {
      els.confirmDialog.removeEventListener('close', onClose);
      resolve(els.confirmDialog.returnValue === 'confirm');
    }

    els.confirmDialog.addEventListener('close', onClose);
    openDialog(els.confirmDialog);
  });
}

function showToast(message, type) {
  const toast = document.createElement('div');
  toast.className = 'toast toast--' + (type || 'info');
  toast.textContent = message;
  els.toasts.appendChild(toast);

  requestAnimationFrame(function () {
    toast.classList.add('is-visible');
  });

  setTimeout(function () {
    toast.classList.remove('is-visible');
    setTimeout(function () {
      toast.remove();
    }, 250);
  }, 3400);
}
