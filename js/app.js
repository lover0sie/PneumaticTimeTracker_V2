/* ============================================================================
  Pneumatic Test Timer - app.js

  Important limitations on mobile:
  - When Safari/Chrome is backgrounded or screen turns off, timers are throttled.
  - Solve the display issue by using "epoch timing":
      elapsedSec = (Date.now() - startEpoch) / 1000
    So even if setInterval pauses, the correct time will show when the page returns.
============================================================================ */

/* ============================================================================
  1) Firebase imports (ES modules)
============================================================================ */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
import {
  getFirestore,
  doc,
  setDoc,
  updateDoc,
  addDoc,
  collection,
  serverTimestamp,
  query,
  where,
  orderBy,
  limit,
  getDocs
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

/* ============================================================================
  2) Firebase config and DB init
============================================================================ */
const firebaseConfig = {
  apiKey: "AIzaSyDnYqCLkMfk3WrUZWqT6HM72hxKdsu7y_A",
  authDomain: "pneumatictracking.firebaseapp.com",
  projectId: "pneumatictracking",
  storageBucket: "pneumatictracking.firebasestorage.app",
  messagingSenderId: "392460221400",
  appId: "1:392460221400:web:605da9e55bebd7200210ad"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

/* ============================================================================
  3) Helpers: DOM, status messages, formatting
============================================================================ */
const el = (id) => document.getElementById(id);

function setStatus(node, msg, kind = "ok") {
  node.className = "status " + (kind === "error" ? "error" : "ok");
  node.textContent = msg;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatHHMMSS(totalSec) {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}


/* ============================================================================
3) Manpower
============================================================================*/

function getManpowerValue() {
  const raw = document.getElementById("manpower")?.value ?? "";
  const n = Number(raw);

  // allow empty = null (or force required by returning error)
  if (raw === "") return null;

  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new Error("Manpower must be a whole number (1, 2, 3, ...)");
  }
  return n;
}


/* ============================================================================
  4) UI: steps/pages switching

  Still keep all pages in one HTML, and show/hide using CSS:
  - .page.active = visible
============================================================================ */
function setStep(stepIndex) {
  const s1 = el("step1"), s2 = el("step2"), s3 = el("step3");
  [s1, s2, s3].forEach(s => (s.className = "step"));

  if (stepIndex === 1) s1.classList.add("current");
  if (stepIndex === 2) { s1.classList.add("done"); s2.classList.add("current"); }
  if (stepIndex === 3) { s1.classList.add("done"); s2.classList.add("done"); s3.classList.add("current"); }

  ["page1", "page2", "page3"].forEach(pid => el(pid).classList.remove("active"));
  el(`page${stepIndex}`).classList.add("active");
}

/* ============================================================================
  5) LocalStorage keys

  Use localStorage:
  - if the page refreshes accidentally, progress restored
  - timer can recalc elapsed time from stored startEpoch
============================================================================ */
const LS = {
  running: "ptt_running",
  startISO: "ptt_startISO",
  startEpoch: "ptt_startEpoch",
  serial: "ptt_serial",
  segmentId: "ptt_segmentId",
  projectData: "ptt_projectData",
  employeeData: "ptt_employeeData",
  confirmedProject: "ptt_confirmedProject",
  confirmedEmployee: "ptt_confirmedEmployee",
  manpower: "ptt_manpower"
};

function clearAllState() {
  Object.values(LS).forEach(k => localStorage.removeItem(k));
}

/* ============================================================================
  6) State in memory (current session)
============================================================================ */
let projectData = { version:"", projectName:"", serial:"", type:"" };
let employeeData = { version:"", empId:"", empName:"", station:"", manpower: null };
let projectConfirmed = false;
let employeeConfirmed = false;

let isRunning = false;

/* Segment state (Firestore segment document id) */
let currentTestSegmentId = null;
let startTestingISO = null;

/* Timer state (epoch timing) */
let timerInterval = null;
let startEpoch = 0;      // Date.now() when the timer started
let elapsedSec = 0;      // display value (derived from startEpoch)

/* ============================================================================
  7) Simple loading overlay + timeout wrapper

  Fix:
  - wrap Firestore calls with a timeout (set as 12 seconds)
  - if timeout happens, show error and unlock UI
============================================================================ */
function showLoading(text = "Submitting…") {
  el("loadingText").textContent = text;
  el("loadingOverlay").classList.add("show");
}

function hideLoading() {
  el("loadingOverlay").classList.remove("show");
}

function withTimeout(promise, ms = 12000) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("Network timeout. Please try again.")), ms))
  ]);
}

