if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js');
  });
}

let chart;
let currentWeekKey = null;    // e.g. "week_2026-01-02"
let currentWeekLabel = "";    // e.g. "18 Sept - 24 Sept 2026"
let calendarYear = new Date().getFullYear();

// Whose data is currently displayed, and whether it's read-only.
// Normally viewingUid === currentUser.uid. When الخادم opens a مخدوم's
// data from the admin dashboard, these switch to that person's uid.
let viewingUid = null;
let viewingReadOnly = false;

const DAY_LABELS = ["Fri", "Sat", "Sun", "Mon", "Tue", "Wed", "Thu"];
const DAY_LABELS_AR = ["الجمعة", "السبت", "الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس"];
// Order MUST match the rows in the table (top to bottom)
const TASKS = [
    "باكر",
    "غروب",
    "نوم",
    "قداس",
    "قراءة الكتاب المقدس",
    "صوم",
    "الاعتراف",
    "تحضير درس الاسبوع",
    "قراءة من كتاب خارجي",
    "ممارسة روحية أخرى",
    "حضور الاجتماع",
    "حضور الخدمة"
];
const MONTH_NAMES = ["January","February","March","April","May","June","July",
                      "August","September","October","November","December"];

function pad(n) { return n.toString().padStart(2, '0'); }
function toISO(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }

// ---- Real week calculation -------------------------------------------------
// Builds every Friday-to-Thursday week that overlaps the given year.
function getWeeksForYear(year) {
    const jan1 = new Date(year, 0, 1);
    const dec31 = new Date(year, 11, 31);

    // JS: Sunday=0 ... Friday=5 ... Saturday=6
    const diffToFriday = (jan1.getDay() - 5 + 7) % 7;
    let weekStart = addDays(jan1, -diffToFriday);

    const weeks = [];
    while (weekStart <= dec31) {
        weeks.push({ start: new Date(weekStart), end: addDays(weekStart, 6) });
        weekStart = addDays(weekStart, 7);
    }
    return weeks;
}

function weekKey(week) {
    return `week_${toISO(week.start)}`;
}

function formatWeekLabel(week) {
    const opts = { day: 'numeric', month: 'short' };
    const s = week.start.toLocaleDateString('en-GB', opts);
    const e = week.end.toLocaleDateString('en-GB', opts);
    return `${s} - ${e} ${week.end.getFullYear()}`;
}

// A week is filed under whichever month owns the majority of its 7 days
function weekOwnerMonth(week) {
    const counts = {};
    for (let i = 0; i < 7; i++) {
        const d = addDays(week.start, i);
        const key = `${d.getFullYear()}-${d.getMonth()}`;
        counts[key] = (counts[key] || 0) + 1;
    }
    let best = null, bestCount = -1;
    for (const key in counts) {
        if (counts[key] > bestCount) { bestCount = counts[key]; best = key; }
    }
    const [y, m] = best.split('-').map(Number);
    return { year: y, month: m };
}

function getCurrentWeek() {
    // Weeks run Friday -> Thursday. Work backwards from today to the most recent Friday.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const daysSinceFriday = (today.getDay() - 5 + 7) % 7; // Fri=0, Sat=1 ... Thu=6
    const start = addDays(today, -daysSinceFriday);
    return { start: start, end: addDays(start, 6) };
}

// ---- Firestore data access ---------------------------------------------------
// users/{uid}                       -> { name, email, role, createdAt }
// users/{uid}/weeks/{weekKey}       -> { matrix, bibleNotes, otherPracticeNotes, updatedAt }
// users/{uid}/confession/record     -> { fatherName, lastDate, notes, updatedAt }
function weekDocRef(uid, wKey) {
    return db.collection('users').doc(uid).collection('weeks').doc(wKey);
}
function confessionDocRef(uid) {
    return db.collection('users').doc(uid).collection('confession').doc('record');
}

async function loadWeekDoc(uid, wKey) {
    try {
        const snap = await weekDocRef(uid, wKey).get();
        return snap.exists ? snap.data() : {};
    } catch (err) {
        console.error('تعذر تحميل بيانات الأسبوع', err);
        return {};
    }
}

