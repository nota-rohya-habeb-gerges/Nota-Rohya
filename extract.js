// ============================================================================
// Extract: weekly progress as an Excel file.
//  - Everyone: "Extract" button -> preview + download for the account on screen.
//  - Khadem: from "بيانات المخدومين", download one makhdoum's file, or one file with
//    every makhdoum.
//
// Layout (same idea as the reference sheet): one sheet per service year (Sep -> Aug),
// one row per week (Friday date), one column per Nota Rohya task = how many days
// (0-7) it was done, a notes column, then total / total counted / progress % rows.
// ============================================================================

let extractYears = [];   // years of the account currently shown in the preview

const SERVICE_YEAR_FIRST_MONTH = 8;   // September (0-based)
const MAX_PER_WEEK = 7;

function parseWeekStart(weekId) {
    // weekId looks like "week_2026-10-16"
    const m = /^week_(\d{4})-(\d{2})-(\d{2})$/.exec(weekId);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function countChecks(rowValue) {
    if (rowValue == null) return 0;
    let n = 0;
    for (let i = 0; i < MAX_PER_WEEK; i++) {
        if (rowValue[i] === '1' || rowValue[i] === 1) n++;
    }
    return n;
}

// Service year runs September -> August and is named after the year it starts in
function serviceYearOf(date) {
    return date.getMonth() >= SERVICE_YEAR_FIRST_MONTH ? date.getFullYear() : date.getFullYear() - 1;
}

function fmtDate(d) {
    return `${d.getDate()}-${MONTH_NAMES[d.getMonth()].slice(0, 3)}-${d.getFullYear()}`;
}

function weekNotes(doc) {
    const notes = doc.otherPracticeNotes || {};
    return DAY_LABELS_AR
        .map(day => String(notes[day] || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join(' + ');
}

// Pure: turns saved week docs [{ start: Date, matrix, otherPracticeNotes }] into
// [{ year, rows: [{ start, counts: [12 numbers], notes }] }]
// Rows run from the first week with any tick up to the current week (empty weeks = 0),
// so "progress %" is honest.
function buildYears(weekDocs, currentWeekStart) {
    const byKey = new Map();
    let first = null, last = null;

    weekDocs.forEach(w => {
        const counts = TASKS.map((_, i) => countChecks((w.matrix || [])[i]));
        const notes = weekNotes(w);
        byKey.set(w.start.getTime(), { counts, notes });
        if (counts.some(n => n > 0)) {
            if (!first || w.start < first) first = w.start;
            if (!last || w.start > last) last = w.start;
        }
    });
    if (!first) return [];
    if (currentWeekStart && currentWeekStart > last) last = currentWeekStart;

    const years = new Map();
    for (let d = new Date(first); d <= last; d = addDays(d, 7)) {
        const saved = byKey.get(d.getTime());
        const row = {
            start: new Date(d),
            counts: saved ? saved.counts : TASKS.map(() => 0),
            notes: saved ? saved.notes : ''
        };
        const y = serviceYearOf(d);
        if (!years.has(y)) years.set(y, []);
        years.get(y).push(row);
    }
    return [...years.entries()].sort((a, b) => a[0] - b[0]).map(([year, rows]) => ({ year, rows }));
}

// Pure: totals under a year's table
function summarize(rows) {
    const totals = TASKS.map((_, i) => rows.reduce((s, r) => s + r.counts[i], 0));
    const counted = rows.length * MAX_PER_WEEK;
    const progress = totals.map(t => (counted ? (t / counted) * 100 : 0));
    return { totals, counted, progress };
}

async function fetchExtractData(uid) {
    const snap = await db.collection('users').doc(uid).collection('weeks').get();
    const weekDocs = [];
    snap.forEach(doc => {
        const start = parseWeekStart(doc.id);
        if (!start) return;
        const data = doc.data();
        weekDocs.push({ start, matrix: data.matrix || [], otherPracticeNotes: data.otherPracticeNotes || {} });
    });
    return buildYears(weekDocs, getCurrentWeek().start);
}

// ---- Preview modal (account currently on screen) -----------------------------
async function openExtractModal() {
    if (!viewingUid) return;

    const body = document.getElementById('extract-body');
    const saveBtn = document.getElementById('extract-download-btn');
    saveBtn.style.display = 'none';
    body.innerHTML = '<p style="color:#795757; text-align:center;">جارِ التحميل...</p>';
    openModal('extract-modal');

    try {
        extractYears = await fetchExtractData(viewingUid);

        if (extractYears.length === 0) {
            body.innerHTML = '<p style="color:#795757; text-align:center;">لا توجد بيانات محفوظة بعد.</p>';
            return;
        }

        extractMode = 'month';
        extractKey = null;
        renderExtractView(body);
        saveBtn.style.display = '';
    } catch (err) {
        console.error('تعذر تحميل بيانات التقرير', err);
        body.innerHTML = '<p style="color:#795757; text-align:center;">تعذر تحميل البيانات. تأكد من اتصالك بالإنترنت وحاول مرة أخرى.</p>';
    }
}

let extractMode = 'month';   // 'month' | 'year'
let extractKey = null;       // selected month key ("2026-10") or service year ("2026")

// Every month that has at least one week (a week belongs to the month of its Friday)
function extractMonths() {
    const map = new Map();
    extractYears.forEach(({ rows }) => rows.forEach(r => {
        const key = `${r.start.getFullYear()}-${String(r.start.getMonth() + 1).padStart(2, '0')}`;
        if (!map.has(key)) map.set(key, { key, label: `${MONTH_NAMES[r.start.getMonth()]} ${r.start.getFullYear()}`, rows: [] });
        map.get(key).rows.push(r);
    }));
    return [...map.values()].sort((a, b) => b.key.localeCompare(a.key));
}

// What the user picked: { name (sheet), file, rows }
function currentExtractSelection() {
    if (extractMode === 'month') {
        const months = extractMonths();
        const m = months.find(x => x.key === extractKey) || months[0];
        return m ? { name: m.label, file: `nota-rohya-${m.key}.xlsx`, rows: m.rows, heading: m.label, key: m.key } : null;
    }
    const years = [...extractYears].reverse();
    const y = years.find(x => String(x.year) === extractKey) || years[0];
    return y ? { name: `${y.year}-${y.year + 1}`, file: `nota-rohya-${y.year}-${y.year + 1}.xlsx`, rows: y.rows, heading: `${y.year} - ${y.year + 1}`, key: String(y.year) } : null;
}

function renderExtractView(container) {
    container.innerHTML = '';

    // 1) choose: month or whole year
    const modes = document.createElement('div');
    modes.className = 'extract-modes';
    [['month', 'الشهر'], ['year', 'السنة كاملة']].forEach(([mode, text]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'extract-mode-btn' + (extractMode === mode ? ' active' : '');
        b.innerText = text;
        b.addEventListener('click', () => {
            if (extractMode === mode) return;
            extractMode = mode;
            extractKey = null;
            renderExtractView(container);
        });
        modes.appendChild(b);
    });
    container.appendChild(modes);

    // 2) choose which month / which year
    const sel = currentExtractSelection();
    const select = document.createElement('select');
    select.className = 'extract-select';
    select.dir = 'ltr';
    if (extractMode === 'month') {
        extractMonths().forEach(m => select.add(new Option(m.label, m.key)));
    } else {
        [...extractYears].reverse().forEach(y => select.add(new Option(`${y.year} - ${y.year + 1}`, String(y.year))));
    }
    select.value = sel.key;
    select.addEventListener('change', () => { extractKey = select.value; renderExtractView(container); });
    container.appendChild(select);

    // 3) preview of the chosen period
    renderExtractTable(container, sel);
}

function renderExtractTable(container, sel) {
    const title = document.createElement('h4');
    title.innerText = sel.heading;
    title.dir = 'ltr';   // keeps "2026 - 2027" in the right order inside the RTL page
    title.style.cssText = 'color:#795757; margin:10px 0 2px; text-align:center;';
    container.appendChild(title);

    const rows = sel.rows;
    const wrap = document.createElement('div');
    wrap.className = 'extract-scroll';
    const table = document.createElement('table');
    table.className = 'extract-table';

    const head = document.createElement('tr');
    ['التاريخ', ...TASKS.map(t => `${t} (${MAX_PER_WEEK})`), 'ملاحظات'].forEach(text => {
        const th = document.createElement('th');
        th.innerText = text;
        head.appendChild(th);
    });
    table.appendChild(head);

    rows.forEach(r => {
        const tr = document.createElement('tr');
        [fmtDate(r.start), ...r.counts, r.notes].forEach((v, i) => {
            const td = document.createElement('td');
            td.innerText = v;
            if (i === 0) td.className = 'extract-week-cell';
            tr.appendChild(td);
        });
        table.appendChild(tr);
    });

    const { totals, counted, progress } = summarize(rows);
    [
        ['total', totals],
        ['total counted', totals.map(() => counted)],
        ['progress %', progress.map(p => p.toFixed(1))]
    ].forEach(([label, values]) => {
        const tr = document.createElement('tr');
        tr.className = 'extract-total-row';
        [label, ...values, ''].forEach((v, i) => {
            const td = document.createElement('td');
            td.innerText = v;
            if (i === 0) td.className = 'extract-week-cell';
            tr.appendChild(td);
        });
        table.appendChild(tr);
    });

    wrap.appendChild(table);
    container.appendChild(wrap);
}

// ---- Excel building (ExcelJS) --------------------------------------------------
const XL_FONT = 'Arial';
const XL_THIN = { style: 'thin', color: { argb: 'FF000000' } };
const XL_BORDER = { top: XL_THIN, left: XL_THIN, bottom: XL_THIN, right: XL_THIN };
const XL_GRAY_LABEL = 'FFCCCCCC';
const XL_GRAY_PROGRESS = 'FFD9D9D9';

function colLetter(n) {            // 1 -> A, 2 -> B ...
    let s = '';
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
}

function styleCell(cell, { bold = false, size = 10, fill = null, align = 'center', wrap = false } = {}) {
    cell.font = { name: XL_FONT, size, bold };
    cell.alignment = { horizontal: align, vertical: 'middle', wrapText: wrap };
    cell.border = XL_BORDER;
    if (fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
}

// Adds one worksheet (one service year) to an ExcelJS workbook
function addYearSheet(wb, sheetName, rows) {
    const ws = wb.addWorksheet(sheetName, {
        views: [{ rightToLeft: true, state: 'frozen', xSplit: 1, ySplit: 1 }]
    });
    const taskCols = TASKS.length;             // B .. (B + taskCols - 1)
    const notesCol = taskCols + 2;
    ws.getColumn(1).width = 15;
    for (let c = 2; c < notesCol; c++) ws.getColumn(c).width = 13;
    ws.getColumn(notesCol).width = 30;

    // Header
    const header = ws.getRow(1);
    header.height = 48;
    const heads = ['التاريخ', ...TASKS.map(t => `${t}\n (${MAX_PER_WEEK})`), 'ملاحظات'];
    heads.forEach((text, i) => {
        const cell = header.getCell(i + 1);
        cell.value = text;
        styleCell(cell, { bold: true, size: i === 0 ? 14 : 11, wrap: true });
    });

    // Weekly rows
    rows.forEach((r, idx) => {
        const row = ws.getRow(idx + 2);
        row.height = 21;
        const d = new Date(Date.UTC(r.start.getFullYear(), r.start.getMonth(), r.start.getDate()));
        const dateCell = row.getCell(1);
        dateCell.value = d;
        dateCell.numFmt = 'd-mmm-yyyy';
        styleCell(dateCell);
        r.counts.forEach((n, i) => {
            const cell = row.getCell(i + 2);
            cell.value = n;
            styleCell(cell);
        });
        const notesCell = row.getCell(notesCol);
        notesCell.value = r.notes || null;
        styleCell(notesCell, { wrap: true });
    });

    // Summary rows: total / total counted / progress %
    const firstRow = 2, lastRow = rows.length + 1;
    const { totals, counted, progress } = summarize(rows);
    const totalRow = lastRow + 1, countedRow = lastRow + 2, progressRow = lastRow + 3;

    [[totalRow, 'total'], [countedRow, 'total counted'], [progressRow, 'progress %']].forEach(([rIdx, label]) => {
        const row = ws.getRow(rIdx);
        row.height = 21;
        const lc = row.getCell(1);
        lc.value = label;
        styleCell(lc, { fill: XL_GRAY_LABEL });
    });

    for (let i = 0; i < taskCols; i++) {
        const L = colLetter(i + 2);
        const rng = `${L}${firstRow}:${L}${lastRow}`;

        const t = ws.getCell(totalRow, i + 2);
        t.value = { formula: `SUM(${rng})`, result: totals[i] };
        styleCell(t);

        const c = ws.getCell(countedRow, i + 2);
        c.value = { formula: `COUNT(${rng})*${MAX_PER_WEEK}`, result: counted };
        styleCell(c);

        const p = ws.getCell(progressRow, i + 2);
        p.value = { formula: `IFERROR(${L}${totalRow}/${L}${countedRow}*100,0)`, result: progress[i] };
        p.numFmt = '0.0';
        styleCell(p, { fill: XL_GRAY_PROGRESS });
    }
    // keep the notes column tidy under the summary rows
    [totalRow, countedRow].forEach(r => styleCell(ws.getCell(r, notesCol)));
    styleCell(ws.getCell(progressRow, notesCol), { fill: XL_GRAY_PROGRESS });

    return ws;
}

// Excel sheet names: max 31 chars, none of  \ / ? * [ ] :  and must be unique
function safeSheetName(name, used) {
    const base = (name || 'Sheet').replace(/[\\\/?*\[\]:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 28) || 'Sheet';
    let n = base, i = 2;
    while (used.has(n.toLowerCase())) n = `${base.slice(0, 26)} ${i++}`;
    used.add(n.toLowerCase());
    return n;
}

function safeFileName(name) {
    return (name || 'nota-rohya').replace(/[\\\/:*?"<>|]/g, ' ').trim();
}

function excelLibReady() {
    if (typeof ExcelJS === 'undefined') {
        alert('تعذر تحميل مكتبة الإكسل. تأكد من اتصالك بالإنترنت وحاول مرة أخرى.');
        return false;
    }
    return true;
}

function newWorkbook() {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Nota Rohya';
    return wb;
}

async function saveWorkbook(wb, fileName) {
    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function downloadExtractExcel() {
    if (!excelLibReady() || extractYears.length === 0) return;
    const sel = currentExtractSelection();
    if (!sel) return;
    const wb = newWorkbook();
    addYearSheet(wb, sel.name, sel.rows);
    await saveWorkbook(wb, sel.file);
}

// ---- Khadem: one makhdoum / all makhdoum --------------------------------------
async function exportMakhdoumExcel(person, btn) {
    if (!currentUserProfile || currentUserProfile.role !== 'khadem') return;
    if (!excelLibReady()) return;

    const label = btn.innerText;
    btn.disabled = true;
    btn.innerText = '...';
    try {
        const years = await fetchExtractData(person.uid);
        if (years.length === 0) {
            alert('لا توجد بيانات محفوظة لهذا المخدوم بعد.');
            return;
        }
        const name = person.name || person.email || 'makhdoum';
        const wb = newWorkbook();
        years.forEach(({ year, rows }) => addYearSheet(wb, String(year), rows));
        await saveWorkbook(wb, `nota-rohya-${safeFileName(name)}.xlsx`);
    } catch (err) {
        console.error('تعذر تصدير بيانات المخدوم', err);
        alert('تعذر التحميل، حاول مرة أخرى.\n\n(رمز الخطأ: ' + (err.code || err.message) + ')');
    } finally {
        btn.disabled = false;
        btn.innerText = label;
    }
}

async function exportAllMakhdoumExcel(list, btn) {
    if (!currentUserProfile || currentUserProfile.role !== 'khadem') return;
    if (!excelLibReady()) return;

    const label = btn.innerText;
    btn.disabled = true;
    btn.innerText = 'جارِ التحضير...';
    try {
        const wb = newWorkbook();
        const used = new Set();
        let sheets = 0;
        for (const person of list) {
            const years = await fetchExtractData(person.uid);
            const name = person.name || person.email || 'makhdoum';
            years.forEach(({ year, rows }) => {
                // one sheet per person per service year; the year is kept at the end of the name
                const sheetName = safeSheetName(`${name.slice(0, 22)} ${year}`, used);
                addYearSheet(wb, sheetName, rows);
                sheets++;
            });
        }
        if (sheets === 0) {
            alert('لا توجد بيانات محفوظة للمخدومين بعد.');
            return;
        }
        await saveWorkbook(wb, 'nota-rohya-all-makhdoumin.xlsx');
    } catch (err) {
        console.error('تعذر تصدير بيانات المخدومين', err);
        alert('تعذر التحميل، حاول مرة أخرى.\n\n(رمز الخطأ: ' + (err.code || err.message) + ')');
    } finally {
        btn.disabled = false;
        btn.innerText = label;
    }
}