/* ============================================================================
  8) Timer logic (epoch-based)

  Problem:
  - timer stops when browser minimized/screen off

  Result:
  - even if interval pauses, when the page becomes active again
    the displayed timer will jump to the correct value
============================================================================ */
function renderTimer() {
  el("timerText").textContent = formatHHMMSS(elapsedSec);
}

function renderFromEpoch() {
  if (!startEpoch) return;
  elapsedSec = Math.max(0, Math.floor((Date.now() - startEpoch) / 1000));
  renderTimer();
}

function startTimerEpoch() {
  clearInterval(timerInterval);

  // Update UI frequently for smooth display.
  // This does NOT determine the elapsed time, Date.now() does.
  timerInterval = setInterval(renderFromEpoch, 250);
}

function stopTimerEpoch() {
  clearInterval(timerInterval);
  timerInterval = null;
}

/* ============================================================================
  9) Button enable/disable rules
============================================================================ */
function canEnableTimerActions() {
  const ready = projectConfirmed && employeeConfirmed;

  el("btnStart").disabled = !ready || isRunning;
  el("btnPass").disabled  = !isRunning;
  el("btnLeak").disabled  = !isRunning;
}

function setButtonsDisabled(disabled) {
  el("btnStart").disabled = disabled;
  el("btnPass").disabled  = disabled;
  el("btnLeak").disabled  = disabled;
}

/* ============================================================================
  10) Parse QR text

  Vessel QR format:
    version;project_name;serial_number;type

  Employee QR format:
    EMP;employee_id;employee_name;station
============================================================================ */
function normalizeType(t) {
  const raw = String(t || "").trim().toUpperCase();
  const map = {
    "EVAPORATOR": "EVAPORATOR",
    "OIL SEPARATOR": "OIL SEPARATOR",
    "OIL_SEPARATOR": "OIL SEPARATOR",
    "OILSEPARATOR": "OIL SEPARATOR",
    "CONDENSER": "CONDENSER",
    "ECONOMIZER": "ECONOMIZER"
  };
  return map[raw] || null;
}

function parseProjectQR(text) {
  const parts = String(text).trim().split(";");
  if (parts.length < 4) return null;

  const version = parts[0].trim();
  const projectName = parts[1].trim();
  const serial = parts[2].trim();
  const type = normalizeType(parts[3]);

  if (!version || !projectName || !serial || !type) return null;
  return { version, projectName, serial, type };
}

function parseEmployeeQR(text) {
  const parts = String(text).trim().split(";");
  if (parts.length < 4) return null;

  const version = parts[0].trim().toUpperCase();
  const empId = parts[1].trim();
  const empName = parts[2].trim().replaceAll("_", " ");
  const station = parts[3].trim();

  if (version !== "EMP") return null;
  if (!empId || !empName || !station) return null;

  return { version, empId, empName, station };
}

/* ============================================================================
  11) UI paint functions (write data into HTML fields)
============================================================================ */
function paintProjectUI() {
  el("projNameText").textContent = projectData.projectName || "-";
  el("serialText").textContent = projectData.serial || "-";
  el("typeText").textContent = projectData.type || "-";
}

function paintEmployeeUI() {
  el("empIdText").textContent = employeeData.empId || "-";
  el("empNameText").textContent = employeeData.empName || "-";
  el("empStationText").textContent = employeeData.station || "-";
}

function paintPage3Header() {
  el("p3Serial").textContent = projectData.serial || "-";
  el("p3Project").textContent = projectData.projectName || "-";
  el("p3Type").textContent = projectData.type || "-";
  el("p3Emp").textContent = employeeData.empId ? `${employeeData.empName} (${employeeData.empId})` : "-";
  el("p3Station").textContent = employeeData.station || "-";
  el("p3Manpower").textContent = (employeeData.manpower ?? "-");
}