async function saveWeekField(field, value) {
    if (viewingReadOnly || !viewingUid || !currentWeekKey) return;
    try {
        await weekDocRef(viewingUid, currentWeekKey).set(
            { [field]: value, updatedAt: firebase.firestore.FieldValue.serverTimestamp() },
            { merge: true }
        );
    } catch (err) {
        console.error(`تعذر حفظ ${field}`, err);
        alert('تعذر الحفظ، تأكد من اتصالك بالإنترنت وحاول مرة أخرى.\n\n(رمز الخطأ: ' + (err.code || err.message) + ')');
    }
}

async function loadConfession(uid) {
    try {
        const snap = await confessionDocRef(uid).get();
        return snap.exists ? snap.data() : {};
    } catch (err) {
        console.error('تعذر تحميل بيانات الاعتراف', err);
        return {};
    }
}

async function saveConfessionDoc(data) {
    if (viewingReadOnly || !viewingUid) return;
    try {
        await confessionDocRef(viewingUid).set(
            { ...data, updatedAt: firebase.firestore.FieldValue.serverTimestamp() },
            { merge: true }
        );
    } catch (err) {
        console.error('تعذر حفظ بيانات الاعتراف', err);
        alert('تعذر الحفظ، تأكد من اتصالك بالإنترنت وحاول مرة أخرى.\n\n(رمز الخطأ: ' + (err.code || err.message) + ')');
    }
}

// ---- Page setup -------------------------------------------------------------
window.addEventListener("DOMContentLoaded", function () {
    document.querySelector('.refresh').addEventListener('click', confirmAndClearCheckboxes);

    document.querySelector('.progress').addEventListener('click', function () {
        const container = document.querySelector('.chart-container');
        if (container.style.display === 'block') {
            container.style.display = 'none';
        } else {
            container.style.display = 'block';
            showChart();
        }
    });

    document.querySelector('.calendar').addEventListener('click', function () {
        const container = document.querySelector('.calendar-container');
        if (container.style.display === 'block') {
            container.style.display = 'none';
        } else {
            container.style.display = 'block';
            calendarYear = currentWeekKey
                ? parseInt(currentWeekKey.split('_')[1].split('-')[0], 10)
                : new Date().getFullYear();
            generateWeeks();
        }
    });

    // Close modals when clicking the dark overlay itself (not the box)
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.style.display = 'none';
        });
    });
});

// Fired by auth.js once we know who's logged in — that's when we can
// actually load data, since everything is now per-account in Firestore.
window.addEventListener('app:ready', function () {
    viewingUid = currentUser.uid;
    viewingReadOnly = false;
    bindTableToWeek(getCurrentWeek());
});

// ---- Table binding ------------------------------------------------------------
async function bindTableToWeek(week) {
    currentWeekKey = weekKey(week);
    currentWeekLabel = formatWeekLabel(week);
    document.getElementById("current-week").innerText = currentWeekLabel;

    const tableContainer = document.querySelector('.table-container');
    let table = tableContainer.querySelector('table');
    if (!table) {
        table = buildDefaultTable();
        tableContainer.appendChild(table);
    }

    const savedDoc = await loadWeekDoc(viewingUid, currentWeekKey);
    const savedMatrix = savedDoc.matrix || [];
    const rows = table.querySelectorAll("tr:not(:first-child)");
    rows.forEach((row, rowIndex) => {
        const checkboxes = row.querySelectorAll("input[type='checkbox']");
        checkboxes.forEach((cb, colIndex) => {
            cb.checked = isSavedChecked(savedMatrix, rowIndex, colIndex);
            cb.disabled = viewingReadOnly;
            cb.onchange = viewingReadOnly ? null : () => {
                saveWeekField('matrix', matrixToFirestore(getMatrixData()));
                if (chart) showChart();
            };
        });
    });

    if (document.querySelector('.chart-container').style.display === 'block') {
        showChart();
    }
}

