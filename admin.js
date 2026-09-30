// ============================================================================
// لوحة الخادم: عرض قائمة المخدومين، وفتح بيانات أي منهم للقراءة فقط
// (الخادم يرى المخدومين فقط، ولا يرى بيانات الخدام الآخرين)
// ============================================================================

async function openAdminDashboard() {
    if (!currentUserProfile || currentUserProfile.role !== 'khadem') return;

    document.getElementById('admin-header-title').innerText = 'بيانات المخدومين';
    const body = document.getElementById('admin-body');
    body.innerHTML = '<p style="color:#795757; text-align:center;">جارِ التحميل...</p>';
    openModal('admin-modal');

    try {
        // لازم الفلتر هنا، لأن قواعد Firestore بتسمح للخادم يقرأ المخدومين بس
        const snap = await db.collection('users').where('role', '==', 'makhdoum').get();
        const list = [];
        snap.forEach(doc => {
            if (doc.id === currentUser.uid) return; // لا داعي لعرض الشخص نفسه
            list.push({ uid: doc.id, ...doc.data() });
        });

        if (list.length === 0) {
            body.innerHTML = '<p style="color:#795757; text-align:center;">لا يوجد مخدومين مسجلين بعد.</p>';
            return;
        }

        list.sort((a, b) => (a.name || a.email || '').localeCompare(b.name || b.email || '', 'ar'));

        body.innerHTML = '';
        const wrap = document.createElement('div');
        wrap.style.display = 'flex';
        wrap.style.flexDirection = 'column';
        wrap.style.gap = '10px';

        list.forEach(person => {
            const btn = document.createElement('button');
            btn.className = 'admin-person-btn';
            btn.innerText = person.name || person.email || 'بدون اسم';
            btn.addEventListener('click', () => viewMakhdoumData(person));
            wrap.appendChild(btn);
        });

        body.appendChild(wrap);
    } catch (err) {
        console.error(err);
        body.innerHTML = '<p style="color:#795757; text-align:center;">تعذر تحميل القائمة. تأكد من صلاحياتك في قواعد Firestore وحاول مرة أخرى.</p>';
    }
}

function closeAdminDashboard() {
    closeModal('admin-modal');
    returnToOwnData();
}

function returnToOwnData() {
    if (!viewingReadOnly) return;
    viewingUid = currentUser.uid;
    viewingReadOnly = false;
    document.getElementById('viewing-banner').style.display = 'none';
    document.querySelector('.refresh').style.visibility = 'visible';
    bindTableToWeek(getCurrentWeek());
}

function viewMakhdoumData(person) {
    viewingUid = person.uid;
    viewingReadOnly = true;

    // Banner across the main tracker so it's always clear whose data this is
    const banner = document.getElementById('viewing-banner');
    document.getElementById('viewing-banner-text').innerText =
        `تعرض الآن بيانات: ${person.name || person.email} (للقراءة فقط)`;
    banner.style.display = 'flex';

    // Hide the destructive "تصفير" button while viewing someone else's data
    document.querySelector('.refresh').style.visibility = 'hidden';

    closeModal('admin-modal');
    bindTableToWeek(getCurrentWeek());

    document.querySelector('.table-container').scrollIntoView({ behavior: 'smooth' });
}