/* ============================================================================
  12) Persist wizard state (project + employee) to localStorage
============================================================================ */
function persistRunState() {
  localStorage.setItem(LS.running, isRunning ? "1" : "0");
  localStorage.setItem(LS.startISO, startTestingISO || "");
  localStorage.setItem(LS.startEpoch, startEpoch ? String(startEpoch) : "");
  localStorage.setItem(LS.serial, projectData.serial || "");
  localStorage.setItem(LS.segmentId, currentTestSegmentId || "");
}

function persistWizardState() {
  localStorage.setItem(LS.projectData, JSON.stringify(projectData));
  localStorage.setItem(LS.employeeData, JSON.stringify(employeeData));
  localStorage.setItem(LS.confirmedProject, projectConfirmed ? "1" : "0");
  localStorage.setItem(LS.confirmedEmployee, employeeConfirmed ? "1" : "0");
  //Added manpower as local storage
  localStorage.setItem(LS.manpower, employeeData.manpower == null ? "" : String(employeeData.manpower)); 
}


/* ============================================================================
  13) Firestore helpers
============================================================================ */
function segmentsColRef(serial) {
  return collection(db, "serial_timelines", serial, "segments");
}

function segmentDocRef(serial, segmentId) {
  return doc(db, "serial_timelines", serial, "segments", segmentId);
}

function diffSeconds(isoStart, isoEnd) {
  const a = new Date(isoStart).getTime();
  const b = new Date(isoEnd).getTime();
  return Math.max(0, Math.round((b - a) / 1000));
}


/* Upsert header document for each serial (project_name, vessel_type, etc.) */
async function upsertSerialHeader(serial, projectName, vesselType) {
  const ref = doc(db, "serial_timelines", serial);
  await setDoc(ref, {
    serial_number: serial,
    project_name: projectName,
    vessel_type: vesselType,
    lastUpdatedAt: serverTimestamp()
  }, { merge: true });
}

/* Close a previously-open LEAK segment if it exists */
async function closeOpenLeakIfAny(serial, newStartTestingISO) {
  const col = segmentsColRef(serial);
  const q = query(
    col,
    where("segment_type", "==", "LEAK"),
    where("end_time", "==", null),
    orderBy("start_time", "desc"),
    limit(1)
  );

  const snap = await getDocs(q);
  if (snap.empty) return;

  const leakDoc = snap.docs[0];
  const leakData = leakDoc.data();
  const endISO = newStartTestingISO;
  const dur = diffSeconds(leakData.start_time, endISO);

  await updateDoc(leakDoc.ref, {
    end_time: endISO,
    duration_sec: dur,
    lastUpdatedAt: serverTimestamp()
  });
}

/* Create a TEST segment (start_time now, end_time null) */
async function createTestSegmentStart() {
  startTestingISO = new Date().toISOString();

  // If leak was open, close it at this startTestingISO
  await closeOpenLeakIfAny(projectData.serial, startTestingISO);

  const col = segmentsColRef(projectData.serial);

    const seg = await addDoc(col, {
    segment_type: "TEST",
    start_time: startTestingISO,
    end_time: null,
    duration_sec: null,
    status: "running",

    project_version: projectData.version,
    project_name: projectData.projectName,
    serial_number: projectData.serial,
    vessel_type: projectData.type,

    employee_version: employeeData.version,
    employee_id: employeeData.empId,
    employee_name: employeeData.empName,
    station: employeeData.station,

    manpower: employeeData.manpower ?? null, // add manpower

    remark: null,

    createdAt: serverTimestamp(),
    lastUpdatedAt: serverTimestamp()
  });

  await upsertSerialHeader(projectData.serial, projectData.projectName, projectData.type);

  currentTestSegmentId = seg.id;

  el("segmentIdText").textContent = currentTestSegmentId;
  el("startTsText").textContent = startTestingISO;
  el("stopTsText").textContent = "-";
}