function buildDefaultTable() {
    const table = document.createElement('table');

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const emptyTh = document.createElement('th');
    emptyTh.innerText = "Days | Tasks";
    headerRow.appendChild(emptyTh);
    DAY_LABELS.forEach(day => {
        const th = document.createElement('th');
        th.innerText = day;
        headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Tasks that open a modal instead of (or in addition to) their checkboxes
    const CLICKABLE_TASKS = {
        "قراءة الكتاب المقدس": { handler: "openBibleNotes()" },
        "الاعتراف": { handler: "openConfessionModal()" },
        "ممارسة روحية أخرى": { handler: "openOtherPracticeNotes()" }
    };

    const tbody = document.createElement('tbody');
    TASKS.forEach(task => {
        const tr = document.createElement('tr');
        const tdTask = document.createElement('td');
        const clickable = CLICKABLE_TASKS[task];
        if (clickable) {
            tdTask.innerHTML = `<b class="task-label" onclick="${clickable.handler}">${task}</b>`;
        } else {
            tdTask.innerHTML = `<b>${task}</b>`;
        }
        tr.appendChild(tdTask);
        DAY_LABELS.forEach(() => {
            const td = document.createElement('td');
            const checkbox = document.createElement('input');
            checkbox.type = "checkbox";
            td.appendChild(checkbox);
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
}

// ---- Clear / progress chart ----------------------------------------------------
function confirmAndClearCheckboxes() {
    if (viewingReadOnly) return;
    const confirmed = window.confirm("هل أنت متأكد أنك تريد إزالة كل المربعات لهذا الأسبوع؟");
    if (confirmed) {
        clearCheckboxes();
    }
}

async function clearCheckboxes() {
    if (!currentWeekKey || viewingReadOnly) return;

    const checkboxes = document.querySelectorAll('.table-container input[type="checkbox"]');
    checkboxes.forEach(cb => cb.checked = false);
    await saveWeekField('matrix', []);

    if (chart) {
        chart.destroy();
        chart = null;
        document.querySelector('.chart-container').style.display = "none";
    }
}

// Firestore does NOT allow an array inside an array, so saving the table as [[1,0,...],[...]]
// failed on every tick ("Nested arrays are not supported"). Each row is saved as one short
// string instead, e.g. ["1010011", "0000000", ...]  (1 = checked, columns in Fri..Thu order).
function matrixToFirestore(matrix) {
    return matrix.map(row => row.join(''));
}

function isSavedChecked(savedMatrix, rowIndex, colIndex) {
    const row = savedMatrix[rowIndex];
    if (row == null) return false;
    return row[colIndex] === '1' || row[colIndex] === 1;   // new string rows, or old numeric rows
}

function getMatrixData() {
    const rows = document.querySelectorAll(".table-container table tr:not(:first-child)");
    const matrix = [];
    rows.forEach(row => {
        const checkboxes = row.querySelectorAll("input[type='checkbox']");
        const rowData = [];
        checkboxes.forEach(cb => rowData.push(cb.checked ? 1 : 0));
        matrix.push(rowData);
    });
    return matrix;
}

const separatorPlugin = {
    id: 'separatorPlugin',
    afterDraw(chart) {
        const { ctx, chartArea, scales } = chart;
        const xScale = scales.x;
        if (!xScale) return;

        const totalTicks = xScale.ticks.length;
        ctx.save();
        ctx.strokeStyle = "#795757";
        ctx.lineWidth = 2;

        for (let i = 0; i < totalTicks - 1; i++) {
            const current = xScale.getPixelForTick(i);
            const next = xScale.getPixelForTick(i + 1);
            const xPos = (current + next) / 2;

            ctx.beginPath();
            ctx.moveTo(xPos, chartArea.top);
            ctx.lineTo(xPos, chartArea.bottom);
            ctx.stroke();
        }
        ctx.restore();
    }
};

const chartBorderPlugin = {
    id: 'chartBorderPlugin',
    afterDraw(chart) {
        const { ctx, chartArea } = chart;
        ctx.save();
        ctx.strokeStyle = "#795757";
        ctx.lineWidth = 3;
        ctx.strokeRect(
            chartArea.left,
            chartArea.top,
            chartArea.right - chartArea.left,
            chartArea.bottom - chartArea.top
        );
        ctx.restore();
    }
};

function showChart() {
    if (typeof Chart === 'undefined') {
        console.error('Chart.js لم يتم تحميله - لا يمكن عرض الرسم البياني.');
        const container = document.querySelector('.chart-container');
        container.innerHTML = '<p style="color:#795757; text-align:center; padding:20px;">تعذر تحميل الرسم البياني. حاول تحديث الصفحة.</p>';
        return;
    }

    const matrix = getMatrixData();
    const taskLabels = Array.from(
        document.querySelectorAll(".table-container table tr:not(:first-child) td:first-child")
    ).map(td => td.innerText.trim());

    const dayLabels = DAY_LABELS;

    let canvas = document.getElementById('progressChart');
    if (!canvas) {
        const container = document.querySelector('.chart-container');
        container.innerHTML = '';
        canvas = document.createElement('canvas');
        canvas.id = 'progressChart';
        container.appendChild(canvas);
    }
    const ctx = canvas.getContext('2d');

    if (chart) chart.destroy();

    chart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: taskLabels,
            datasets: dayLabels.map((day, dayIndex) => ({
                label: day,
                data: matrix.map(task => task[dayIndex]),
                borderRadius: 8,
                barThickness: window.innerWidth < 768 ? 8 : 18,
            }))
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            layout: { padding: 20 },
            plugins: {
                title: {
                    display: true,
                    text: ["Weekly Progress", currentWeekLabel || ""],
                    color: "#795757",
                    font: {
                        size: window.innerWidth < 768 ? 16 : 24,
                        weight: 'bold'
                    },
                    padding: { top: 10, bottom: 30 }
                },
                legend: {
                    position: 'top',
                    labels: {
                        font: { size: window.innerWidth < 768 ? 10 : 16 },
                        padding: window.innerWidth < 768 ? 8 : 20
                    }
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { font: { size: window.innerWidth < 768 ? 12 : 18 } }
                },
                y: { beginAtZero: true, max: 1, ticks: { stepSize: 1 } }
            }
        },
        plugins: [separatorPlugin, chartBorderPlugin]
    });
}

// ---- Modal helpers ----------------------------------------------------------
function openModal(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'flex';
}

function closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
}

// ---- Bible reading notes (per week, one entry per day) ----
async function openBibleNotes() {
    if (!currentWeekKey || !viewingUid) return;

    document.getElementById('bible-modal-week-label').innerText = currentWeekLabel;

    const body = document.getElementById('bible-notes-body');
    body.innerHTML = "";

    const savedDoc = await loadWeekDoc(viewingUid, currentWeekKey);
    const saved = savedDoc.bibleNotes || {};

    DAY_LABELS_AR.forEach((dayAr, i) => {
        const wrapper = document.createElement('div');
        wrapper.className = 'bible-day-row';

        const label = document.createElement('label');
        label.className = 'modal-field-label';
        label.innerText = dayAr;
        label.setAttribute('for', `bible-note-${i}`);

        const textarea = document.createElement('textarea');
        textarea.id = `bible-note-${i}`;
        textarea.className = 'modal-textarea modal-textarea-small';
        textarea.placeholder = `ملاحظاتك عن قراءة يوم ${dayAr}...`;
        textarea.value = saved[dayAr] || "";
        textarea.disabled = viewingReadOnly;

        wrapper.appendChild(label);
        wrapper.appendChild(textarea);
        body.appendChild(wrapper);
    });

    document.getElementById('bible-modal-save-btn').style.display = viewingReadOnly ? 'none' : '';
    openModal('bible-modal');
}

async function saveBibleNotes() {
    if (!currentWeekKey || viewingReadOnly) return;

    const data = {};
    DAY_LABELS_AR.forEach((dayAr, i) => {
        const textarea = document.getElementById(`bible-note-${i}`);
        if (textarea) data[dayAr] = textarea.value;
    });

    await saveWeekField('bibleNotes', data);
    closeModal('bible-modal');
}

// ---- Other spiritual practice notes (per week, one entry per day) ----
async function openOtherPracticeNotes() {
    if (!currentWeekKey || !viewingUid) return;

    document.getElementById('other-practice-modal-week-label').innerText = currentWeekLabel;

    const body = document.getElementById('other-practice-notes-body');
    body.innerHTML = "";

    const savedDoc = await loadWeekDoc(viewingUid, currentWeekKey);
    const saved = savedDoc.otherPracticeNotes || {};

    DAY_LABELS_AR.forEach((dayAr, i) => {
        const wrapper = document.createElement('div');
        wrapper.className = 'bible-day-row';

        const label = document.createElement('label');
        label.className = 'modal-field-label';
        label.innerText = dayAr;
        label.setAttribute('for', `other-practice-note-${i}`);

        const textarea = document.createElement('textarea');
        textarea.id = `other-practice-note-${i}`;
        textarea.className = 'modal-textarea modal-textarea-small';
        textarea.placeholder = `اكتب الممارسة الروحية التي مارستها يوم ${dayAr}...`;
        textarea.value = saved[dayAr] || "";
        textarea.disabled = viewingReadOnly;

        wrapper.appendChild(label);
        wrapper.appendChild(textarea);
        body.appendChild(wrapper);
    });

    document.getElementById('other-practice-modal-save-btn').style.display = viewingReadOnly ? 'none' : '';
    openModal('other-practice-modal');
}

async function saveOtherPracticeNotes() {
    if (!currentWeekKey || viewingReadOnly) return;

    const data = {};
    DAY_LABELS_AR.forEach((dayAr, i) => {
        const textarea = document.getElementById(`other-practice-note-${i}`);
        if (textarea) data[dayAr] = textarea.value;
    });

    await saveWeekField('otherPracticeNotes', data);
    closeModal('other-practice-modal');
}

// ---- Confession record (ONE record per user, not tied to a specific week) ----
async function openConfessionModal() {
    if (!viewingUid) return;

    const saved = await loadConfession(viewingUid);
    document.getElementById('confession-father-name').value = saved.fatherName || "";
    document.getElementById('confession-last-date').value = saved.lastDate || "";
    document.getElementById('confession-notes').value = saved.notes || "";

    ['confession-father-name', 'confession-last-date', 'confession-notes'].forEach(id => {
        document.getElementById(id).disabled = viewingReadOnly;
    });
    document.getElementById('confession-modal-save-btn').style.display = viewingReadOnly ? 'none' : '';

    openModal('confession-modal');
}

async function saveConfessionRecord() {
    if (viewingReadOnly) return;

    const data = {
        fatherName: document.getElementById('confession-father-name').value,
        lastDate: document.getElementById('confession-last-date').value,
        notes: document.getElementById('confession-notes').value
    };
    await saveConfessionDoc(data);
    closeModal('confession-modal');
}

// ---- Calendar -------------------------------------------------------------------
function generateWeeks() {
    const container = document.querySelector('.weeks-container');
    container.innerHTML = "";

    const yearNav = document.createElement('div');
    yearNav.style.display = 'flex';
    yearNav.style.flexDirection = 'column';
    yearNav.style.alignItems = 'center';
    yearNav.style.marginBottom = '12px';

    const controlsRow = document.createElement('div');
    controlsRow.style.display = 'flex';
    controlsRow.style.alignItems = 'center';
    controlsRow.style.gap = '8px';
    controlsRow.style.marginBottom = '4px';

    const prevBtn = document.createElement('button');
    prevBtn.innerText = '◀';
    styleNavBtn(prevBtn);
    prevBtn.addEventListener('click', () => { calendarYear--; generateWeeks(); });

    const nextBtn = document.createElement('button');
    nextBtn.innerText = '▶';
    styleNavBtn(nextBtn);
    nextBtn.addEventListener('click', () => { calendarYear++; generateWeeks(); });

    const todayBtn = document.createElement('button');
    todayBtn.innerText = 'Today';
    styleNavBtn(todayBtn);
    todayBtn.style.fontSize = '12px';
    todayBtn.addEventListener('click', () => {
        const week = getCurrentWeek();
        bindTableToWeek(week);
        // Close the calendar and bring the tracker table into view
        document.querySelector('.calendar-container').style.display = 'none';
        calendarYear = weekOwnerMonth(week).year;
        const tc = document.querySelector('.table-container');
        if (tc) tc.scrollIntoView({ behavior: 'smooth' });
    });

    controlsRow.appendChild(prevBtn);
    controlsRow.appendChild(nextBtn);
    controlsRow.appendChild(todayBtn);

    const yearLabel = document.createElement('h3');
    yearLabel.innerText = calendarYear;
    yearLabel.style.color = '#795757';
    yearLabel.style.margin = '0';

    yearNav.appendChild(controlsRow);
    yearNav.appendChild(yearLabel);
    container.appendChild(yearNav);

    const weeks = getWeeksForYear(calendarYear);
    const monthsMap = {};
    weeks.forEach(week => {
        const owner = weekOwnerMonth(week);
        if (owner.year !== calendarYear) return;
        if (!monthsMap[owner.month]) monthsMap[owner.month] = [];
        monthsMap[owner.month].push(week);
    });

    const monthIndexes = Object.keys(monthsMap).map(Number).sort((a, b) => a - b);

    for (let rowIndex = 0; rowIndex < Math.ceil(monthIndexes.length / 3); rowIndex++) {
        const rowDiv = document.createElement('div');
        rowDiv.style.display = "flex";
        rowDiv.style.justifyContent = "space-between";
        rowDiv.style.gap = "12px";

        for (let colIndex = 0; colIndex < 3; colIndex++) {
            const idx = rowIndex * 3 + colIndex;
            if (idx >= monthIndexes.length) break;
            const monthIndex = monthIndexes[idx];

            const monthDiv = document.createElement('div');
            monthDiv.style.background = "#FFEBC2";
            monthDiv.style.borderRadius = "12px";
            monthDiv.style.padding = "8px";
            monthDiv.style.margin = "8px";
            monthDiv.style.flex = "1";
            monthDiv.style.minWidth = "120px";
            monthDiv.style.display = "flex";
            monthDiv.style.flexDirection = "column";
            monthDiv.style.alignItems = "center";

            const title = document.createElement('h4');
            title.innerText = MONTH_NAMES[monthIndex];
            title.style.textAlign = "center";
            title.style.marginBottom = "6px";
            title.style.color = "#795757";
            monthDiv.appendChild(title);

            const ul = document.createElement('ul');
            ul.style.listStyle = "none";
            ul.style.padding = "0";
            ul.style.margin = "0";
            ul.style.fontSize = "14px";
            ul.style.color = "#795757";
            ul.style.textAlign = "center";
            ul.style.width = "100%";

            monthsMap[monthIndex].forEach(week => {
                const li = document.createElement('li');
                li.innerText = formatWeekLabel(week);
                li.style.marginBottom = "4px";
                li.style.cursor = "pointer";
                li.style.padding = "3px 6px";
                li.style.borderRadius = "6px";

                if (currentWeekKey === weekKey(week)) {
                    li.style.background = "#795757";
                    li.style.color = "#FFF0D1";
                    li.style.fontWeight = "bold";
                }

                li.addEventListener('click', () => {
                    bindTableToWeek(week);
                    document.querySelector('.calendar-container').style.display = 'none';
                });

                ul.appendChild(li);
            });

            monthDiv.appendChild(ul);
            rowDiv.appendChild(monthDiv);
        }

        container.appendChild(rowDiv);
    }
}

function styleNavBtn(btn) {
    btn.style.background = '#795757';
    btn.style.color = '#FFF0D1';
    btn.style.border = 'none';
    btn.style.borderRadius = '8px';
    btn.style.padding = '4px 12px';
    btn.style.cursor = 'pointer';
    btn.style.fontWeight = 'bold';
}