/* Finish TEST as PASS */
async function finalizeTestAsPass(remark) {
  const endISO = new Date().toISOString();
  const dur = diffSeconds(startTestingISO, endISO);
  const ref = segmentDocRef(projectData.serial, currentTestSegmentId);

  await updateDoc(ref, {
    end_time: endISO,
    duration_sec: dur,
    status: "passed",
    remark: remark ? remark : null,
    lastUpdatedAt: serverTimestamp()
  });

  el("stopTsText").textContent = endISO;
}

/* Leak modal: ask reason + (optional) remark */
async function openLeakDialog() {
  return new Promise((resolve) => {
    const modal = el("leakModal");
    const reasonEl = el("leakReason");
    const remarkEl = el("leakRemark");
    const remarkLabel = el("remarkLabel");
    const statusEl = el("leakModalStatus");

    reasonEl.value = "";
    remarkEl.value = "";
    remarkEl.style.display = "none";
    remarkLabel.style.display = "none";
    statusEl.textContent = "";
    statusEl.className = "status";

    modal.style.display = "block";

    const cleanup = () => {
      modal.style.display = "none";
      el("btnLeakCancel").onclick = null;
      el("btnLeakConfirm").onclick = null;
    };

    el("btnLeakCancel").onclick = () => {
      cleanup();
      resolve(null);
    };

    el("btnLeakConfirm").onclick = () => {
      const reason = reasonEl.value.trim();
      const remark = remarkEl.value.trim();

      if (!reason) {
        statusEl.className = "status error";
        statusEl.textContent = "Please select a leak reason.";
        return;
      }
      if (reason === "Others" && !remark) {
        statusEl.className = "status error";
        statusEl.textContent = "Remark is required when reason is 'Others'.";
        return;
      }

      cleanup();
      resolve({ reason, remark: remark || null });
    };
  });
}

/* Finish TEST as LEAK and open a LEAK segment (end_time stays null) */
async function finalizeTestAsLeakAndOpenLeakSegment() {
  const leakStartISO = new Date().toISOString();
  const durTesting = diffSeconds(startTestingISO, leakStartISO);

  const leakInfo = await openLeakDialog();
  if (!leakInfo) return false;

  // Close TEST segment as leak
  const testRef = segmentDocRef(projectData.serial, currentTestSegmentId);
  await updateDoc(testRef, {
    end_time: leakStartISO,
    duration_sec: durTesting,
    status: "leak",
    remark: leakInfo.remark,
    leak_reason: leakInfo.reason,
    lastUpdatedAt: serverTimestamp()
  });

  // Open LEAK segment (will be closed automatically on next TEST start)
  const col = segmentsColRef(projectData.serial);
  await addDoc(col, {
    segment_type: "LEAK",
    start_time: leakStartISO,
    end_time: null,
    duration_sec: null,

    reason: leakInfo.reason,
    remark: leakInfo.remark,

    project_name: projectData.projectName,
    serial_number: projectData.serial,
    vessel_type: projectData.type,

    employee_id: employeeData.empId,
    employee_name: employeeData.empName,
    station: employeeData.station,

    createdAt: serverTimestamp(),
    lastUpdatedAt: serverTimestamp()
  });

  el("stopTsText").textContent = leakStartISO;
  return true;
}

/* ============================================================================
  14) QR scanners (Html5Qrcode)
============================================================================ */
const projectScanner = new Html5Qrcode("projectReader");
const employeeScanner = new Html5Qrcode("employeeReader");

let projectScanning = false;
let empScanning = false;

// QR scanner for Project
async function toggleProjectScan() {
  const btn = el("btnProjectScanToggle");

  if (projectScanning) {
    try { await projectScanner.stop(); } catch {}
    projectScanning = false;

    btn.textContent = "Start Scan";
    btn.classList.remove("btn-stop");
    btn.classList.add("btn-secondary");
    setStatus(el("projectScanStatus"), "Scan stopped.", "ok");
    return;
  }

  try {
    setStatus(el("projectScanStatus"), "Starting camera...", "ok");
    btn.disabled = true;

    await projectScanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 250, height: 250 } },
      async (decodedText) => {
        const parsed = parseProjectQR(decodedText);
        if (!parsed) {
          setStatus(el("projectScanStatus"), "Invalid Vessel QR.", "error");
          return;
        }

        projectData = parsed;
        projectConfirmed = false;

        paintProjectUI();
        setStatus(el("projectScanStatus"), "Vessel QR parsed. Press OK.", "ok");
        el("btnOkProject").disabled = false;

        await projectScanner.stop();
        projectScanning = false;

        btn.textContent = "Start Scan";
        btn.classList.remove("btn-stop");
        btn.classList.add("btn-secondary");
      }
    );

    projectScanning = true;
    btn.textContent = "Stop Scan";
    btn.classList.remove("btn-secondary");
    btn.classList.add("btn-stop");
  } catch (e) {
    console.error(e);
    setStatus(el("projectScanStatus"), "Camera start failed.", "error");
    projectScanning = false;

    btn.textContent = "Start Scan";
    btn.classList.remove("btn-stop");
    btn.classList.add("btn-secondary");
  } finally {
    btn.disabled = false;
  }
}

// QR Scanner for Employee
async function toggleEmpScan() {
  const btn = el("btnEmpScanToggle");

  if (empScanning) {
    try { await employeeScanner.stop(); } catch {}
    empScanning = false;

    btn.textContent = "Start Scan";
    btn.classList.remove("btn-stop");
    btn.classList.add("btn-secondary");
    setStatus(el("empScanStatus"), "Scan stopped.", "ok");
    return;
  }

  try {
    setStatus(el("empScanStatus"), "Starting camera...", "ok");
    btn.disabled = true;

    await employeeScanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 250, height: 250 } },
      async (decodedText) => {
        const parsed = parseEmployeeQR(decodedText);
        if (!parsed) {
          setStatus(el("empScanStatus"), "Invalid Employee QR.", "error");
          return;
        }

        employeeData = parsed;
        employeeConfirmed = false;

        paintEmployeeUI();
        setStatus(el("empScanStatus"), "Employee QR parsed. Press OK.", "ok");
        el("btnOkEmployee").disabled = false;

        await employeeScanner.stop();
        empScanning = false;

        btn.textContent = "Start Scan";
        btn.classList.remove("btn-stop");
        btn.classList.add("btn-secondary");
      }
    );

    empScanning = true;
    btn.textContent = "Stop Scan";
    btn.classList.remove("btn-secondary");
    btn.classList.add("btn-stop");
  } catch (e) {
    console.error(e);
    setStatus(el("empScanStatus"), "Camera start failed.", "error");
    empScanning = false;

    btn.textContent = "Start Scan";
    btn.classList.remove("btn-stop");
    btn.classList.add("btn-secondary");
  } finally {
    btn.disabled = false;
  }
}

/* Leak modal UI rule: show remark box only when reason is "others" */
el("leakReason").addEventListener("change", () => {
  const show = el("leakReason").value === "Others";
  el("leakRemark").style.display = show ? "block" : "none";
  el("remarkLabel").style.display = show ? "block" : "none";
  if (!show) el("leakRemark").value = "";
});

/* ============================================================================
  15) Wizard buttons: OK project, OK employee
============================================================================ */
el("btnProjectScanToggle").addEventListener("click", toggleProjectScan);
el("btnEmpScanToggle").addEventListener("click", toggleEmpScan);

// Step 1 (Employee) -> Step 2 (Vessel)
el("btnOkEmployee").addEventListener("click", () => {
  //  validate manpower here
  let manpower = null;
  try {
    manpower = getManpowerValue();
  } catch (err) {
    alert(err.message);
    return;
  }

  if (manpower == null) {
    alert("Please enter manpower before pressing OK.");
    return;
  }

  employeeData.manpower = manpower;

  employeeConfirmed = true;
  el("btnOkEmployee").disabled = true;

  persistWizardState();
  setStep(2);

  setStatus(el("projectScanStatus"), "Ready to scan vessel QR code.", "ok");
});

// Step 2 (Vessel) -> Step 3 (Timer)
el("btnOkProject").addEventListener("click", () => {
  projectConfirmed = true;
  el("btnOkProject").disabled = true;

  persistWizardState();
  setStep(3);

  paintPage3Header();
  setStatus(el("actionStatus"), "Ready. Press Start to begin.", "ok");
  canEnableTimerActions();
  el("btnStart").disabled = false;
});


/* ============================================================================
  16) Timer buttons: Start, Pass, Leak
============================================================================ */
el("btnStart").addEventListener("click", async () => {
  if (!(projectConfirmed && employeeConfirmed)) return;
  if (isRunning) return;

  // Lock state first
  isRunning = true;
  localStorage.setItem(LS.running, "1");
  el("btnStart").disabled = true;
  canEnableTimerActions();

  // Start timer immediately (UI)
  startEpoch = Date.now();
  localStorage.setItem(LS.startEpoch, String(startEpoch));
  persistWizardState();
  elapsedSec = 0;
  renderTimer();
  startTimerEpoch();

  try {
    // Create TEST segment in Firestore
    await withTimeout(createTestSegmentStart(), 12000);

    // Save run state so refresh can restore
    persistWizardState();
    persistRunState();

    setStatus(el("actionStatus"), "Testing started.", "ok");
  } catch (e) {
    console.error(e);

    // Rollback timer if Firestore fails
    stopTimerEpoch();
    startEpoch = 0;
    localStorage.setItem(LS.startEpoch, "");

    isRunning = false;
    canEnableTimerActions();
    el("btnStart").disabled = false;

    setStatus(el("actionStatus"), `Start failed: ${e?.message || e}`, "error");
  }
});

el("btnPass").addEventListener("click", async () => {
  if (!isRunning || !currentTestSegmentId) return;

  // Stop UI timer while prompting
  isRunning = false;
  stopTimerEpoch();
  canEnableTimerActions();

  const remarkInput = prompt("Optional remark:", "");
  if (remarkInput === null) {
    // User cancelled pass, resume timer
    isRunning = true;
    startTimerEpoch();
    canEnableTimerActions();
    setStatus(el("actionStatus"), "PASS cancelled. Returned to stopwatch.", "ok");
    return;
  }

  setButtonsDisabled(true);
  showLoading("Submitting PASS…");

  try {
    const remark = remarkInput.trim();
    await withTimeout(finalizeTestAsPass(remark), 12000);

    clearAllState();
    location.reload(); // do NOT hideLoading() before reload
  } catch (e) {
    console.error(e);
    hideLoading();
    setButtonsDisabled(false);

    isRunning = true;
    startTimerEpoch();
    canEnableTimerActions();

    setStatus(el("actionStatus"), `PASS failed: ${e?.message || e}`, "error");
  }

});

el("btnLeak").addEventListener("click", async () => {
  if (!isRunning || !currentTestSegmentId) return;

  // Stop UI timer while filling leak details
  isRunning = false;
  stopTimerEpoch();
  canEnableTimerActions();

  const ok = await finalizeTestAsLeakAndOpenLeakSegment();
  if (!ok) {
    // User cancelled leak, resume timer
    isRunning = true;
    startTimerEpoch();
    canEnableTimerActions();
    setStatus(el("actionStatus"), "LEAK cancelled. Returned to stopwatch.", "ok");
    return;
  }

  // At this point Firestore writes already happened in finalizeTestAsLeakAndOpenLeakSegment
  setButtonsDisabled(true);
  showLoading("Submitting LEAK…");

try {
    // Firestore writes already happened inside finalizeTestAsLeakAndOpenLeakSegment()
    // Keep overlay visible and reload immediately.
    clearAllState();
    location.reload();
} catch (e) {
    hideLoading();
    setButtonsDisabled(false);
    setStatus(el("actionStatus"), `LEAK failed: ${e?.message || e}`, "error");
}

});

/* ============================================================================
  17) Resume after refresh

  If user refreshes while timer is running, restore:
   - which page to show (timer page)
   - which segment ID is active
   - the correct elapsed time using startEpoch
============================================================================ */
function goToCorrectStepIfNotRunning(){
  if (!employeeConfirmed) {
    setStep(1);
    setStatus(el("empScanStatus"), "Ready to scan employee QR.", "ok");
    return;
  }

  if (!projectConfirmed) {
    setStep(2);
    setStatus(el("projectScanStatus"), "Ready to scan vessel QR code.", "ok");
    el("btnOkEmployee").disabled = true;
    return;
  }

  setStep(3);
  paintPage3Header();
  canEnableTimerActions();
  setStatus(el("actionStatus"), "Ready. Press Start to begin.", "ok");
}


function loadWizardStateFromStorage(){
  try {
    const p = localStorage.getItem(LS.projectData);
    const e = localStorage.getItem(LS.employeeData);
    if (p) projectData = JSON.parse(p);
    if (e) employeeData = JSON.parse(e);
  } catch (err) {
    console.warn("Failed to parse saved wizard state:", err);
  }

  //  restore manpower input UI
  if (el("manpower")) el("manpower").value = employeeData.manpower ?? "";

  projectConfirmed = localStorage.getItem(LS.confirmedProject) === "1";
  employeeConfirmed = localStorage.getItem(LS.confirmedEmployee) === "1";

  paintProjectUI();
  paintEmployeeUI();
}

function resumeIfRunning(){
  const running = localStorage.getItem(LS.running) === "1";
  if (!running) return false;

  // Restore IDs and timing
  const savedSerial = localStorage.getItem(LS.serial) || "";
  const savedSegId  = localStorage.getItem(LS.segmentId) || "";
  const savedStartISO = localStorage.getItem(LS.startISO) || "";
  const savedStartEpoch = parseInt(localStorage.getItem(LS.startEpoch) || "0", 10);

  // Basic validation
  if (!savedSerial || !savedSegId || !savedStartISO || !savedStartEpoch) {
    return false;
  }

  // Restore in-memory state
  currentTestSegmentId = savedSegId;
  startTestingISO = savedStartISO;
  startEpoch = savedStartEpoch;

  // Go to Timer page
  setStep(3);
  paintPage3Header();

  // Restore timer UI and start interval again
  isRunning = true;
  canEnableTimerActions();

  el("segmentIdText").textContent = currentTestSegmentId;
  el("startTsText").textContent = startTestingISO;
  el("stopTsText").textContent = "-";

  // Immediately render correct time based on Date.now() - startEpoch
  renderFromEpoch();
  startTimerEpoch();

  setStatus(el("actionStatus"), "Resumed running test after refresh.", "ok");
  return true;
}

function initApp() {
  // Load saved scanned info and confirmations
  loadWizardStateFromStorage();

  // 1) If a test is running, always resume and stay on Timer page
  if (resumeIfRunning()) {
    return;
  }

  // 2) Not running: continue normal flow based on what is already confirmed
  // Your new flow is: Employee -> Vessel -> Timer

  if (!employeeConfirmed) {
    setStep(1);
    paintEmployeeUI();
    paintProjectUI();
    el("btnOkEmployee").disabled = !employeeData.empId;
    setStatus(el("empScanStatus"), employeeData.empId ? "Parsed. Press OK to confirm." : "Ready to scan employee QR.", "ok");
    setStatus(el("projectScanStatus"), "Scan vessel QR after employee is confirmed.", "ok");
    return;
  }

  if (!projectConfirmed) {
    setStep(2);
    paintEmployeeUI();
    paintProjectUI();
    el("btnOkProject").disabled = !projectData.serial;
    setStatus(el("projectScanStatus"), projectData.serial ? "Parsed. Press OK to confirm." : "Ready to scan vessel QR.", "ok");
    return;
  }

  // Both confirmed but not running yet: show Timer page ready to start
  setStep(3);
  paintPage3Header();
  canEnableTimerActions();
  setStatus(el("actionStatus"), "Ready. Press Start to begin.", "ok");
}

initApp();
/* ============================================================================
  18) Keep timer display correct when app becomes active again

  This does not keep the timer running while the phone is locked.
  It only ensures that when the browser returns, the elapsed time is corrected.
============================================================================ */
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) renderFromEpoch();
});

window.addEventListener("focus", renderFromEpoch);
